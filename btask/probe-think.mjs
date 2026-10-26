// 探测：Qwen3.5 4B 开思考时，num_predict 是否把"思考"和"正文"一起算
const model = process.argv[2] || 'qwen3.5:4b';
const cases = [
  { think: true, numPredict: 300 },
  { think: true, numPredict: 1200 },
  { think: true, numPredict: 2000 },
];

for (const c of cases) {
  const t0 = Date.now();
  const r = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      think: c.think,
      keep_alive: '5m',
      messages: [{ role: 'user', content: '用三句话解释什么是向量数据库。' }],
      options: { num_ctx: 8192, num_predict: c.numPredict, temperature: 0.3 },
    }),
  }).then((x) => x.json());

  const think = r.message?.thinking || '';
  const content = r.message?.content || '';
  console.log(
    `think=${c.think} num_predict=${c.numPredict} → 思考 ${[...think].length} 字 / 正文 ${[...content].length} 字 / ${Date.now() - t0}ms / eval=${r.eval_count || 0}`
  );
  if (content) console.log('  正文前 60:', content.trim().slice(0, 60).replace(/\n/g, ' '));
}
