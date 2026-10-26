#!/usr/bin/env bash
# 舒适区扫描：按类别跑一批问题，记录答案/耗时/搜索次数，供人工判定可用性
set -u
cd "$(dirname "$0")/.."

OUT="btask/eval-$(date +%Y%m%d-%H%M%S).jsonl"
: > "$OUT"

run() {
  local id="$1"; shift
  local q="$*"
  echo "=== [$id] $q"
  local t0=$(date +%s)
  local out
  out=$(node btask/run.mjs "$q" --max-queries 3 --supplement 0 2>&1)
  local t1=$(date +%s)
  local ans
  ans=$(printf '%s' "$out" | sed -n '/=== 回答 ===/,/=== 统计 ===/p' | sed '1d;$d' | tr '\n' ' ' | sed 's/  */ /g' | cut -c1-400)
  local stat
  stat=$(printf '%s' "$out" | grep -E '^耗时 ' | head -1)
  node -e '
    const [id,q,a,st,sec] = process.argv.slice(1);
    console.log(JSON.stringify({id,q,answer:a,stat:st,sec:+sec}));
  ' "$id" "$q" "$ans" "$stat" "$((t1-t0))" >> "$OUT"
  echo "  → $ans"
}

run tech-doc     "Python 3.13 有哪些主要新特性？"
run realtime-wx  "成都今天天气怎么样？适合出门吗？"
run realtime-stk "英伟达现在股价多少？"
run product-price "RTX 2060 6GB 现在二手大概多少钱？"
run compare      "RTX 2060 6GB 和 RTX 3060 12GB 跑本地大模型差多少？"
run local-state  "这台机器现在加载了哪个模型？显存占了多少？"
run news         "最近一周有什么 AI 领域的大新闻？"
run semantic     "一件衣服原价 299 元，打八折再减 50，最后多少钱？"

echo "ALLDONE → $OUT"
