#!/usr/bin/env bash
# 顺序拉取候选模型，每个单独日志，失败不中断
i=0
for m in qwen3:4b-instruct-2507 qwen2.5:3b llama3.2:3b gemma3:4b; do
  i=$((i + 1))
  echo "=== start $m $(date +%H:%M:%S) ==="
  if timeout 1500 ollama pull "$m" > "/tmp/pull-$i.log" 2>&1; then
    echo "[OK] $m $(date +%H:%M:%S)"
  else
    echo "[FAIL] $m $(date +%H:%M:%S) — $(tail -2 /tmp/pull-$i.log | tr '\n' ' ')"
  fi
done
echo ALLDONE
