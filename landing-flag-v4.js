/**
 * @Sub-Store-Page
 * 输出：订阅名|国旗|类型|原生/广播 国家序号
 * 例：订阅一|🇺🇸|数据中心|原生 US01
 *
 * 参数（#后，可不填）：
 *   concurrency=20    并发请求数（默认 20；受 rpm 限速约束，调大不增加封禁风险）
 *   rpm=40            ip-api.com 每分钟请求上限（免费版硬限制 45/min；0=不限速，易触发 429）
 *   timeout=9000      单次 HTTP 请求超时(ms)
 *   ttl=24            结果缓存有效期(小时)；节点按“服务器:端口”缓存，命中直接跳过全部网络请求
 *   sort=1            1=按国家排序分组编号（未知国家最后），0=保持原顺序仅编号
 *   mark_fail=0       1=失败也输出  订阅名|未知|未知|未知
 *   retries=2         单节点请求失败重试次数
 *   rir_rpm=30        RIPE(stat.ripe.net) 每分钟查询上限（0=不限速）
 *   key=xxx           保留参数，新版脚本以 ip-api.com 为主，可留空
 *
 * v4 改动（精简名称版）：
 *   - 节点名不再保留原节点名，多余信息全部去掉，改为：订阅名|国旗|类型|原生/广播 国家序号
 *   - 订阅名取自 Sub-Store 订阅配置里的命名（proxy.sub），同一订阅的节点共享该名前缀
 *   - 恢复原生/广播判断（RIPE rir 注册国，ipwho.is 降级时顺带复用其注册国字段）
 *   - 序号为国家代码+组内数字（US01、JP02…），按国家分组动态生成，不依赖缓存
 *   - 保留 v2/v3 全部性能优化：结果缓存、增量测试、限速器、失败降级重试
 */

const CACHE_KEY = "landing_flag_sub_tag_v5";

const ECHO_URL = "http://ip-api.com/json/?fields=status,message,query,countryCode,as,isp,org,hosting,mobile";
const IPWHO_URL = "https://ipwho.is/"; // 不传参数时返回请求方 IP 的完整信息

function safeJson(s, fb) { try { return JSON.parse(s); } catch { return fb; } }
function now() { return Date.now(); }
function hrs(h) { return h * 3600 * 1000; }

function flagEmoji(cc) {
  const c = String(cc || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return "";
  const A = 0x1F1E6;
  return String.fromCodePoint(A + (c.charCodeAt(0) - 65), A + (c.charCodeAt(1) - 65));
}

// 类型仅两分：数据中心 / 家宽（免费数据源无 residential 字段，以 hosting + ASN 关键词推断）
function ipType(d) {
  if (d?.hosting === true) return "数据中心";
  const s = String((d?.as || "") + " " + (d?.isp || "") + " " + (d?.org || "")).toLowerCase();
  if (/(tencent|alibaba|aliyun|amazon|aws|google|microsoft|azure|digitalocean|oracle|huawei|vultr|linode|akamai|ovh|cloudflare|server|host|colo|leaseweb|contabo|ionos|m247|choopa|psychz|racknerd|hostinger|buyvm|frantech|hetzner|dmit|datapacket|datacenter|data center)/.test(s)) return "数据中心";
  return "家宽";
}

function nativeLabel(geoCC, rirCC) {
  if (!(geoCC && rirCC)) return "未知";
  return geoCC === rirCC ? "原生" : "广播";
}

// 订阅名：取 Sub-Store 订阅配置的命名；若为 URL 则退化为文件名或域名
function subNameOf(p) {
  const s = String(p?.sub || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const last = decodeURIComponent((u.pathname || "").replace(/^\//, "").split("/").filter(Boolean).pop() || "");
      return last || u.hostname;
    } catch { return s; }
  }
  return s;
}

// 缓存键：服务器:端口（同一落地服务器多端口共享出口 IP，天然命中）
function cacheKey(node) {
  return `tag:${String(node?.server || "")}:${String(node?.port ?? "")}`;
}

// 简单令牌桶限速器；rpm<=0 表示不限速
function createRateLimiter(rpm, burst) {
  if (!(rpm > 0)) return async function () {};
  const interval = 60000 / rpm;
  let tokens = Math.max(1, burst);
  let last = now();
  return async function acquire() {
    for (;;) {
      const t = now();
      tokens = Math.min(Math.max(1, burst), tokens + (t - last) / interval);
      last = t;
      if (tokens >= 1) { tokens -= 1; return; }
      await $.wait(Math.ceil((1 - tokens) * interval) + 20);
      last = now();
    }
  };
}

// 清理过期缓存条目，防止长期运行后无限膨胀
function pruneCache(cacheAll, ttlMs) {
  const cutoff = now() - ttlMs;
  for (const k of Object.keys(cacheAll)) {
    const v = cacheAll[k];
    if (!v || typeof v !== "object" || !v.ts || v.ts < cutoff) delete cacheAll[k];
  }
}

async function mapLimit(arr, limit, fn) {
  const out = new Array(arr.length);
  let i = 0;
  const workers = new Array(Math.min(limit, arr.length)).fill(0).map(async () => {
    while (i < arr.length) {
      const idx = i++;
      out[idx] = await fn(arr[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

function extractCC(obj) {
  if (!obj || typeof obj !== "object") return "";
  const q = [{ v: obj, d: 0 }];
  const seen = new Set();
  while (q.length) {
    const { v, d } = q.shift();
    if (!v || typeof v !== "object") continue;
    if (seen.has(v)) continue;
    seen.add(v);
    if (d > 6) continue;
    for (const k of Object.keys(v)) {
      const val = v[k];
      const key = String(k).toLowerCase();
      if (typeof val === "string" && /^[A-Z]{2}$/i.test(val)) {
        if (key.includes("country") || key === "cc" || key.includes("location")) return val.toUpperCase();
      }
      if (val && typeof val === "object") q.push({ v: val, d: d + 1 });
    }
  }
  return "";
}

// ip-api.com 主源：限速 + 指数退避重试
async function fetchEcho($, proxyUrl, timeout, retries, limiter) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    await limiter();
    try {
      const r = await $.http.get({ url: ECHO_URL, timeout, proxy: proxyUrl });
      const d = safeJson(r.body, null);
      if (d && d.status === "success" && d.query) return d;
      lastErr = new Error(`ip-api: ${r.statusCode || d?.status || "no body"} ${d?.message || ""}`);
      if (String(d?.message || "").toLowerCase().includes("rate")) {
        await $.wait(2000 * (i + 1)); // 命中限流，延长退避
      }
    } catch (e) {
      lastErr = e;
      await $.wait(400 * (i + 1));
    }
  }
  throw lastErr || new Error("ip-api failed");
}

// 降级源 ipwho.is：不传 IP 时返回请求方 IP 的完整信息（含注册国）
async function fetchIpWhoIs($, proxyUrl, timeout, retries) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await $.http.get({ url: IPWHO_URL, timeout, proxy: proxyUrl });
      const w = safeJson(r.body, null);
      if (w?.success) return w;
      lastErr = new Error(`ipwho.is fail: ${r.statusCode || "no body"}`);
    } catch (e) { lastErr = e; }
    await $.wait(400 * (i + 1));
  }
  throw lastErr || new Error("ipwho.is failed");
}

// RIR 注册国：缓存 → ipwho.is 注册国（免 RIPE 请求）→ stat.ripe.net（限速）
async function getRirCC($, ip, whois, cacheAll, ttlMs, timeout, limiter) {
  if (!ip) return "";
  const ck = `rir:${ip}`;
  const c = cacheAll[ck];
  if (c && (now() - c.ts) < ttlMs) return c.cc || "";
  const fromWhois = String(whois?.connection?.country_code || "").trim().toUpperCase();
  if (fromWhois) {
    cacheAll[ck] = { ts: now(), cc: fromWhois };
    return fromWhois;
  }
  try {
    await limiter();
    const url = `https://stat.ripe.net/data/rir-stats-country/data.json?resource=${encodeURIComponent(ip)}`;
    const r = await $.http.get({ url, timeout });
    const j = safeJson(r.body, null);
    let cc = "";
    const lr = j?.data?.located_resources;
    if (Array.isArray(lr) && lr[0]?.location) {
      cc = String(lr[0].location).toUpperCase();
    } else {
      cc = extractCC(j) || "";
    }
    cacheAll[ck] = { ts: now(), cc };
    return cc;
  } catch {
    cacheAll[ck] = { ts: now(), cc: "" };
    return "";
  }
}

// 组装节点名：订阅名|国旗|类型|原生/广播 国家序号（丢弃原节点名全部冗余信息）
function buildTag(sub, flag, type, nb, seq) {
  const cleanSub = String(sub || "").replace(/[:,\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  const tag = flag
    ? `${cleanSub}|${flag}|${type}|${nb} ${seq}`
    : `${cleanSub}|未知|未知|未知`;
  return tag.slice(0, 95);
}

async function operator(proxies = []) {
  const $ = $substore;
  const concurrency = Math.min(50, Math.max(1, parseInt($arguments.concurrency || "20", 10)));
  const timeout = Math.max(1000, parseInt($arguments.timeout || "9000", 10));
  const ttl = Math.max(1, parseInt($arguments.ttl || "24", 10));
  const sort = String($arguments.sort ?? "1") !== "0";
  const markFail = String($arguments.mark_fail ?? "0") === "1";
  const retries = Math.max(0, parseInt($arguments.retries ?? "2", 10));
  const ipRpm = Math.max(0, parseInt($arguments.rpm ?? "40", 10));
  const rirRpm = Math.max(0, parseInt($arguments.rir_rpm ?? "30", 10));

  if (!proxies || !proxies.length) return proxies;

  const cacheAll = safeJson($.read(CACHE_KEY) || "{}", {});
  const ttlMs = hrs(ttl);
  pruneCache(cacheAll, ttlMs);

  // 转 internal 以取得 server/port 作为缓存键
  let internal = [];
  try { internal = ProxyUtils.produce(proxies, "ClashMeta", "internal"); } catch {}
  if (!internal || internal.length !== proxies.length) {
    try { internal = ProxyUtils.produce(proxies, "Clash", "internal"); } catch {}
  }
  if (!internal || internal.length !== proxies.length) return proxies;

  // meta[i]：{flag, cc, type, native}，null 表示本次失败且不输出
  const meta = new Array(proxies.length).fill(null);
  const missIdx = [];

  for (let i = 0; i < proxies.length; i++) {
    const ck = cacheKey(internal[i]);
    const c = cacheAll[ck];
    if (c && c.cc && (now() - c.ts) < ttlMs) {
      const cc = String(c.cc).toUpperCase();
      meta[i] = {
        flag: c.flag || flagEmoji(cc),
        cc,
        type: c.type || "家宽",
        native: c.native || "未知",
      };
    } else {
      missIdx.push(i);
    }
  }

  // 全部命中缓存：无需启动代理测试，直接进入编号排序
  if (missIdx.length) {
    const missInternal = missIdx.map(i => internal[i]);

    const start = await $.http.post({
      url: "http://127.0.0.1:9876/start",
      headers: { "content-type": "application/json" },
      timeout,
      body: JSON.stringify({ proxies: missInternal, timeout: 3000 + missInternal.length * 9000 }),
    });
    const sb = safeJson(start.body, null);
    if (!sb?.pid || !Array.isArray(sb?.ports) || sb.ports.length !== missInternal.length) return proxies;

    await $.wait(1200);

    const ipLimiter = createRateLimiter(ipRpm, Math.max(4, concurrency));
    const rirLimiter = createRateLimiter(rirRpm, 6);

    const results = await mapLimit(missInternal, concurrency, async (node, k) => {
      const proxyUrl = `http://127.0.0.1:${sb.ports[k]}`;
      const ck = cacheKey(node);

      try {
        let d;
        try {
          d = await fetchEcho($, proxyUrl, timeout, retries, ipLimiter);
        } catch {
          const w = await fetchIpWhoIs($, proxyUrl, timeout, retries);
          if (!w?.success) throw new Error("ip-api and ipwho.is failed");
          d = {
            status: "success",
            query: w.ip || "",
            countryCode: w.country_code || "",
            as: (w.connection?.asn ? `AS${w.connection.asn}` : "") + " " + (w.connection?.org || ""),
            isp: w.connection?.isp || w.connection?.org || "",
            org: w.connection?.org || "",
            hosting: /(hosting|datacenter)/i.test(JSON.stringify(w)) ? true : false,
            mobile: /(mobile|cellular)/i.test(JSON.stringify(w)) ? true : false,
            _whois: w,
          };
        }

        const ip = d.query || "";
        const cc = String(d.countryCode || "").trim().toUpperCase();
        const rirCC = await getRirCC($, ip, d._whois, cacheAll, ttlMs, timeout, rirLimiter);
        const m = { flag: flagEmoji(cc), cc, type: ipType(d), native: nativeLabel(cc, rirCC) };
        if (ip) cacheAll[ck] = { ts: now(), ...m };
        return m;
      } catch {
        // 失败结果不缓存，下次运行重新检测
        if (!markFail) return null;
        return { flag: "", cc: "", type: "未知", native: "未知" };
      }
    });

    for (let k = 0; k < missIdx.length; k++) meta[missIdx[k]] = results[k];

    try {
      await $.http.post({
        url: "http://127.0.0.1:9876/stop",
        headers: { "content-type": "application/json" },
        timeout,
        body: JSON.stringify({ pid: [sb.pid] }),
      });
    } catch {}
  }

  $.write(JSON.stringify(cacheAll), CACHE_KEY);

  // —— 分组编号 + 排序（序号与批次相关，永远现算，不依赖缓存）——
  const valid = [];
  const invalid = [];
  for (let i = 0; i < proxies.length; i++) {
    if (meta[i]) valid.push(i);
    else invalid.push(i);
  }

  // 组内编号：国家代码 + 数字（US01、JP02…），未知国家用 --
  const pad = Math.max(2, String(valid.length).length);
  const seqOf = new Map();
  if (sort) {
    // 按国家分组，组按国家代码排序（未知国家最后），组内保持原顺序
    const groups = new Map();
    for (const i of valid) {
      const cc = meta[i].cc || "";
      if (!groups.has(cc)) groups.set(cc, []);
      groups.get(cc).push(i);
    }
    const ccOrder = [...groups.keys()].sort((a, b) => {
      if (!a) return 1;
      if (!b) return -1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const finalOrder = [];
    for (const cc of ccOrder) {
      const arr = groups.get(cc);
      arr.forEach((i, k) => {
        seqOf.set(i, cc ? `${cc}${String(k + 1).padStart(pad, "0")}` : "--");
      });
      finalOrder.push(...arr);
    }
    finalOrder.push(...invalid);

    const renamed = [];
    for (const i of finalOrder) {
      const p = proxies[i];
      if (meta[i]) {
        p.name = buildTag(subNameOf(p), meta[i].flag, meta[i].type, meta[i].native, seqOf.get(i) || "--");
      }
      renamed.push(p);
    }
    return renamed;
  } else {
    // 不排序：保持原顺序，组内仍按 US01、US02… 编号
    const counters = {};
    const renamed = [];
    for (let i = 0; i < proxies.length; i++) {
      const p = proxies[i];
      if (meta[i]) {
        const cc = meta[i].cc || "";
        counters[cc] = (counters[cc] || 0) + 1;
        const seq = cc ? `${cc}${String(counters[cc]).padStart(pad, "0")}` : "--";
        p.name = buildTag(subNameOf(p), meta[i].flag, meta[i].type, meta[i].native, seq);
      }
      renamed.push(p);
    }
    return renamed;
  }
}
