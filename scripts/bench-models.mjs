const MODELS = process.argv.slice(2);
const BASE = 'http://127.0.0.1:11434';
const OPTS = { num_ctx: 32768, temperature: 0.3, num_predict: 96 };

async function gen(model, prompt) {
  const t0 = Date.now();
  const r = await fetch(BASE + '/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, think: false, options: OPTS }),
  }).then(x => x.json());
  const wall = Date.now() - t0;
  const genMs = (r.eval_duration || 0) / 1e6;
  const preMs = (r.prompt_eval_duration || 0) / 1e6;
  return {
    text: (r.response || '').trim(),
    tps: genMs > 0 ? (r.eval_count || 0) / (genMs / 1000) : 0,
    preMs, genMs, wall,
    evalCount: r.eval_count || 0,
  };
}

async function toolTest(model) {
  const tools = [{
    type: 'function',
    function: {
      name: 'get_weather',
      description: '查询城市天气',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  }];
  try {
    const r = await fetch(BASE + '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model, stream: false, think: false,
        messages: [{ role: 'user', content: '北京今天天气怎么样？' }],
        tools,
        options: { num_ctx: 8192, temperature: 0 },
      }),
    }).then(x => x.json());
    const tc = r.message?.tool_calls;
    return tc?.length ? 'OK:' + (tc[0].function?.name || '?') : 'no';
  } catch (e) {
    return 'err';
  }
}

for (const m of MODELS) {
  try {
    await fetch(BASE + '/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: m, prompt: 'hi', stream: false, options: { num_predict: 1 } }) });
    const a = await gen(m, '用不超过50字解释什么是 API。');
    const b = await gen(m, '把这句话改成更客气的说法：这个不行。');
    const c = await gen(m, '统计：今天处理了 12 个订单，退货 3 个，退货率是多少？只回答百分比。');
    const tool = await toolTest(m);
    const ps = await fetch(BASE + '/api/ps').then(x => x.json());
    const me = (ps.models || []).find(x => x.name === m) || {};
    console.log(JSON.stringify({
      model: m,
      tps: +a.tps.toFixed(1),
      preMs: Math.round(a.preMs),
      wallMs: a.wall,
      chars: [...a.text].length,
      apiAnswer: a.text.slice(0, 60),
      polite: b.text.slice(0, 40),
      mathAnswer: c.text.slice(0, 20),
      tool,
      vramGB: me.size ? +(me.size / 1e9).toFixed(2) : null,
      gpuPct: me.size_vram && me.size ? Math.round(me.size_vram / me.size * 100) : null,
      ctx: me.context_length || null,
    }));
  } catch (e) {
    console.log(JSON.stringify({ model: m, error: String(e.message || e) }));
  }
}
