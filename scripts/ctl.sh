#!/usr/bin/env bash
# 桥的日常控制：状态 / 重启 / 拉热 / 日志
#
#   bash scripts/ctl.sh status          # 桥状态 + 显存里的模型 + 关键配置 + 最近日志
#   bash scripts/ctl.sh restart bridge  # 只重启桥（QQ 机器人）
#   bash scripts/ctl.sh restart ollama  # 重启推理服务（可能需要 sudo）
#   bash scripts/ctl.sh restart all     # 先 ollama 再桥
#   bash scripts/ctl.sh warm            # 把 A 档模型拉回显存
#   bash scripts/ctl.sh logs 30         # 看最近 30 行日志
#   bash scripts/ctl.sh selftest        # 跑桥的自测
#   bash scripts/ctl.sh stray           # 列出非 systemd 托管的桥进程（占锁元凶）
#   bash scripts/ctl.sh kill-stray      # 清理它们（SSH 断线后遗留的手动实例）
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WARM_MODEL="${WARM_MODEL:-qwen3.5:4b-chat}"
UNIT="qq-bridge.service"

# 找出「非 systemd 托管」的桥进程。两条防护缺一不可：
#   ① argv[0] 必须是 node —— 否则 pgrep -f 会匹配到执行本命令的 bash -c 自身，把 SSH 会话杀掉；
#   ② 带 INVOCATION_ID 说明是 systemd 起的（可能属于 qq-bridge-test 单元），不算孤儿。
_stray_pids() {
  main="$(systemctl --user show "$UNIT" -p MainPID --value 2>/dev/null || true)"
  for pid in $(pgrep -f "qq-bridge.mjs" 2>/dev/null); do
    [ -d "/proc/$pid" ] || continue
    [ "$pid" = "$main" ] && continue
    a0="$(tr '\0' '\n' < "/proc/$pid/cmdline" 2>/dev/null | head -1)"
    case "$a0" in */node|node) ;; *) continue ;; esac
    tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -q '^INVOCATION_ID=' && continue
    echo "$pid"
  done
}

case "${1:-status}" in
  status)
    echo "=== 桥 ==="
    systemctl --user show "$UNIT" -p ActiveState -p MainPID -p NRestarts 2>/dev/null | tr '\n' ' '; echo
    echo "=== 显存里的模型 ==="
    ollama ps 2>/dev/null | sed '1d'
    echo "=== 关键配置（稳定版）==="
    node "$ROOT/scripts/tune.mjs" --list 2>/dev/null | sed -n '3,20p'
    echo "=== 最近日志 ==="
    journalctl --user -u "$UNIT" -n 6 --no-pager 2>/dev/null | tail -6 | cut -c1-160
    ;;

  restart)
    what="${2:-bridge}"
    if [ "$what" = "ollama" ] || [ "$what" = "all" ]; then
      echo "[ctl] 重启 ollama（系统服务，需要 sudo）"
      if sudo -n systemctl restart ollama 2>/dev/null; then
        echo "[ctl] ollama 已重启"
        sleep 3
      else
        echo "[ctl] 没有免密 sudo，请手动执行："
        echo "      sudo systemctl restart ollama"
      fi
    fi
    if [ "$what" = "bridge" ] || [ "$what" = "all" ]; then
      echo "[ctl] 重启桥"
      systemctl --user restart "$UNIT"
      sleep 2
      systemctl --user is-active --quiet "$UNIT" && echo "[ctl] 桥已启动" || echo "[ctl] 桥启动失败，看日志"
    fi
    ;;

  warm)
    echo "[ctl] 拉热 $WARM_MODEL"
    # OLLAMA_MAX_LOADED_MODELS=1 时，旧模型的 keep_alive=-1 不退让，
    # 直接 warm 会一直复用旧模型（ps 看不出来，但实际没换）。
    # 所以先把显存里其它模型停掉，再拉热目标模型。
    ollama ps 2>/dev/null | sed '1d' | awk 'NF {print $1}' | while read -r m; do
      [ "$m" = "$WARM_MODEL" ] && continue
      echo "[ctl] 先卸载占用显存的 $m"
      ollama stop "$m" >/dev/null 2>&1
    done
    curl -s -m 180 http://127.0.0.1:11434/api/generate \
      -d "{\"model\":\"$WARM_MODEL\",\"prompt\":\"你好\",\"stream\":false,\"think\":false,\"keep_alive\":-1,\"options\":{\"num_predict\":1}}" >/dev/null
    got="$(ollama ps 2>/dev/null | sed '1d' | awk 'NF {print $1}' | head -1)"
    if [ "$got" = "$WARM_MODEL" ]; then
      echo "[ctl] 已拉热 $WARM_MODEL"
    else
      echo "[ctl] 注意：显存里是 ${got:-<空>}，不是 $WARM_MODEL"
    fi
    ollama ps | sed '1d'
    ;;

  logs)
    n="${2:-30}"
    journalctl --user -u "$UNIT" -n "$n" --no-pager 2>/dev/null | cut -c1-200
    ;;

  selftest)
    cd "$ROOT/bridge" && node qq-bridge.mjs --selftest 2>&1 | tail -12
    ;;

  stray)
    echo "[ctl] 非 systemd 托管的桥进程："
    pids="$(_stray_pids)"
    if [ -z "$pids" ]; then
      echo "  （无）"
    else
      for pid in $pids; do
        echo "  pid=$pid  运行 $(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ')  $(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-110)"
      done
      echo "  清理：bash scripts/ctl.sh kill-stray"
    fi
    ;;

  kill-stray)
    pids="$(_stray_pids)"
    if [ -z "$pids" ]; then
      echo "[ctl] 没有孤儿实例"
      exit 0
    fi
    for pid in $pids; do
      echo "[ctl] SIGTERM $pid"
      kill -TERM "$pid" 2>/dev/null
    done
    sleep 2
    left="$(_stray_pids)"
    if [ -n "$left" ]; then
      for pid in $left; do
        echo "[ctl] 未退出，SIGKILL $pid"
        kill -KILL "$pid" 2>/dev/null
      done
      sleep 1
    fi
    echo "[ctl] 已清理，接着执行：systemctl --user restart qq-bridge"
    ;;

  *)
    sed -n '2,14p' "$0"
    ;;
esac
