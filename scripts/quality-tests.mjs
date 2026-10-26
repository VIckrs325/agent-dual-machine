#!/usr/bin/env node
/**
 * 质量冒烟测试：6 道可验证的题，用来快速判断一个模型"能不能干活"。
 *
 * 用法：
 *   node scripts/quality-tests.mjs <model> [--think]
 *
 * 题目覆盖：算术 / 逻辑 / 代码 / 摘要 / 自动化脚本 / 数据聚合。
 * 每题都有人工可核对的正确答案，别只看流畅度。
 */

const model = process.argv[2];
const think = process.argv.includes('--think');
if (!model) {
  console.error('用法: node scripts/quality-tests.mjs <model> [--think]');
  process.exit(2);
}

const TASKS = [
  ['算术', '一箱饮料12瓶，每瓶3.5元。买8箱打九折，一共多少钱？只给最终数字和一行算式。', '302.4'],
  ['鸡兔', '笼子里鸡和兔共 35 个头，94 只脚。鸡和兔各几只？只给答案和一行推理。', '鸡23 兔12'],
  ['代码', '用 Python 写函数 most_common(lst)，返回列表中出现次数最多的元素；次数相同时返回先出现的那个。只输出代码。', '逻辑正确且并列取首个'],
  ['摘要', '用不超过40个字概括：社区团购的团长通常是小区里的便利店店主或热心居民，他们负责收集订单、通知取货、处理售后。平台给团长的佣金一般在订单金额的百分之八到十，做得好的团长月入几千元。但随着平台补贴减少，不少团长因为收入下降而退出，导致部分小区出现无人接单的情况。', '≤40 字且覆盖 佣金/退出/无人接单'],
  ['脚本', '写一个 bash 脚本：扫描 ~/logs 下修改时间超过 7 天的 *.log 文件，用 gzip 压缩，最后打印压缩了几个文件。只输出脚本。', '计数只算本次压缩的，且检查目录'],
  ['聚合', '给定文本，按类别求和并降序输出：\n苹果 3\n香蕉 5\n苹果 2\n橙子 7\n香蕉 1\n只输出结果行。', '橙子7 香蕉6 苹果5'],
];

const t0all = Date.now();
for (const [name, prompt, expect] of TASKS) {
  const t0 = Date.now();
  try {
    const r = await fetch('http://127.0.0.1:11434/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        think,
        keep_alive: '5m',
        options: { num_ctx: 8192, num_predict: 700, temperature: 0.2 },
      }),
    }).then((x) => x.json());
    const sec = Math.round((Date.now() - t0) / 1000);
    const ans = (r.response || '').trim().replace(/\n+/g, ' ');
    console.log(`### ${name} [${sec}s, ${r.eval_count || 0} tok] 期望: ${expect}`);
    if (r.thinking) console.log(`  [thinking ${[...r.thinking].length} 字] ${r.thinking.replace(/\n+/g, ' ').slice(0, 200)}`);
    console.log(`  ${ans ? ans.slice(0, 420) : '(空回答)'}`);
  } catch (e) {
    console.log(`### ${name}  调用失败: ${String(e.message || e).slice(0, 120)}`);
  }
}
console.log(`\n总耗时 ${Math.round((Date.now() - t0all) / 1000)}s`);
