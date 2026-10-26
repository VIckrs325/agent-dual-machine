/**
 * 搜索模块（零依赖）—— 给 qq-bridge 用
 *
 * 设计原则：**确定性检索**，不让 4B 自己决定搜不搜/搜什么。
 *   - 触发：规则判断（时效词 / 显式指令），代码决定
 *   - 检索：单次调用，固定 top-N，超时降级
 *   - 注入：把摘要拼成编号上下文，要求模型只用这些资料并标 [n]
 *
 * 支持 provider：
 *   bing    —— 免费抓取，中文结果最准，约 2.3s
 *   ddg     —— 免费抓取（POST），约 1.8s，英文尚可、中文一般
 *   bocha   —— 博查 API，需 key，约 0.3~0.6s，专为 LLM 设计
 *   tavily  —— Tavily API，需 key，约 0.5~1s
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const DEFAULTS = {
  enabled: true,
  provider: 'bing',        // bing | ddg | bocha | tavily
  maxResults: 3,
  snippetChars: 240,       // 每条摘要上限，控制 prefill 成本
  timeoutMs: 6000,
  cacheTtlMs: 300000,      // 5 分钟内同 query 复用
  negCacheTtlMs: 60000,    // 失败结果的负缓存，避免反复慢查询
  apiKey: '',              // bocha / tavily 用；建议放环境变量
  depth: 'snippet',        // snippet=只用摘要（快） | read=再抓正文（文章类有效，表格类无效，+1~3s）
  autoRead: false,         // 摘要过短时是否自动升级 read（默认关：实测收益不稳定）
  readBudget: 420,         // 正文抽取的字符预算（控 token）
  readTimeoutMs: 5000,
  attemptTimeoutMs: 3500,  // 「尝试搜」档的超时（比强制档短，避免拖慢聊天）
  minSnippetChars: 50,     // 摘要短于此视为噪音（SEO 落地页）
  minRelevance: 0.34,      // 2-gram 命中率下限，低于它视为跑题
  fallbackProvider: 'ddg', // 主源失败/无有效结果时降级
  // 噪声站点：摘要基本没用，直接丢
  blockedHosts: [
    'jingyan.baidu.com', 'zhidao.baidu.com', 'wenku.baidu.com', 'tieba.baidu.com',
    'zhidao.so.com', 'iask.sina.com.cn', 'wenwen.sogou.com', 'baijiahao.baidu.com',
  ],
  // 显式要求搜索
  explicitRe: '搜一下|搜一搜|搜搜|搜下|帮我搜|帮我找|找一下|查一查|帮我查|查一下|查查|搜索一下|网上查|搜个',
  // 时效性关键词
  freshRe: '最新|今天|昨天|明天|本周|这周|最近|现在|当前|刚刚|实时|新闻|价格|股价|汇率|天气|气温|降水|发布会|赛程|上映|比分|谁赢|多少钱|几年|多高|多大',
  // 疑问形态（与时效词共现 → force）
  askRe: '吗|呢|多少|几|什么|怎么|如何|哪|谁|是否|有没有|支持|区别|多久|多长|多大|多高|什么时候|是不是|能不能',
  // 实体查询形态（单独出现也值得试一次检索）
  lookupRe: '是谁|什么公司|多少钱|多久|多高|多大|什么时候|哪一年|哪个|排名|现任|创始人|几个人|在哪',
};

const cache = new Map(); // key -> { at, data }
const warnedProviders = new Set(); // 缺 key 的提示只打一次

// ---- 限流（借鉴 duckduckgo-mcp-server：令牌桶 + 429 Retry-After） ----
const buckets = new Map(); // provider -> { tokens, last }

function takeToken(provider, rpm) {
  const now = Date.now();
  const st = buckets.get(provider) || { tokens: rpm, last: now };
  st.tokens = Math.min(rpm, st.tokens + ((now - st.last) / 60000) * rpm);
  st.last = now;
  buckets.set(provider, st);
  if (st.tokens < 1) return false;
  st.tokens -= 1;
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 带 429 重试的 fetch（Retry-After 上限 2s，避免拖死聊天） */
async function fetchWithRetry(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res = await fetch(url, { ...init, signal: ctrl.signal });
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after') || 1);
      await sleep(Math.min(2000, Math.max(300, ra * 1000)));
      res = await fetch(url, { ...init, signal: ctrl.signal });
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/** URL 规范化：去掉锚点与追踪参数，用于去重 */
function canonicalUrl(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    for (const k of [...x.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|spm|from|ref|share)/i.test(k)) x.searchParams.delete(k);
    }
    const p = x.pathname.replace(/\/+$/, '') || '/';
    return x.hostname.replace(/^www\./, '') + p + (x.search ? '?' + x.searchParams.toString() : '');
  } catch {
    return String(u || '');
  }
}

/** 是否被反爬挡住（DDG 对被嫌弃的 TLS 指纹会返回 202 空页） */
function isBlockedPage(status, body) {
  if (status === 202 || status === 403) return true;
  if (status === 200 && !String(body || '').trim()) return true;
  return false;
}

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function cut(s, n) {
  const t = stripTags(s);
  return t.length <= n ? t : t.slice(0, n) + '…';
}

/**
 * 检索词清洗：去掉"帮我查一下"这类指令词。
 * 实测差别极大——带"帮我查一下"时 Bing 返回百度经验/知乎，去掉后是官方文档。
 */
export function buildQuery(text) {
  const raw = String(text || '').trim();
  let q = raw
    .replace(/^(帮我|帮忙|麻烦你?|请你?|你能|可以|能不能)\s*/g, '')
    .replace(/^(查一下|查查|查一查|搜一下|搜搜|搜索一下|搜索|网上查|搜个|找一下|找找)\s*/g, '')
    .replace(/^(查一下|查查|搜一下|搜搜|搜索一下|网上查)\s*/g, '')
    .replace(/^(请问|想问一下|问一下)\s*/g, '')
    .replace(/^(查|搜|找)\s+/g, '')   // "帮我查 SpaceX…" → "SpaceX…"
    .replace(/^(现在|目前|如今)\s*/g, '')
    .replace(/[？?。！!~～]+$/g, '')
    // 去掉句尾虚词：实测保留"怎么样"会让 Bing 返回「北京市百科」而不是天气预报
    .replace(/(怎么样|怎样|如何|呢|吗|啊|呀|吧|请问|告诉我|你知道)$/g, '')
    // 实体问句的"是谁/是什么"：留着反而让 Bing 给弱结果
    // （实测「周杰伦」4 条百科；「周杰伦是谁」0 条可用）
    .replace(/(是谁|是啥|是什么公司|是什么|干什么的|做什么的)$/g, '')
    // 句中残留的"怎么样"（如"北京天气怎么样今天"）也去掉
    .replace(/(怎么样|怎样)/g, '')
    .replace(/有什么/g, '')          // "最近有什么AI新闻" → "最近AI新闻"
    .replace(/(多少钱|多少|多久|多长|多大|多高)$/g, '') // "成都今天气温多少" → "成都今天气温"
    .replace(/\s+/g, ' ')
    .trim();
  return q || raw;
}

/**
 * 决定要不要搜、以及用哪一档。
 *
 * 之前是 `fresh && ask` 双条件，实测触发率只有 1.4%（73 条消息搜 1 次），
 * 连「今天美元汇率」「DeepSeek 是什么公司」都被跳过 —— 这就是"搜索似有似无"。
 *
 * 现在分两档：
 *   force   —— 显式指令，或 时效词+疑问词。超时 6s，结果直接用。
 *   attempt —— 只要像"问题"（疑问词 / 时效词 / 问号）就试一次。超时 3.5s，
 *              **结果交给质量门槛决定要不要注入**（宁可不用，也不污染上下文）。
 *   skip    —— 代码/报错、纯闲聊、太短。
 */
export function decideSearch(text, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  if (!c.enabled) return { mode: 'skip', reason: 'disabled' };
  const t = String(text || '').trim();
  if (t.length < 2) return { mode: 'skip', reason: 'too_short' };

  const explicit = new RegExp(c.explicitRe).test(t);
  if (explicit) return { mode: 'force', reason: 'explicit' };

  // 纯代码/报错类问题不搜：本地模型更擅长，搜了也是噪音
  if (/代码|函数|报错|异常|怎么改|bug|stack ?trace|python|javascript|sql|正则/i.test(t)) {
    return { mode: 'skip', reason: 'code' };
  }

  const fresh = new RegExp(c.freshRe).test(t);
  const ask = new RegExp(c.askRe).test(t);
  const lookup = new RegExp(c.lookupRe).test(t);
  if (fresh && ask) return { mode: 'force', reason: 'fresh+ask' };
  if (fresh) return { mode: 'attempt', reason: 'fresh' };
  if (ask && t.length >= 4) return { mode: 'attempt', reason: 'ask' };
  // 定义题（「什么是 X」）本地模型就能答，不浪费 2 秒去搜
  if (lookup) return { mode: 'attempt', reason: 'lookup' };
  if (/[?？]\s*$/.test(t) && /[A-Za-z0-9]/.test(t)) return { mode: 'attempt', reason: 'question_mark' };
  return { mode: 'skip', reason: 'no_signal' };
}

/** 兼容旧接口：是否要搜（force 或 attempt 都算） */
export function shouldSearch(text, cfg = {}) {
  return decideSearch(text, cfg).mode !== 'skip';
}

/** 相关性：去掉问句虚词后，按 2-gram 命中率判断，挡住"跑题结果" */
function relevanceOk(query, item, cfg) {
  const stop = /(今天|昨天|明天|最新|现在|最近|本周|这周|是什么|是谁|多少钱|多少|怎么样|怎么|什么|如何|请问|帮我查|查一下|搜一下|的|了|吗|呢|啊|吧)/g;
  const clean = String(query).replace(stop, '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  const grams = [];
  for (let i = 0; i + 2 <= clean.length; i++) grams.push(clean.slice(i, i + 2));
  if (!grams.length) return true; // 太短无法判断，放行
  const hay = (String(item.title || '') + ' ' + String(item.snippet || '')).toLowerCase();
  const hit = grams.filter((g) => hay.includes(g.toLowerCase())).length;
  // 命中 1 个 2-gram 即视为相关：实测阈值要求 2 个时，
  // 天气这类短查询会被误杀（同一条结果时好时坏 → 表现为"搜索似有似无"）
  return hit >= 1;
}

/** 质量过滤：摘要太短、噪声站点、重复域名/重复页面、跑题 → 丢掉 */
function qualityFilter(items, cfg) {
  const blocked = new Set((cfg.blockedHosts || []).map((h) => h.toLowerCase()));
  const seenHost = new Set();
  const seenUrl = new Set();
  const kept = [];
  for (const it of items) {
    let host = '';
    try {
      host = new URL(it.url).hostname.replace(/^www\./, '');
    } catch {}
    if (!it.title || !it.snippet) continue;
    if (it.snippet.length < cfg.minSnippetChars) continue;
    if (blocked.has(host)) continue;
    const cu = canonicalUrl(it.url);
    if (seenUrl.has(cu)) continue;          // 同一页面（换了个追踪参数）只留一条
    if (host && seenHost.has(host)) continue; // 同域只留一条，保证来源多样性
    seenUrl.add(cu);
    if (host) seenHost.add(host);
    if (!relevanceOk(cfg.__query || '', it, cfg)) continue; // 跑题结果
    kept.push(it);
  }
  return kept;
}

/** Bing 把真实地址包在 /ck/a?...&u=a1<base64url> 里，需要解出来 */
function decodeBingUrl(href) {
  const h = String(href || '').replace(/&amp;/g, '&');
  if (!h.includes('bing.com/ck/a')) return h;
  const m = h.match(/[?&]u=a1([^&]+)/);
  if (!m) return h;
  try {
    let s = decodeURIComponent(m[1]).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const out = Buffer.from(s, 'base64').toString('utf8');
    return /^https?:\/\//.test(out) ? out : h;
  } catch {
    return h;
  }
}

/** 抓取 Bing 搜索结果 */
async function bing(query, cfg) {
  if (!takeToken('bing', cfg.ratePerMin || 20)) throw new Error('rate_limited');
  const url = 'https://www.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=zh-CN&ensearch=0';
  const res = await fetchWithRetry(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' } }, cfg.timeoutMs || 6000);
  const html = await res.text();
  if (isBlockedPage(res.status, html)) throw new Error('blocked_' + res.status);
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) || [];
  const items = [];
  for (const b of blocks) {
    const m = b.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!m) continue;
    const snip =
      (b.match(/<p[^>]*>([\s\S]*?)<\/p>/) || [])[1] ||
      (b.match(/class="b_caption"[^>]*>([\s\S]*?)<\/div>/) || [])[1] ||
      '';
    items.push({ title: stripTags(m[2]), url: decodeBingUrl(m[1]), snippet: cut(snip, cfg.snippetChars) });
    if (items.length >= cfg.maxResults) break;
  }
  return items;
}

/** 抓取 DuckDuckGo（html 端点需 POST，GET 会返回挑战页） */
async function ddg(query, cfg) {
  if (!takeToken('ddg', cfg.ratePerMin || 20)) throw new Error('rate_limited');
  const res = await fetchWithRetry(
    'https://html.duckduckgo.com/html/',
    {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      body: new URLSearchParams({ q: query }).toString(),
    },
    cfg.timeoutMs || 6000
  );
  const html = await res.text();
  // DDG 对被嫌弃的 TLS 指纹会返回 202 空页 —— 必须显式识别，否则会静默当成"无结果"
  if (isBlockedPage(res.status, html)) throw new Error('blocked_' + res.status);
  const res_ = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snips = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1]);
  let m, i = 0;
  while ((m = re.exec(html)) && res_.length < cfg.maxResults) {
    let href = m[1];
    // 解 DDG 跳转链接
    const u = href.match(/uddg=([^&]+)/);
    if (u) href = decodeURIComponent(u[1]);
    res_.push({ title: stripTags(m[2]), url: href, snippet: cut(snips[i++] || '', cfg.snippetChars) });
  }
  return res_;
}

/** 博查 API（国内、为 LLM 优化、返回干净摘要） */
async function bocha(query, cfg) {
  const key = cfg.apiKey || process.env.BOCHA_API_KEY || '';
  if (!key) throw new Error('缺少 BOCHA_API_KEY');
  const res = await fetch('https://api.bochaai.com/v1/web-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, summary: true, count: cfg.maxResults, freshness: 'noLimit' }),
  });
  const j = await res.json();
  const arr = j?.data?.webPages?.value || [];
  return arr.slice(0, cfg.maxResults).map((x) => ({
    title: x.name || '',
    url: x.url || '',
    snippet: cut(x.summary || x.snippet || '', cfg.snippetChars),
  }));
}

/** Tavily API */
async function tavily(query, cfg) {
  const key = cfg.apiKey || process.env.TAVILY_API_KEY || '';
  if (!key) throw new Error('缺少 TAVILY_API_KEY');
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: cfg.maxResults, search_depth: 'basic', include_answer: false }),
  });
  const j = await res.json();
  return (j.results || []).slice(0, cfg.maxResults).map((x) => ({
    title: x.title || '',
    url: x.url || '',
    snippet: cut(x.content || '', cfg.snippetChars),
  }));
}

const PROVIDERS = { bing, ddg, bocha, tavily };

// ---------- 正文读取（搜索摘要质量差时兜底） ----------

/** 抓页面并抽纯文本 */
async function fetchPage(url, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();
    return stripTags(
      html
        .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
    );
  } finally {
    clearTimeout(timer);
  }
}

/** 用查询的 2-gram 给句子打分，抽最相关的几段（控制 token） */
function extractRelevant(text, query, budget = 420) {
  const grams = new Set();
  const q = String(query).replace(/[？?。，,！!、\s]/g, '');
  for (let i = 0; i + 2 <= q.length; i++) grams.add(q.slice(i, i + 2));
  const sents = text
    .split(/(?<=[。！？!?；;])|\n/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12 && s.length <= 220);
  const scored = sents.map((s, i) => {
    let sc = 0;
    for (const g of grams) if (s.includes(g)) sc += 1;
    if (/\d/.test(s)) sc += 0.6;          // 含数字更可能是事实句
    if (/[℃%]|元|美元|年|月|日|时/.test(s)) sc += 0.4;
    return { s, i, sc };
  });
  scored.sort((a, b) => b.sc - a.sc || a.i - b.i);
  const out = [];
  let len = 0;
  for (const x of scored) {
    if (x.sc <= 0) break;
    if (len + x.s.length > budget) continue;
    out.push(x);
    len += x.s.length;
    if (out.length >= 5) break;
  }
  return out
    .sort((a, b) => a.i - b.i)
    .map((x) => x.s)
    .join(' ');
}

/**
 * 执行检索。
 * @returns {{ok:boolean, items:Array, ms:number, provider:string, cached?:boolean, read?:number, err?:string}}
 */
export async function webSearch(query, cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const q = String(query || '').trim().slice(0, 120);
  if (!q) return { ok: false, items: [], ms: 0, provider: c.provider, err: 'empty query' };
  const timeoutMs = Number(c.timeoutMs) || 6000;

  const key = c.provider + '::' + q;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.neg ? c.negCacheTtlMs : c.cacheTtlMs)) {
    if (hit.neg) return { ok: false, items: [], ms: 0, provider: c.provider, cached: true, err: hit.err };
    return { ok: true, items: hit.items, ms: 0, provider: c.provider, cached: true };
  }

  const t0 = Date.now();
  const tryProvider = async (name) => {
    const fn = PROVIDERS[name];
    if (!fn) throw new Error('unknown provider ' + name);
    const raw = await Promise.race([
      fn(q, c),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
    return { raw, kept: qualityFilter(raw, { ...c, __query: q }) };
  };

  // 需要 key 的源没配 key 时，直接走备用源，避免"每次先失败一次"
  const KEYED = { tavily: 'TAVILY_API_KEY', bocha: 'BOCHA_API_KEY' };
  const ready = (name) => {
    const env = KEYED[name];
    return !env || Boolean(c.apiKey || process.env[env]);
  };
  const warned = warnedProviders;

  try {
    let primary = c.provider;
    if (!ready(primary)) {
      const fb = c.fallbackProvider;
      if (!warned.has(primary)) {
        warned.add(primary);
        console.log(`[search] ${primary} 未配置 ${KEYED[primary]}，改用 ${fb || primary}（仅提示一次）`);
      }
      if (fb && ready(fb) && PROVIDERS[fb]) primary = fb;
    }
    let usedProvider = primary;
    let { raw, kept } = await tryProvider(primary);

    // 主源没货 → 降级到备用源（实测 bing 偶发返回整页噪声/被限流）
    if (!kept.length && c.fallbackProvider && c.fallbackProvider !== primary && PROVIDERS[c.fallbackProvider] && ready(c.fallbackProvider)) {
      try {
        const fb = await tryProvider(c.fallbackProvider);
        if (fb.kept.length) {
          usedProvider = c.fallbackProvider;
          raw = fb.raw;
          kept = fb.kept;
        }
      } catch {}
    }

    if (!kept.length) {
      cache.set(key, { at: Date.now(), neg: true, err: raw.length ? 'low quality' : 'no results' });
      if (cache.size > 300) cache.delete(cache.keys().next().value);
      return {
        ok: false,
        items: [],
        ms: Date.now() - t0,
        provider: usedProvider,
        raw: raw.length,
        err: raw.length ? 'low quality' : 'no results',
      };
    }

    // 摘要过短通常是 SEO 落地页，抓正文补一层
    let readCount = 0;
    const thin = kept.every((x) => (x.snippet || '').length < 90);
    const wantRead = c.depth === 'read' || (c.autoRead !== false && thin);
    if (wantRead) {
      const top = kept.slice(0, c.depth === 'read' ? 2 : 1);
      const texts = await Promise.all(
        top.map((it) =>
          fetchPage(it.url, c.readTimeoutMs)
            .then((t) => extractRelevant(t, q, c.readBudget))
            .catch(() => '')
        )
      );
      texts.forEach((t, i) => {
        if (t) {
          top[i].snippet = cut(t, c.snippetChars * 2);
          readCount++;
        }
      });
    }

    const items = kept.slice(0, c.maxResults);
    cache.set(key, { at: Date.now(), items });
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return {
      ok: true,
      items,
      ms: Date.now() - t0,
      provider: usedProvider,
      read: readCount,
      raw: raw.length,
      dropped: raw.length - kept.length,
    };
  } catch (e) {
    cache.set(key, { at: Date.now(), neg: true, err: String(e?.message || e) });
    return { ok: false, items: [], ms: Date.now() - t0, provider: c.provider, err: String(e?.message || e) };
  }
}

/** 把检索结果拼成提示块（控制 token 用量） */
export function buildContext(items) {
  if (!items?.length) return '';
  const lines = items.map(
    (x, i) => `[${i + 1}] ${x.title}\n${x.snippet}\n来源: ${x.url}`
  );
  return '以下是刚检索到的资料：\n' + lines.join('\n\n');
}
