#!/usr/bin/env bash
# ============================================================
# 2060 本部署 Ollama + 6G 显存优化的 DeepSeek-R1 7B（阶段二）
# 用法（在 2060 本 Ubuntu 上执行）：bash 2060-setup-ollama.sh
# ============================================================
set -euo pipefail

echo "==> [1/4] 安装 Ollama"
if command -v ollama >/dev/null 2>&1; then
  echo "    Ollama 已存在: $(ollama --version 2>/dev/null || echo unknown)"
else
  curl -fsSL https://ollama.com/install.sh | sh
fi

echo "==> [2/4] 启动服务并开机自启"
sudo systemctl enable --now ollama 2>/dev/null || (ollama serve &)

echo "==> [3/4] 拉取 7B 量化模型（deepseek-r1:7b 默认 Q4_K_M）"
ollama pull deepseek-r1:7b

echo "    若 6G 显存吃紧，可用 Modelfile 指定更小量化 IQ3_XS/Q3_K_M："
echo "      ollama show deepseek-r1:7b --modelfile > /tmp/Modelfile"
echo "      # 编辑 /tmp/Modelfile 的 FROM 行，改为对应量化 tag 后："
echo "      ollama create deepseek-r1:7b-iq3 -f /tmp/Modelfile"

echo "==> [4/4] 验证 OpenAI 兼容端点"
ollama list
curl -s http://127.0.0.1:11434/v1/models
echo ""
echo "完成。OpenAI 兼容端点: http://127.0.0.1:11434/v1"
echo "OpenClaw 中 provider.ollama.baseUrl 已指向该地址（见 openclaw.hybrid.json5）。"
