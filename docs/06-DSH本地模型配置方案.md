# DSH 本地模型配置方案（含架构澄清）

> 2026-10-18 09:50　|　目标：OpenClaw 管云端 API，DSH 跑本地模型

---

## 一、架构澄清（按你的定义）

| 组件 | 定位 | 模型来源 | 你的用法 |
| --- | --- | --- | --- |
| **OpenClaw** | 管理 / 编排 / 测试层 | **DeepSeek 云端 API** | 当"控制台"用：跑测试、对比、调 prompt |
| **DSH（DeepSeek Harness）** | 本地执行 harness | **Ollama 本地模型** | 承担实际本地任务，省 token、可离线 |

> 因此之前"把 Ollama 注册进 OpenClaw 当 provider"的方案**降级为备选**（用于在 OpenClaw 里直接对比本地/云端），主线改为：**DSH 吃本地模型**。

---

## 二、DSH 现状体检（实测）

| 项 | 实测 | 判定 |
| --- | --- | --- |
| `dsh` 命令 | PATH 中不存在 | 需 `npx -y @deepseek-ai/dsh` 运行（v0.2.0-rc.2） |
| 运行进程 | 无 | 未常驻 |
| 监听端口 | 无 DSH 端口（仅 22 / 11434 / 18789 / 631） | 未在跑 |
| `~/.dsh/profiles/web/` | 有 `package.json` / `cordis.yml` / `cordis.patch.yml` | 脚手架已生成 |
| `package.json` 的 `dependencies` | **空** | 运行时包未安装（首启会拉） |
| `~/.dsh/settings.yaml` | **不存在** | 未做声明式配置 |
| `.credentials.yaml` | 只有 `refs.DEEPSEEK_API_KEY` | 仅云端凭据，**无本地 provider** |
| 默认模型 | `provider: deepseek-official` / `model: deepseek-flash` | 原本走云端 |

**结论：DSH 是"初始化过、但没真正装起来"的状态，且默认指向云端。**

---

## 三、本地模型实测（含你问的原版 R1）

| 模型 | 32k 速度 | 三用例表现 | 结论 |
| --- | --- | --- | --- |
| `qwen3.5:4b` | **56.8 tok/s** | 3.2s / 16.3s / 2.7s，全部直接给答案 | ✅ **首选** |
| Q3_K_M（7B） | 19.0 tok/s | 先"想" 1,523 字符，42s 才出答案 | ⚠️ 可用但慢 |
| `deepseek-r1:7b`（原版） | **14.3 tok/s** | 先"想" **4,299 字符**，132s 才出答案 | ❌ 不可用 |
| `ds7b:latest` | 28.9 tok/s | 700 token 全烧在 `<think>`，无输出 | ❌ 淘汰 |

### 关键结论

1. **原版 R1 不是"不会答"，是"话太多"**：给 2,500 token 预算后能出正确答案，但要先输出 4,299 字符的思考，耗时 132 秒。
2. `think: false` 对原版 R1 **无效**（它们把 `<think>` 当正文写），只有 `qwen3.5:4b` 支持真正的 thinking 开关。
3. 同为 7B  distill，Q3_K_M 比 `deepseek-r1:7b` 快 2.7 倍、思考短 2.8 倍 —— 说明 `deepseek-r1:7b` 那版的采样/模板配置不佳。

**所以本地只保留 `qwen3.5:4b` 作主力，其余三个仅作对照。**

---

## 四、DSH 配置本地模型（三种方式）

### 方式 A：Web UI 表单（最稳，官方推荐）

`dsh web` 启动后 → 左下角 **Settings → Models** → **Add custom provider**：

| 字段 | 填什么 | 注意 |
| --- | --- | --- |
| Provider ID | `ollama` | **小写、保存后不可改** |
| Display name | `Ollama 本地` | 可改 |
| Base URL | `http://127.0.0.1:11434/v1` | 注意末尾 `/v1` |
| API protocol | `openai-completions` | Ollama 走 OpenAI 兼容端点 |
| Credential | **留空** | 本地无需 key；留空若报 `MISSING_CREDENTIAL` 就随便填 `ollama` |
| Models | `qwen3.5:4b`, `deepseek-r1:7b` | **必须与 `ollama list` 逐字一致** |

保存后无需重启，下一条消息即生效。

### 方式 B：补丁文件（已为你打好，可版本化）

> ⚠️ **实测踩坑（10:05 修正）**：自定义 provider 必须挂在 **`llm-pi-ai`** 插件下。
> 写在 `@deepseek-ai/dsh-llm` 的 `providers` 里会运行时报
> `no adapter registered for provider "ollama"` —— 因为 `dsh-llm` 的 providers 只服务
> 内置路由（deepseek 由 `dsh-llm-deepseek` 自带 adapter），通用 OpenAI 兼容 adapter
> 是由 `dsh-llm-pi-ai` 通过 `ctx.llm.registerAdapter(routes, adapter)` 注册的。

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，在末尾追加：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      ollama:
        displayName: "Ollama 本地"
        api: openai-completions
        baseURL: "http://127.0.0.1:11434/v1"
        defaultContextWindow: 32768
        defaultMaxTokens: 2048
        models:
          - id: "qwen3.5:4b"
            name: "Qwen3.5-4B"
            contextWindow: 32768
            maxTokens: 2048
            input: [text, image]
          - id: "deepseek-r1:7b"
            name: "DeepSeek-R1-7B"
            contextWindow: 16384
            maxTokens: 2048
            input: [text]
```

再把默认模型指向本地：

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: ollama
    model: qwen3.5:4b
    reasoningEffort: low
```

字段名来自官方 schema（`dsh --dump-config-schema` 实测）：**`baseURL`（大写 URL），`api` 取值 `openai-completions`，模型条目用 `input: [text, image]`**。

> 网上两份文档分别写 `baseUrl` 和 `baseURL` —— **以 schema 为准，是 `baseURL`**。

### 方式 C：`ollama launch dsh`（官方捷径）

Ollama 0.40.6 已内置该集成（`ollama launch` 的 integrations 列表里有 `dsh  DeepSeek Harness`）。
适合"一条命令跑起来"，但可配置项少于方式 A/B，适合快速验证。

---

## 五、已为你应用的改动

| 动作 | 结果 |
| --- | --- |
| 备份原配置 | `cordis.patch.yml.bak.20261018-094736` |
| 新增 `llm.providers.ollama` | ✅ baseURL `http://127.0.0.1:11434/v1` |
| 默认模型改为本地 | ✅ `provider: ollama` / `model: qwen3.5:4b` / `reasoningEffort: low` |
| `--dump-config` 校验 | ✅ PASS（三项全部出现在合成配置里） |

### 启动与验证

```bash
# 启动（首次会通过 pnpm 拉 @deepseek-ai/dsh-base / dsh-web-app，可能要几分钟）
cd ~ && npx -y @deepseek-ai/dsh --profile web

# 或官方捷径
ollama launch dsh
```

启动后重点确认两件事：
1. 模型选择器里能看到 **Ollama 本地 / Qwen3.5-4B**；
2. 发一条消息，`ollama ps` 能看到 qwen3.5:4b 被加载（说明真的走了本地）。

### 回滚（一条命令）

```bash
cp ~/.dsh/profiles/web/cordis.patch.yml.bak.20261018-094736 \
   ~/.dsh/profiles/web/cordis.patch.yml
```

---

## 六、让 DSH 更高效利用本地的 5 条

1. **本地单独一个 profile**（最重要）
   官方也建议"local 工作放独立 profile"。建议：
   - `web` = 云端（回归你原来的 deepseek-flash）
   - `local` = 本地 ollama
   ```bash
   npx -y @deepseek-ai/dsh --from-default-profile web --profile local
   # 然后把上面的 ollama 补丁写进 profiles/local/cordis.patch.yml
   ```
   好处：换模型只改一个变量，云端/本地可并行对比，互不污染会话。

2. **上下文 32k 必须配 KV cache 量化**
   `defaultContextWindow: 32768` 已配置。但**不量化时 32k 会让约 4% 的层溢出到 CPU** —— `ollama ps` 显示 `PROCESSOR 4%/96% CPU/GPU`，于是每次新会话处理上万 token 基础提示的 **prefill 极慢**（主观感受就是"每次都在重新加载"）。加上 `OLLAMA_KV_CACHE_TYPE=q8_0` 后变 `100% GPU`，显存反而从 4782 降到 4470 MiB。

3. **不要写 `reasoningEffort`**
   手工声明的模型没有 reasoning 元数据，`getSupportedThinkingLevels()` 只返回 `["off"]`，写 `low` 会直接报
   `does not support reasoning effort "low"`。要控制思考，用 UI 的 Thinking 开关，不要写进 patch。

4. **Ollama 服务环境（实测可用配置）**

   ```ini
   # /etc/systemd/system/ollama.service.d/override.conf
   [Service]
   Environment="OLLAMA_CONTEXT_LENGTH=32768"
   Environment="OLLAMA_MAX_LOADED_MODELS=1"
   Environment="OLLAMA_KEEP_ALIVE=-1"
   Environment="OLLAMA_KV_CACHE_TYPE=q8_0"
   ```

   ```bash
   sudo systemctl daemon-reload && sudo systemctl restart ollama
   ```

   - `KEEP_ALIVE=-1` = **永不卸载**（`ollama ps` 的 UNTIL 列显示 `Forever`）
   - 若希望空闲 6 分钟后卸载：改成 `OLLAMA_KEEP_ALIVE=6m`
   - `MAX_LOADED_MODELS=1` 防止两个模型同时驻留撑爆 6GB
   - `KV_CACHE_TYPE=q8_0` 让 32k 上下文也能全显存运行

   **量化后实测**：模型 3.7 GB、显存 4470 / 6144 MiB、生成 **54.8 tok/s**、短提示 prefill 0.09s、2.7k token 长提示 prefill 1.8s、`PROCESSOR = 100% GPU`。

5. **工具集收敛**
   DSH 的工具越多，4B 选错的概率越高。本地 profile 里只保留必需工具（文件读写、命令执行），复杂工具链留给云端 profile。

---

## 七、待办

1. ✅ 首次启动 DSH，包安装完成、模型可选
2. ✅ 跑通真实任务（已确认「能用了」），`ollama ps` 为 100% GPU
3. ⬜ 建 `local` / `web` 双 profile，把云端与本地彻底分开
4. ⬜ 用同一批用例对比 OpenClaw 云端 vs DSH 本地
5. ⬜ 接 DSH 的 `llm-pi-ai` 时若再换模型，注意「三层约束」：插件归属（llm-pi-ai）、模型元数据（reasoningEfforts）、传输层鉴权（Authorization 头）
