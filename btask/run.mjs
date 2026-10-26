#!/usr/bin/env node
/**
 * B 档稳定版 —— 用「提示词编排」把 Qwen3.5 4B 变成会查、会核、会总结的任务助手
 *
 * 流水线：
 *   ① 规划   ：让它自己列出要搜什么（1~4 条）
 *   ② 检索   ：逐条搜，拿标题+摘要
 *   ③ 压缩   ：每条查询单独压缩成"与问题相关的事实"（分批，避免塞爆上下文）
 *   ④ 核查   ：找矛盾/缺口，有问题就再列补充查询
 *   ⑤ 复核   ：补充查询再搜一轮，合并事实再核一次（默认最多 1 轮补充）
 *   ⑥ 总结   ：基于事实作答，事实不足就直说
 *
 * 特点：
 *   - 每一步都留痕（提示词、思考、输出、耗时），落到 btask/traces/*.json
 *   - 默认关思考；--think / --think-all 才开。若某步出现"思考有内容但正文为空"（Qwen3 的坑），自动用 think:false 重试一次
 *   - 不改 bridge/ 与 bridge-test/，可独立跑、独立回滚
 *
 * 用法：
 *   node btask/run.mjs "Qwen3.5 是什么时候发布的？有什么主要特点？"
 *   node btask/run.mjs "..." --profile smoke        # 冒烟：2 条查询、无补充、8~15s
 *   node btask/run.mjs "..." --profile plan         # 只看规划，150~170s
 *   node btask/run.mjs "..." --profile deep         # 全步思考，220~350s
 *   node btask/run.mjs --profile deep --dry-run     # 只打印解析结果，不调模型（验收用）
 *   node btask/run.mjs "..." --think --max-queries 4 --supplement 1 --model qwen3.5:4b
 *   node btask/run.mjs "..." --no-think --quiet
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webSearch } from '../bridge/search.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRACE_DIR = path.join(HERE, 'traces');

// 自带 env 加载：不依赖 systemd，直接读桥的 env 文件（只补缺失的变量，不覆盖已有值）
// 优先级：tmpfs 缓存（/run/user/<uid>/qq-bridge.env）> 旧位置（~/.config/qq-bridge.env）
function loadEnvFile(p) {
  try {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}
const HOME = process.env.HOME || '';
const RUNTIME = process.env.XDG_RUNTIME_DIR || (typeof process.getuid === 'function' ? '/run/user/' + process.getuid() : '');
if (RUNTIME) loadEnvFile(path.join(RUNTIME, 'qq-bridge.env'));
loadEnvFile(path.join(HOME, '.config', 'qq-bridge.env'));

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--model', '--max-queries', '--supplement', '--ctx', '--profile']);
const flags = new Set();
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (VALUE_FLAGS.has(a)) {
    flags.add(a);
    i += 1;                       // 跳过参数值，别把它当成问题的一部分
    continue;
  }
  if (a.startsWith('--')) {
    flags.add(a);
    continue;
  }
  positional.push(a);
}
const getVal = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const getNum = (name, dflt) => {
  const v = getVal(name, null);
  return v === null || v === '' || Number.isNaN(Number(v)) ? dflt : Number(v);
};

// ---------- 模式预设（2026-10-22 新增）----------
// 把"哪种 flag 组合对应哪种跑法"从 README/CHANGELOG 里固化进代码。
// 依据：btask/traces/ 的 24 份实测（19 份关思考，5 份开思考，全在 10-20 凌晨那 22 分钟）。
// 显式 flag 永远覆盖 profile，方便在预设基线上做单变量 A/B。
const PROFILES = {
  quick: {
    desc: '日常问答（默认）',
    model: 'qwen3.5:4b', thinkSteps: [], maxQueries: 4, supplementRounds: 1, ctx: 16384,
    expectSec: '9~30', note: '全关思考；会把 A 档模型挤出显存，首条慢 3~5 秒',
  },
  smoke: {
    desc: '改完代码的冒烟验证',
    model: 'qwen3.5:4b', thinkSteps: [], maxQueries: 2, supplementRounds: 0, ctx: 8192,
    expectSec: '8~15', note: '只验证流水线没崩，不追求答案质量',
  },
  plan: {
    desc: '看它怎么拆问题（只规划步开思考）',
    model: 'qwen3.5:4b', thinkSteps: ['plan'], maxQueries: 3, supplementRounds: 0, ctx: 16384,
    expectSec: '150~170', note: '规划步单项思考就 125 秒起；--think 等价于此档',
  },
  deep: {
    desc: '深挖（全步开思考）',
    model: 'qwen3.5:4b', thinkSteps: ['plan', 'extract', 'check', 'final'], maxQueries: 4, supplementRounds: 1, ctx: 16384,
    expectSec: '220~350', note: '单步思考可达 4.3 万字，4/24 实测触发过降级重试；--think-all 等价于此档',
  },
};
const PROFILE_NAME = getVal('--profile', 'quick');
const PROFILE = PROFILES[PROFILE_NAME];
if (!PROFILE) {
  console.error(`未知模式：${PROFILE_NAME}\n可用模式：`);
  for (const [k, v] of Object.entries(PROFILES)) {
    console.error(`  ${k.padEnd(6)} ${v.desc}｜约 ${v.expectSec}s｜${v.note}`);
  }
  process.exit(2);
}

const Q = positional.join(' ').trim();
if (!Q && !flags.has('--dry-run')) {
  console.error('用法: node btask/run.mjs "你的问题" [--profile quick|smoke|plan|deep] [--dry-run]');
  console.error('      [--model qwen3.5:4b] [--think|--think-all|--no-think] [--max-queries 4] [--supplement 1] [--ctx 16384] [--quiet]');
  console.error(`模式：${Object.keys(PROFILES).join(' / ')}（默认 quick）；--dry-run 只打印解析结果不调模型`);
  process.exit(2);
}

// 思考步位优先级：--no-think > --think-all > --think > profile 默认
let thinkSteps = PROFILE.thinkSteps;
if (flags.has('--no-think')) thinkSteps = [];
else if (flags.has('--think-all')) thinkSteps = ['plan', 'extract', 'check', 'final'];
else if (flags.has('--think')) thinkSteps = ['plan'];

const CFG = {
  profile: PROFILE_NAME,
  model: getVal('--model', PROFILE.model),
  // 默认关思考。--think 只在「规划」步开（思考短、能看清它怎么拆问题）；
  // --think-all 全开（实测单步思考能到 4.3 万字，整条流水线 5 分钟以上，仅供深挖）。
  thinkSteps,
  thinkAll: thinkSteps.length >= 4,
  think: thinkSteps.length > 0,
  maxQueries: getNum('--max-queries', PROFILE.maxQueries),
  supplementRounds: getNum('--supplement', PROFILE.supplementRounds),
  ctx: getNum('--ctx', PROFILE.ctx),
  // Tavily 有 key 就优先用（Bing 抓取会返回泛化页面，实测不可用）
  provider: process.env.BTASK_PROVIDER || (process.env.TAVILY_API_KEY ? 'tavily' : 'bing'),
  perQueryResults: 3,
  quiet: flags.has('--quiet'),
};

const trace = {
  startedAt: new Date().toISOString(),
  question: Q,
  config: CFG,
  steps: [],
  searches: [],
  warnings: [],
};

// ---------- 检索禁区（实测得出，见 btask/CAPABILITY.md）----------
let LIMITS = { categories: [], blockedQueryPatterns: [] };
try {
  LIMITS = JSON.parse(fs.readFileSync(path.join(HERE, 'limits.json'), 'utf8'));
} catch {
  /* 没有 limits.json 就退化为无限制 */
}
const CAT = LIMITS.categories.find((c) => (c.match || []).some((m) => Q.includes(m))) || null;
const SKIP_SEARCH = CAT?.action === 'skip-search';
const BLOCKED = new Set((LIMITS.blockedQueryPatterns || []).map((s) => s));
trace.category = CAT ? { id: CAT.id, action: CAT.action, why: CAT.why } : null;

const log = (...a) => { if (!CFG.quiet) console.log(...a); };
const t0 = Date.now();

// --dry-run：只打印解析结果，不调用模型（改完 profile 后的零成本验收手段，不会挤掉 A 档）
if (flags.has('--dry-run')) {
  // 与 profile 默认值逐项比对，明确标出被显式 flag 覆盖的项，避免误读
  const diffs = [];
  if (CFG.model !== PROFILE.model) diffs.push(`model=${CFG.model}`);
  if (CFG.maxQueries !== PROFILE.maxQueries) diffs.push(`max-queries=${CFG.maxQueries}`);
  if (CFG.supplementRounds !== PROFILE.supplementRounds) diffs.push(`supplement=${CFG.supplementRounds}`);
  if (CFG.ctx !== PROFILE.ctx) diffs.push(`ctx=${CFG.ctx}`);
  if (thinkSteps.join(',') !== PROFILE.thinkSteps.join(',')) diffs.push(`thinkSteps=${thinkSteps.join('+') || '关'}`);
  console.log('=== 模式解析（dry-run，未调用模型）===');
  console.log(`模式    ：${PROFILE_NAME} — ${PROFILE.desc}`);
  console.log(`问题    ：${Q || '（未提供，仅验证参数）'}`);
  console.log(`模型    ：${CFG.model}`);
  console.log(`思考    ：${CFG.think ? '开' : '关'}（步位：${CFG.thinkSteps.join(', ') || '-'}）`);
  console.log(`检索    ：max-queries ${CFG.maxQueries}｜supplement ${CFG.supplementRounds}｜ctx ${CFG.ctx}｜源 ${CFG.provider}`);
  console.log(`类别    ：${CAT ? `${CAT.id}（${CAT.action}）` : '未命中禁区'}`);
  console.log(`预计耗时：${PROFILE.expectSec}s`);
  console.log(`覆盖    ：${diffs.length ? diffs.join('、') : '无（全部沿用 profile 默认）'}`);
  console.log(`备注    ：${PROFILE.note}`);
  process.exit(0);
}

// ---------- 模型调用 ----------
async function ask(step, system, user, opts = {}) {
  const numPredict = opts.numPredict || 400;
  const stage = String(step).split(':')[0];
  const think = opts.think ?? (CFG.think && CFG.thinkSteps.includes(stage));
  // 关键：num_predict 是"思考 + 正文"的总预算。
  // 实测 4B 的思考能写到 7000+ 字，预算给小了正文就空；开思考时直接给到 6000。
  const budget = think ? Math.max(numPredict * 8, 6000) : numPredict;
  const started = Date.now();
  const body = {
    model: CFG.model,
    stream: false,
    think,
    keep_alive: '5m',
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
    ],
    options: { num_ctx: CFG.ctx, num_predict: budget, temperature: opts.temperature ?? 0.3 },
  };
  let r = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((x) => x.json());

  let content = (r.message?.content || '').trim();
  let thinking = (r.message?.thinking || '').trim();
  let retried = false;

  // Qwen3 系常见坑：思考有内容、正文为空 → 关掉思考重试一次
  if (!content && think) {
    retried = true;
    trace.warnings.push(`${step}: 开思考时正文为空，已用 think:false 重试`);
    r = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, think: false, options: { ...body.options, num_predict: numPredict } }),
    }).then((x) => x.json());
    content = (r.message?.content || '').trim();
    thinking = thinking || (r.message?.thinking || '').trim();
  }

  const rec = {
    step,
    think,
    retried,
    ms: Date.now() - started,
    promptChars: (system?.length || 0) + user.length,
    thinking,
    output: content,
  };
  trace.steps.push(rec);
  log(`  [${step}] ${rec.ms}ms · 思考 ${[...thinking].length} 字 · 输出 ${[...content].length} 字${retried ? ' (已降级重试)' : ''}`);
  return content;
}

// ---------- 工具 ----------
function parseLines(text, { max = 6, minLen = 3, maxLen = 60 } = {}) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    let s = raw.trim()
      .replace(/^[-*•\d]+[.)、:：]?\s*/, '')
      .replace(/^查询[:：]\s*/, '')
      .replace(/^["'「『]|["'」』]$/g, '')
      .trim();
    if (!s) continue;
    if (/^(ok|没问题|无|没有|无需|none)/i.test(s) && s.length < 12) continue;
    if (s.length < minLen || s.length > maxLen) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

const searched = new Set();
function cleanQuery(q) {
  return String(q || '')
    .replace(/["“”'「」『』]/g, '')
    .replace(/[。！？!?；;，,]$/g, '')
    .replace(/^(建议)?(补充)?搜索(词|查询)?[:：]\s*/, '')
    .trim()
    .slice(0, 40);
}

async function searchOne(query) {
  const q = cleanQuery(query);
  if (!q) return [];
  if ([...BLOCKED].some((b) => q.includes(b))) {
    log(`  [search] 「${q}」 命中禁区，跳过`);
    trace.searches.push({ query: q, skipped: 'blocked-pattern' });
    return [];
  }
  if (searched.has(q)) {
    log(`  [search] 「${q}」 已搜过，跳过`);
    return [];
  }
  searched.add(q);

  let r = await webSearch(q, {
    provider: CFG.provider,
    fallbackProvider: 'bing',
    maxResults: CFG.perQueryResults,
    minSnippetChars: 30,
    timeoutMs: 8000,
    cacheTtlMs: 300000,
  });
  let items = (r.items || []).slice(0, CFG.perQueryResults).map((x) => ({
    title: String(x.title || '').slice(0, 80),
    snippet: String(x.snippet || '').slice(0, 300),
    url: String(x.url || '').slice(0, 120),
  }));

  // 长查询容易搜不到，退化到前 12 个字再试一次
  if (!items.length && q.length > 12) {
    const short = cleanQuery(q.slice(0, 12));
    if (short && !searched.has(short)) {
      searched.add(short);
      const r2 = await webSearch(short, {
        provider: CFG.provider,
        fallbackProvider: 'bing',
        maxResults: CFG.perQueryResults,
        minSnippetChars: 30,
        timeoutMs: 8000,
      });
      items = (r2.items || []).slice(0, CFG.perQueryResults).map((x) => ({
        title: String(x.title || '').slice(0, 80),
        snippet: String(x.snippet || '').slice(0, 300),
        url: String(x.url || '').slice(0, 120),
      }));
      r = { ...r2, provider: r2.provider + '(短查询)' };
    }
  }

  trace.searches.push({ query: q, provider: r.provider, ok: r.ok, err: r.err || null, kept: items.length, items });
  log(`  [search] 「${q}」 → ${r.provider} ${items.length} 条${r.err ? ' err=' + r.err : ''}`);
  return items;
}

function renderItems(items) {
  return items.map((x, i) => `${i + 1}. ${x.title}\n   ${x.snippet}`).join('\n');
}

// ---------- 流程 ----------
const SYSTEM_PLAN = '你是任务助手，可以调用搜索引擎。你不直接回答，只负责决定要查什么。';
const SYSTEM_EXTRACT = '你是资料提炼员。只提取与问题直接相关的事实，保留数字、日期、单位、专有名词。不要推测，不要补充常识。';
const SYSTEM_CHECK = '你是事实核查员。你只做检查，不做回答。';
const SYSTEM_FINAL = '你是任务助手。基于给定事实回答问题，先给结论再给依据。事实不足就说明不足，不要编造。';

// 跑完把 A 档模型拉回显存：OLLAMA_MAX_LOADED_MODELS=1，B 档会把 chat 模型挤出去
async function rewarmA() {
  const warm = process.env.BTASK_WARM_MODEL ?? 'qwen3.5:4b-chat';
  if (process.env.BTASK_NO_REWARM === '1' || CFG.model === warm) return;
  const OLLAMA = 'http://127.0.0.1:11434';
  try {
    // MAX_LOADED_MODELS=1 时旧模型的 keep_alive:-1 不退让：直接 warm 会被旧模型
    // "吃掉"（请求返回 200，但显存里仍是旧模型，A 档照样冷启动）。
    // 所以先把占显存的其它模型卸载，再拉热 A 档。
    const ps = await (await fetch(`${OLLAMA}/api/ps`)).json().catch(() => null);
    for (const m of ps?.models ?? []) {
      const name = m.name ?? m.model;
      if (!name || name === warm) continue;
      await fetch(`${OLLAMA}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: name, prompt: '', stream: false, keep_alive: 0 }),
      }).catch(() => {});
    }
    await fetch(`${OLLAMA}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: warm,
        prompt: '你好',
        stream: false,
        think: false,
        keep_alive: -1,
        options: { num_predict: 1 },
      }),
    });
    log(`  [warm] 已把 ${warm} 拉回显存（避免 A 档冷启动）`);
  } catch {
    /* 拉不回来也不影响本次结果 */
  }
}

async function saveAndReport(answer, round = 0) {
  await rewarmA();
  trace.finishedAt = new Date().toISOString();
  trace.elapsedMs = Date.now() - t0;
  trace.answer = answer;

  fs.mkdirSync(TRACE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(TRACE_DIR, `${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(trace, null, 2));

  console.log(`\n=== 回答 ===\n${answer || '（空）'}\n`);
  console.log('=== 统计 ===');
  console.log(
    `耗时 ${(trace.elapsedMs / 1000).toFixed(1)}s｜搜索 ${trace.searches.length} 次｜模型调用 ${trace.steps.length} 次｜补充轮 ${round}` +
      (CAT ? `｜类别 ${CAT.id}(${CAT.action})` : '')
  );
  if (trace.warnings.length) console.log(`警告：${trace.warnings.join('；')}`);
  console.log(`轨迹：${file}`);
}

async function main() {
  log(`\n=== B 档流水线 ===\n模式：${PROFILE_NAME}（${PROFILE.desc}）\n问题：${Q}\n模型：${CFG.model}｜思考：${CFG.think ? `开(${CFG.thinkSteps.join('+')})` : '关'}｜搜索源：${CFG.provider}${CAT ? `｜类别：${CAT.id}` : ''}\n`);

  // 禁区：直接回答，不检索（本地状态 / 纯计算）
  if (SKIP_SEARCH) {
    log(`[跳过检索] ${CAT.desc || CAT.id}：${CAT.why || ''}`);
    const p = [
      `问题：${Q}`,
      '',
      `本问题被判定为「不需要检索或检索无效」：${CAT.why || ''}`,
      CAT.hint ? `参考做法：${CAT.hint}` : '',
      '',
      '请直接回答，不超过 120 字。',
      '只给最终答案和必要依据（计算题给一行算式），不要复述推理过程，**不要出现"修正结论""此处计算有误"这类自我怀疑的表述**。',
      '如果你确实无法得知（例如本机状态），就明确说无法获取，并给出可用的本地命令，不要编造数据。',
    ]
      .filter(Boolean)
      .join('\n');
    const answer = await ask('direct', SYSTEM_FINAL, p, { numPredict: 300, temperature: 0.3 });
    await saveAndReport(answer, 0);
    return;
  }

  // ① 规划
  log('[1/6] 规划要搜什么');
  const planPrompt = [
    `问题：${Q}`,
    '',
    `请列出为了回答它需要搜索的查询，最多 ${CFG.maxQueries} 条，每行一条。`,
    '要求：',
    '- 查询要短（不超过 20 字），像搜索引擎输入框里会打的那种',
    '- 覆盖不同角度，不要重复',
    '已知这些类型的查询在这个环境里检索不到，不要列：',
    `  ${(LIMITS.blockedQueryPatterns || []).join('、') || '（无）'}`,
    CAT ? `本问题属于「${CAT.desc}」，特别注意：${CAT.why}` : '',
    '- 只输出查询本身，不要编号、不要解释',
  ]
    .filter(Boolean)
    .join('\n');
  let queries = parseLines(await ask('plan', SYSTEM_PLAN, planPrompt, { numPredict: 200, temperature: 0.4 }), {
    max: CFG.maxQueries,
  });
  if (!queries.length) {
    queries = [Q.slice(0, 30)];
    trace.warnings.push('plan 未产出有效查询，退化为直接用原问题搜索');
  }
  // 过滤禁区查询词：明知道搜不到的，不让它浪费轮次
  const before = queries.length;
  queries = queries.filter((q) => ![...BLOCKED].some((b) => q.includes(b)));
  if (queries.length < before) {
    trace.warnings.push(`已过滤 ${before - queries.length} 条禁区查询`);
    log(`  过滤禁区查询 ${before - queries.length} 条`);
  }
  if (!queries.length) {
    queries = [Q.slice(0, 24)];
    trace.warnings.push('查询全部命中禁区，退化用原问题前 24 字');
  }
  log(`  查询：${queries.map((q) => `「${q}」`).join(' ')}`);

  // ②③ 检索 + 压缩
  const facts = [];
  async function searchAndExtract(qs, tag) {
    for (const q of qs) {
      const items = await searchOne(q);
      if (!items.length) {
        facts.push({ query: q, text: `（「${q}」没有检索到结果）` });
        continue;
      }
      const extractPrompt = [
        `问题：${Q}`,
        `搜索词：${q}`,
        '',
        '以下是搜索结果：',
        renderItems(items),
        '',
        '请只输出与问题直接相关的事实，每条一行，最多 5 行。没有相关内容就输出「无关」。',
      ].join('\n');
      const factsText = await ask(`extract:${tag}`, SYSTEM_EXTRACT, extractPrompt, { numPredict: 300, temperature: 0.2 });
      facts.push({ query: q, text: factsText || '（未提炼出内容）' });
    }
  }

  log('\n[2/6] 检索');
  log('\n[3/6] 逐条压缩成事实');
  await searchAndExtract(queries, 'first');

  // ④ 核查（含补充轮）
  function renderFacts(list) {
    return list.map((f, i) => `[${i + 1}] 来自「${f.query}」\n${f.text}`).join('\n\n');
  }

  let round = 0;
  while (true) {
    log(`\n[4/6] 核查（第 ${round + 1} 轮）`);
    const checkPrompt = [
      `问题：${Q}`,
      '',
      '已掌握的事实：',
      renderFacts(facts),
      '',
      '请检查两点：事实之间有没有矛盾；有没有缺失关键信息。',
      '严格只输出下面两种格式之一，不要解释、不要编号、不要照抄下面的占位符：',
      '  格式A（没问题）：OK',
      '  格式B（要补搜）：补充：真实查询词1 | 真实查询词2',
      '注意：格式B 里的“真实查询词”必须是你自己想出来的具体搜索词（例如“Python 3.13 新特性”），不能写“查询一/查询二”这种占位文字。',
    ].join('\n');
    const verdict = await ask(`check:${round + 1}`, SYSTEM_CHECK, checkPrompt, { numPredict: 300, temperature: 0.2 });

    const m = String(verdict).match(/补充[:：]\s*(.+)/);
    let extra = [];
    if (m) {
      extra = m[1].split(/[|｜;；、,，]/).map((s) => cleanQuery(s)).filter((s) => s.length >= 2 && s.length <= 40).slice(0, 2);
    }
    const isOk = !extra.length && /(^|\n)\s*OK\b/i.test(verdict);

    if (isOk) {
      log('  核查通过');
      break;
    }
    if (!extra.length) {
      log(`  核查无明确结论，按"通过"处理（输出：${String(verdict).slice(0, 40)}）`);
      trace.warnings.push(`check:${round + 1} 输出未按格式，已按通过处理`);
      break;
    }
    if (round >= CFG.supplementRounds) {
      log('  已达补充上限');
      break;
    }
    log(`  需要补充：${extra.map((q) => `「${q}」`).join(' ')}`);
    round += 1;
    log(`\n[5/6] 补充检索（第 ${round} 轮）`);
    await searchAndExtract(extra, `supp${round}`);
  }

  // ⑥ 总结
  log('\n[6/6] 总结');
  const finalPrompt = [
    `问题：${Q}`,
    '',
    '可用事实：',
    renderFacts(facts),
    '',
    '请回答，要求：',
    '- 不超过 200 字，先给结论，再给 1~3 条依据',
    '- 每个数字、型号、结论都必须能在"可用事实"里找到原文依据',
    '- 事实没提到的事，就直接说"资料未提及"，**不要把"没提到"当成"不存在"**，更不要由缺失推出否定结论',
    '- 不要编号列表，不要复述问题',
    CAT?.hint ? `- 本问题属于「${CAT.desc}」：${CAT.hint}` : '',
    CAT?.action === 'search-with-freshness'
      ? `- 必须点明事实里的日期；若不是今天（${new Date().toISOString().slice(0, 10)}），要说"数据日期为 X，可能不是当前时点"`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  const answer = await ask('final', SYSTEM_FINAL, finalPrompt, { numPredict: 600, temperature: 0.3 });

  trace.queries = queries;
  trace.facts = facts;
  await saveAndReport(answer, round);
}

main().catch((e) => {
  console.error('[btask] 失败:', e?.stack || e);
  process.exit(1);
});
