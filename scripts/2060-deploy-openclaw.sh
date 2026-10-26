#!/usr/bin/env bash
# ============================================================
# 2060 本部署 OpenClaw + DSH（阶段一：云端 DeepSeek 版）
# 用法（在 2060 本 Ubuntu 上执行）：bash 2060-deploy-openclaw.sh
# 前置：已推送 openclaw.cloud.json5 到 ~/.openclaw/openclaw.json
# ⚠️ 安装命令以 OpenClaw 官方文档为准，以下为两种主流方式。
# ============================================================
set -euo pipefail

echo "==> [1/5] 检查 Node 运行时"
if command -v node >/dev/null 2>&1; then
  echo "    Node: $(node -v)"
else
  echo "    未装 Node，安装 Node 22 ..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "==> [2/5] 安装 OpenClaw（二选一）"
if command -v openclaw >/dev/null 2>&1; then
  echo "    OpenClaw 已存在: $(openclaw --version 2>/dev/null || echo unknown)"
else
  echo "    方式A（推荐，隔离）：Docker 运行"
  echo "      docker run -d --name openclaw -v ~/.openclaw:/home/node/.openclaw -p 18789:18789 ghcr.io/openclaw/openclaw:latest"
  echo "    方式B：npm 全局安装"
  echo "      sudo npm install -g openclaw"
  echo "    → 请按官方文档选择其一安装后再重跑本脚本（脚本不做盲装以免版本不符）"
fi

echo "==> [3/5] 准备配置目录"
mkdir -p ~/.openclaw

echo "==> [4/5] 校验配置"
if [ -f ~/.openclaw/openclaw.json ]; then
  openclaw config validate 2>/dev/null && echo "    配置校验通过" || echo "    配置校验失败，请检查 openclaw.json"
else
  echo "    !! 未找到 ~/.openclaw/openclaw.json，请先运行 push-config.sh 推送"
fi

echo "==> [5/5] 启动网关"
openclaw gateway restart 2>/dev/null || echo "    请手动执行: openclaw gateway start"
echo "完成。网关默认端口 18789，健康检查: curl http://127.0.0.1:18789/healthz"
