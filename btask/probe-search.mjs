// 探测搜索层：同一个 query 的原始条数 vs 过滤后条数
import { webSearch } from '../bridge/search.mjs';

const queries = process.argv.slice(2);
if (!queries.length) queries.push('Python 3.13 新特性');

for (const q of queries) {
  const provider = process.env.BTASK_PROVIDER || 'bing';
  const r = await webSearch(q, {
    provider,
    fallbackProvider: 'bing',
    maxResults: 5,
    minSnippetChars: 30,
    timeoutMs: 10000,
  });
  console.log(`\n查询「${q}」 ok=${r.ok} raw=${r.raw ?? '-'} kept=${r.items.length} err=${r.err || '-'}`);
  for (const it of r.items.slice(0, 3)) {
    console.log(`  - ${String(it.title).slice(0, 50)}`);
    console.log(`    ${String(it.snippet).slice(0, 100)}`);
  }
}
