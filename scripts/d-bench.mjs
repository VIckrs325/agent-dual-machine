#!/usr/bin/env node
/**
 * D 档 —— 极限效率实验室
 *
 * 目的：把一个模型/端点的"真实上限"量出来，而不是看参数猜。
 *
 * 测什么：
 *   1. 冷加载耗时（load_duration）
 *   2. prefill 速度（prompt_eval_count / prompt_eval_duration）
 *   3. decode 速度（eval_count / eval_duration）—— 这是体感主因
 *   4. 显存占用与 GPU 占比（ollama ps）—— 找出"溢出到 CPU"的悬崖点
 *   5. 并发吞吐（1/2/4 路并发时的聚合 tok/s）
 *   6. 思考模型额外记录 thinking 长度（R1 系会把 token 烧在推理上）
 *
 * 用法：
 *   node scripts/d-bench.mjs --models deepseek-r1:7b,ds7b:latest --ctxs 8192,16384,32768
 *   node scripts/d-bench.mjs --models qwen3.5:4b --conc 1,2,4 --ctxs 16384
 *
 * 也支持 OpenAI 兼容端点（以后接云端 DeepSeek）：
 *   DEEPSEEK_API_KEY=sk-... node scripts/d-bench.mjs --base https://api.deepseek.com --models deepseek-chat
 */

const args = process.argv.slice(2);
const opt = { base: 'http://127.0.0.1:11434', models: '', ctxs: '8192,16384,32768', conc: '', tokens: 64, timeoutMs: 180000 };
for (let i = 0; i < args.length; i += 2) {
  const k = args[i].replace(/^--/, '');
  if (k in opt) opt[k] = args[i + 1];
}

const MODELS = String(opt.models).split(',').filter(Boolean);
const CTXS = String(opt.ctxs).split(',').map(Number).filter(Boolean);
const CONC = String(opt.conc || '').split(',').map(Number).filter(Boolean);
const TOKENS = Number(opt.tokens);
const isCloud = /deepseek\.com|openai/.test(opt.base);
const KEY = process.env.DEEPSEEK_API_KEY || '';

if (!MODELS.length) {
  console.error('用法: node scripts/d-bench.mjs --models <a,b> [--ctxs 8192,16384] [--conc 1,2,4]');
  process.exit(2);
}

const PROMPT = '用三句话解释：为什么小模型在长上下文下会变慢。';

function body(model, numCtx, stream = false) {
  if (isCloud) {
    return {
      url: opt.base.replace(/\/$/, '') + '/chat/completions',
      json: {
        model,
        messages: [{ role: 'user', content: PROMPT }],
        max_tokens: TOKENS,
        stream,
        temperature: 0.2,
      },
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    };
  }
  return {
    url: opt.base.replace(/\/$/, '') + '/api/generate',
    json: { model, prompt: PROMPT, stream: false, think: false, keep_alive: '5m', options: { num_ctx: numCtx, num_predict: TOKENS, temperature: 0.2 } },
    headers: { 'content-type': 'application/json' },
  };
}

async function runOne(model, numCtx) {
  const b = body(model, numCtx);
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(opt.timeoutMs));
  try {
    const r = await fetch(b.url, { method: 'POST', headers: b.headers, body: JSON.stringify(b.json), signal: ctrl.signal }).then((x) => x.json());
    const wall = Date.now() - t0;
    if (isCloud) {
      const u = r.usage || {};
      const txt = r.choices?.[0]?.message?.content || '';
      return { wall, gen: u.completion_tokens || 0, pre: u.prompt_tokens || 0, genMs: null, preMs: null, text: txt, extra: '' };
    }
    const think = r.thinking || '';
    return {
      wall,
      loadMs: (r.load_duration || 0) / 1e6,
      pre: r.prompt_eval_count || 0,
      preMs: (r.prompt_eval_duration || 0) / 1e6,
      gen: r.eval_count || 0,
      genMs: (r.eval_duration || 0) / 1e6,
      thinkChars: think.length,
      text: r.response || '',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function psOf(model) {
  if (isCloud) return null;
  try {
    const j = await fetch(opt.base.replace(/\/$/, '') + '/api/ps').then((x) => x.json());
    const m = (j.models || []).find((x) => x.name === model || x.model === model);
    if (!m) return null;
    return { sizeGB: +(m.size / 1e9).toFixed(2), vramGB: +(m.size_vram / 1e9).toFixed(2), gpuPct: m.size ? Math.round((m.size_vram / m.size) * 100) : null, ctx: m.context_length };
  } catch {
    return null;
  }
}

const tps = (n, ms) => (ms > 0 ? +(n / (ms / 1000)).toFixed(1) : null);

console.log(`# D 档压测  端点=${opt.base}  模型=${MODELS.join(',')}  ctx=${CTXS.join('/')}  tokens=${TOKENS}`);
console.log('model\tctx\tload(ms)\tprefill(tok/s)\tdecode(tok/s)\t生成 tok\t显存(GB)\tGPU%');

const rows = [];
for (const m of MODELS) {
  for (const c of CTXS) {
    const r = await runOne(m, c);
    const ps = await psOf(m);
    rows.push({ m, c, r, ps });
    console.log(
      [
        m,
        c,
        r.loadMs != null ? Math.round(r.loadMs) : '-',
        tps(r.pre, r.preMs) ?? '-',
        tps(r.gen, r.genMs) ?? (r.wall ? tps(r.gen, r.wall) : '-'),
        r.gen,
        ps?.sizeGB ?? '-',
        ps?.gpuPct ?? '-',
      ].join('\t')
    );
    if (r.thinkChars) console.log(`\t↑ thinking ${r.thinkChars} 字（这部分也算在耗时里）`);
  }
}

if (CONC.length) {
  const m = MODELS[0];
  const c = CTXS[0];
  console.log('\n# 并发吞吐（同一模型/上下文，看聚合 tok/s 是否随并发上升）');
  console.log('并发\t总耗时(s)\t聚合 tok/s\t单请求平均 tok/s');
  for (const n of CONC) {
    const t0 = Date.now();
    const rs = await Promise.all(Array.from({ length: n }, () => runOne(m, c)));
    const wall = (Date.now() - t0) / 1000;
    const totalTok = rs.reduce((s, x) => s + (x.gen || 0), 0);
    console.log([n, wall.toFixed(1), tps(totalTok, wall * 1000), (totalTok / wall / n).toFixed(1)].join('\t'));
  }
}

// 汇总：找 decode 速度最高的配置
const best = rows
  .filter((x) => x.r.genMs)
  .sort((a, b) => b.r.gen / b.r.genMs - a.r.gen / a.r.genMs)[0];
if (best) {
  console.log(`\n最优：${best.m} @ ctx ${best.c} → ${tps(best.r.gen, best.r.genMs)} tok/s，显存 ${best.ps?.sizeGB ?? '?'}GB（GPU ${best.ps?.gpuPct ?? '?'}%）`);
}
