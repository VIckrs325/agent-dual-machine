#!/usr/bin/env bash
# C 档基线：用 DSH headless 跑一组真实任务（读文件 / 写文件 / 执行命令 / 多步），记录耗时与输出
#
# 用例不写死在脚本里 —— 唯一数据源是 ctask/cases.json，改用例只改那个文件。
#
# 用法：
#   bash scripts/b-task-baseline.sh             # 跑全部
#   bash scripts/b-task-baseline.sh 4           # 只跑第 4 条
#   bash scripts/b-task-baseline.sh 4 --verify  # 强制走对账层（scripts/task-verify.mjs）
#
# 前置：ollama 在跑、qwen3.5:4b 可用、~/.dsh/profiles/headless 存在。
# 注意：headless 用的是 qwen3.5:4b（不是 4b-chat），会挤掉 A 档模型，跑完执行
#       bash scripts/ctl.sh warm 拉回来。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CASES_FILE="$ROOT/ctask/cases.json"
TIMEOUT="${TASK_TIMEOUT_SEC:-420}"
FORCE_VERIFY=0
idx=""

for a in "$@"; do
  case "$a" in
    --verify) FORCE_VERIFY=1 ;;
    ''|*[!0-9]*) echo "未知参数: $a" >&2; exit 2 ;;
    *) idx="$a" ;;
  esac
done

if [ ! -f "$CASES_FILE" ]; then
  echo "找不到用例文件: $CASES_FILE" >&2
  exit 2
fi

# 从 cases.json 读成 TSV（id \t name \t verify \t task）
read_cases() {
  node -e '
    const fs = require("fs");
    const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const x of c.cases) console.log([x.id, x.name, x.verify ? 1 : 0, x.task].join("\t"));
  ' "$CASES_FILE"
}

CASES_TSV="$(read_cases)" || { echo "解析 cases.json 失败" >&2; exit 2; }
TOTAL_CASES=$(printf '%s\n' "$CASES_TSV" | grep -c . || true)
PROFILE_NAME=$(node -e 'console.log(require(process.argv[1]).profile)' "$CASES_FILE")
MODEL_NAME=$(node -e 'console.log(require(process.argv[1]).model)' "$CASES_FILE")

echo "===== C 档基线（$TOTAL_CASES 条用例，profile=$PROFILE_NAME，模型=$MODEL_NAME）====="
echo

total=0
passed=0
failed=0
ran=0

while IFS=$'\t' read -r id name verify task; do
  [ -z "${id:-}" ] && continue
  [ -n "$idx" ] && [ "$idx" != "$id" ] && continue

  ran=$((ran + 1))
  echo "===== [$id] $name ====="
  echo "任务: $task"

  start=$(date +%s)
  if [ "$FORCE_VERIFY" = "1" ] || [ "$verify" = "1" ]; then
    echo "模式: 对账层（scripts/task-verify.mjs）"
    out=$(timeout "$TIMEOUT" node "$ROOT/scripts/task-verify.mjs" "$task" 2>&1 | tail -8)
    rc=$?
  else
    echo "模式: 直接执行（npx dsh --profile $PROFILE_NAME）"
    out=$(timeout "$TIMEOUT" npx -y @deepseek-ai/dsh --profile "$PROFILE_NAME" "$task" 2>/dev/null | tail -6)
    rc=0
  fi
  end=$(date +%s)
  dur=$((end - start))

  echo "耗时: ${dur}s"
  echo "输出:"
  echo "$out"
  if [ "$rc" -ne 0 ]; then
    echo "判定: ✗ 失败/不一致（退出码 $rc）"
    failed=$((failed + 1))
  elif [ "$FORCE_VERIFY" = "1" ] || [ "$verify" = "1" ]; then
    echo "判定: ✓ 对账通过"
    passed=$((passed + 1))
  fi
  echo
  total=$((total + dur))
done <<< "$CASES_TSV"

if [ "$ran" -eq 0 ]; then
  echo "没有匹配的用例（id=$idx，共 $TOTAL_CASES 条）" >&2
  exit 2
fi

echo "===== 汇总 ====="
echo "跑了 ${ran} 条，总耗时: ${total}s"
if [ "$FORCE_VERIFY" = "1" ] || printf '%s\n' "$CASES_TSV" | grep -q $'\t1\t'; then
  echo "对账结果: 通过 ${passed} / 失败 ${failed}"
fi
echo
echo "提醒: 实测 headless 与 A 档是同一个模型 blob，不互斥；ollama ps 里 ctx=4096 是"
echo "      桥的 DEFAULTS.numCtx，属正常，不是被本脚本改坏。"
