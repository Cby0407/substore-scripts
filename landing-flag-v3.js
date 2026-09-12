/**
 * @Sub-Store-Page
 * 输出：国旗+国家+序号|类型
 * 例：🇺🇸美国 01|家宽
 *
 * 参数（#后，可不填）：
 *   concurrency=20    并发请求数（默认 20；受 rpm 限速约束，调大不增加封禁风险）
 *   rpm=40            ip-api.com 每分钟请求上限（免费版硬限制 45/min；0=不限速，易触发 429）
 *   timeout=9000      单次 HTTP 请求超时(ms)
 *   ttl=24            结果缓存有效期(小时)；节点按“服务器:端口”缓存，命中直接跳过全部网络请求
 *   mode=prefix       prefix=插入前缀; suffix=追加到原名后
 *   sort=1            1=按国家排序分组编号（未知国家最后），0=保持原顺序仅编号
 *   mark_fail=0       1=失败也输出  未知 --|未知
 *   retries=2         单节点请求失败重试次数
 *   key=xxx           保留参数，新版脚本以 ip-api.com 为主，可留空
 *
 * v3 改动（国旗+国家+序号+类型版）：
 *   - 输出格式改为「国旗 国家名 序号|类型」，类型仅两分：数据中心 / 家宽
 *   - 序号按国家分组动态生成（同国从 01 起编，位数随节点总量自适应），不依赖缓存
 *   - 缓存只存结构化结果（国旗/国家/类型），序号每次现算，订阅变动后序号依旧正确
 *   - 移除 RIPE 原生/广播判断，整体更省时
 *   - 保留 v2 的全部性能优化：结果缓存、增量测试、限速器、失败降级重试
 */

const CACHE_KEY = "landing_flag_cc_seq_type_v4";

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

// 国家/地区代码 → 中文名（常用表）
const CC_NAMES = {
  AF: "阿富汗", AL: "阿尔巴尼亚", DZ: "阿尔及利亚", AD: "安道尔", AO: "安哥拉",
  AR: "阿根廷", AM: "亚美尼亚", AU: "澳大利亚", AT: "奥地利", AZ: "阿塞拜疆",
  BS: "巴哈马", BH: "巴林", BD: "孟加拉国", BY: "白俄罗斯", BE: "比利时",
  BZ: "伯利兹", BJ: "贝宁", BT: "不丹", BO: "玻利维亚", BA: "波黑",
  BW: "博茨瓦纳", BR: "巴西", BN: "文莱", BG: "保加利亚", BF: "布基纳法索",
  BI: "布隆迪", KH: "柬埔寨", CM: "喀麦隆", CA: "加拿大", CV: "佛得角",
  CF: "中非", TD: "乍得", CL: "智利", CN: "中国", CO: "哥伦比亚",
  KM: "科摩罗", CG: "刚果(布)", CD: "刚果(金)", CR: "哥斯达黎加", CI: "科特迪瓦",
  HR: "克罗地亚", CU: "古巴", CY: "塞浦路斯", CZ: "捷克", DK: "丹麦",
  DJ: "吉布提", DM: "多米尼克", DO: "多米尼加", EC: "厄瓜多尔", EG: "埃及",
  SV: "萨尔瓦多", GQ: "赤道几内亚", ER: "厄立特里亚", EE: "爱沙尼亚", SZ: "斯威士兰",
  ET: "埃塞俄比亚", FJ: "斐济", FI: "芬兰", FR: "法国", GA: "加蓬",
  GM: "冈比亚", GE: "格鲁吉亚", DE: "德国", GH: "加纳", GR: "希腊",
  GD: "格林纳达", GT: "危地马拉", GN: "几内亚", GW: "几内亚比绍", GY: "圭亚那",
  HT: "海地", HN: "洪都拉斯", HU: "匈牙利", IS: "冰岛", IN: "印度",
  ID: "印度尼西亚", IR: "伊朗", IQ: "伊拉克", IE: "爱尔兰", IL: "以色列",
  IT: "意大利", JM: "牙买加", JP: "日本", JO: "约旦", KZ: "哈萨克斯坦",
  KE: "肯尼亚", KI: "基里巴斯", KP: "朝鲜", KR: "韩国", KW: "科威特",
  KG: "吉尔吉斯斯坦", LA: "老挝", LV: "拉脱维亚", LB: "黎巴嫩", LS: "莱索托",
  LR: "利比里亚", LY: "利比亚", LI: "列支敦士登", LT: "立陶宛", LU: "卢森堡",
  MG: "马达加斯加", MW: "马拉维", MY: "马来西亚", MV: "马尔代夫", ML: "马里",
  MT: "马耳他", MH: "马绍尔群岛", MR: "毛里塔尼亚", MU: "毛里求斯", MX: "墨西哥",
  FM: "密克罗尼西亚", MD: "摩尔多瓦", MC: "摩纳哥", MN: "蒙古", ME: "黑山",
  MA: "摩洛哥", MZ: "莫桑比克", MM: "缅甸", NA: "纳米比亚", NR: "瑙鲁",
  NP: "尼泊尔", NL: "荷兰", NZ: "新西兰", NI: "尼加拉瓜", NE: "尼日尔",
  NG: "尼日利亚", MK: "北马其顿", NO: "挪威", OM: "阿曼", PK: "巴基斯坦",
  PW: "帕劳", PA: "巴拿马", PG: "巴布亚新几内亚", PY: "巴拉圭", PE: "秘鲁",
  PH: "菲律宾", PL: "波兰", PT: "葡萄牙", QA: "卡塔尔", RO: "罗马尼亚",
  RU: "俄罗斯", RW: "卢旺达", KN: "圣基茨和尼维斯", LC: "圣卢西亚", VC: "圣文森特",
  WS: "萨摩亚", SM: "圣马力诺", ST: "圣多美和普林西比", SA: "沙特阿拉伯", SN: "塞内加尔",
  RS: "塞尔维亚", SC: "塞舌尔", SL: "塞拉利昂", SG: "新加坡", SK: "斯洛伐克",
  SI: "斯洛文尼亚", SB: "所罗门群岛", SO: "索马里", ZA: "南非", SS: "南苏丹",
  ES: "西班牙", LK: "斯里兰卡", SD: "苏丹", SR: "苏里南", SE: "瑞典",
  CH: "瑞士", SY: "叙利亚", TW: "中国台湾", TJ: "塔吉克斯坦", TZ: "坦桑尼亚",
  TH: "泰国", TL: "东帝汶", TG: "多哥", TO: "汤加", TT: "特立尼达和多巴哥",
  TN: "突尼斯", TR: "土耳其", TM: "土库曼斯坦", TV: "图瓦卢", UG: "乌干达",
  UA: "乌克兰", AE: "阿联酋", GB: "英国", US: "美国", UY: "乌拉圭",
  UZ: "乌兹别克斯坦", VU: "瓦努阿图", VA: "梵蒂冈", VE: "委内瑞拉", VN: "越南",
  YE: "也门", ZM: "赞比亚", ZW: "津巴布韦",
  HK: "中国香港", MO: "中国澳门",
};

function ccNameOf(cc) {
  const c = String(cc || "").trim().toUpperCase();
  return CC_NAMES[c] || c;
}

// 类型仅两分：数据中心 / 家宽（免费数据源无 residential 字段，以 hosting + ASN 关键词推断）
function ipType(d) {
  if (d?.hosting === true) return "数据中心";
  const s = String((d?.as || "") + " " + (d?.isp || "") + " " + (d?.org || "")).toLowerCase();
  if (/(tencent|alibaba|aliyun|amazon|aws|google|microsoft|azure|digitalocean|oracle|huawei|vultr|linode|akamai|ovh|cloudflare|server|host|colo|leaseweb|contabo|ionos|m247|choopa|psychz|racknerd|hostinger|buyvm|frantech|hetzner|dmit|datapacket|datacenter|data center)/.test(s)) return "数据中心";
  return "家宽";
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

// 降级源 ipwho.is：不传 IP 时返回请求方 IP 的完整信息
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

// 清洗节点名中易破坏 YAML 结构的字符
function buildName(orig, tag, mode) {
  const cleanName = String(orig || "")
    .replace(/[:,\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const sep = cleanName ? " " : "";
  const name = mode === "suffix" ? `${cleanName}${sep}${tag}` : `${tag}${sep}${cleanName}`;
  return name.slice(0, 95);
}

async function operator(proxies = []) {
  const $ = $substore;
  const concurrency = Math.min(50, Math.max(1, parseInt($arguments.concurrency || "20", 10)));
  const timeout = Math.max(1000, parseInt($arguments.timeout || "9000", 10));
  const ttl = Math.max(1, parseInt($arguments.ttl || "24", 10));
  const mode = String($arguments.mode || "prefix").toLowerCase() === "suffix" ? "suffix" : "prefix";
  const sort = String($arguments.sort ?? "1") !== "0";
  const markFail = String($arguments.mark_fail ?? "0") === "1";
  const retries = Math.max(0, parseInt($arguments.retries ?? "2", 10));
  const ipRpm = Math.max(0, parseInt($arguments.rpm ?? "40", 10));

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

  // meta[i]：{flag, cc, ccName, type}，null 表示本次失败且不输出
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
        ccName: c.ccName || ccNameOf(cc),
        type: c.type || "家宽",
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
          };
        }

        const ip = d.query || "";
        const cc = String(d.countryCode || "").trim().toUpperCase();
        const m = { flag: flagEmoji(cc), cc, ccName: ccNameOf(cc), type: ipType(d) };
        if (ip) cacheAll[ck] = { ts: now(), ...m };
        return m;
      } catch {
        // 失败结果不缓存，下次运行重新检测
        if (!markFail) return null;
        return { flag: "", cc: "", ccName: "未知", type: "未知" };
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

  // 组内编号
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
      arr.forEach((i, k) => seqOf.set(i, String(k + 1).padStart(pad, "0")));
      finalOrder.push(...arr);
    }
    finalOrder.push(...invalid);

    const renamed = [];
    for (const i of finalOrder) {
      const p = proxies[i];
      if (meta[i]) {
        const seq = seqOf.get(i) || "--";
        p.name = buildName(p.name, `${meta[i].flag}${meta[i].ccName} ${seq}|${meta[i].type}`, mode);
      }
      renamed.push(p);
    }
    return renamed;
  } else {
    // 不排序：保持原顺序，组内仍按 01、02… 编号
    const counters = {};
    const renamed = [];
    for (let i = 0; i < proxies.length; i++) {
      const p = proxies[i];
      if (meta[i]) {
        const cc = meta[i].cc || "";
        counters[cc] = (counters[cc] || 0) + 1;
        const seq = String(counters[cc]).padStart(pad, "0");
        p.name = buildName(p.name, `${meta[i].flag}${meta[i].ccName} ${seq}|${meta[i].type}`, mode);
      }
      renamed.push(p);
    }
    return renamed;
  }
}
