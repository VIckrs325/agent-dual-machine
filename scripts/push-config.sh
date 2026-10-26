#!/usr/bin/env bash
# ============================================================
# 本机（控制端）→ 算力端的配置推送脚本
# 用法：bash push-config.sh <user>@<算力端IP>
# 前置：已完成 SSH 免密
# ============================================================
set -euo pipefail

HOST="${1:?用法: bash push-config.sh <user>@<算力端IP>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "==> 目标主机: ${HOST}"

echo "==> [1/3] 推送 OpenClaw 云端版配置"
scp "$ROOT_DIR/config/openclaw.cloud.json5" "${HOST}:~/.openclaw/openclaw.json"

echo "==> [2/3] 推送环境摸底脚本"
scp "$ROOT_DIR/scripts/2060-check-env.sh" "${HOST}:~/"

echo "==> [3/3] 推送部署脚本"
scp "$ROOT_DIR/scripts/2060-deploy-openclaw.sh" "${HOST}:~/"
scp "$ROOT_DIR/scripts/2060-setup-ollama.sh" "${HOST}:~/"

echo "完成。接下来在 2060 本执行："
echo "  ssh ${HOST} 'bash ~/2060-check-env.sh'   # 先摸底"
echo "  ssh ${HOST} 'bash ~/2060-deploy-openclaw.sh'  # 再部署"
