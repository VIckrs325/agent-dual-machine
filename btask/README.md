# B 档稳定版（btask）—— 用提示词把 4B 编排成"会查会核"的任务助手

> 2026-10-20 · 首版实现，已跑通 4 个真实问题

## 0. 它是什么

一条**独立流水线**：不碰 `bridge/`，不影响 QQ 机器人。输入一个问题，输出"带依据的回答"，全过程留痕。

> **B 档只做「搜索 + 总结」，碰不到本机。** 需要读文件、写文件、执行命令、多步串行的任务
> 属于 **C 档**（DSH headless 工具调用）→ `ctask/README.md`。
> 判据：任务需不需要碰这台机器。不需要 → 本档（快、便宜）；需要 → C 档（慢、会挤显存）。

```
① 规划：让它自己列 1~4 条搜索词
② 检索：逐条搜（Tavily 优先）
③ 压缩：每条查询单独提炼成"事实"，避免塞爆上下文
④ 核查：找矛盾/缺口；有问题就列补充查询
⑤ 补充：再搜一轮、再核一次（默认上限 1 轮）
⑥ 总结：只用事实作答，事实不足就说不足
```

## 1. 怎么跑

```bash
cd ~/.openclaw/workspace/projects/agent-dual-machine

# 默认 = quick：全关思考，实测 17~30 秒
node btask/run.mjs "Python 3.13 有哪些主要新特性？"

# 冒烟：改完代码先跑这条，确认流水线没崩（8~15 秒）
node btask/run.mjs "Rust 的所有权机制是什么？" --profile smoke

# 看它怎么拆问题（只规划步开思考，150~170 秒）
node btask/run.mjs "..." --profile plan

# 深挖（全步开思考，220~350 秒）
node btask/run.mjs "..." --profile deep

# 只打印解析结果，不调模型、不占显存（改 profile 后的验收命令）
node btask/run.mjs "..." --profile deep --dry-run
```

### 四个模式

| 模式 | 思考步位 | max-queries | supplement | ctx | 实测耗时 | 用途 |
| --- | --- | --- | --- | --- | --- | --- |
| `quick`（默认） | 无 | 4 | 1 | 16384 | 17~30s | 日常问答 |
| `smoke` | 无 | 2 | 0 | 8192 | 8~15s | 改完代码的冒烟验证 |
| `plan` | plan | 3 | 0 | 16384 | 150~170s | 只看拆解思路（`--think` 等价） |
| `deep` | plan+extract+check+final | 4 | 1 | 16384 | 220~350s | 深挖（单步思考可达 4.3 万字，`--think-all` 等价） |

**显式 flag 永远覆盖 profile**，方便在预设基线上做单变量 A/B：

```bash
node btask/run.mjs "..." --profile deep --no-think         # 深挖的检索配置 + 关思考
node btask/run.mjs "..." --profile quick --max-queries 6   # 只改查询条数
```

其余可调项：`--model`（默认 `qwen3.5:4b`；换 `qwen3.5:4b-chat` 可不挤掉 A 档）、`--max-queries`、`--supplement`、`--ctx`、`--quiet`。

> **为什么不做 `btask-test/` 双轨**：B 档没有 systemd 单元，`bridge/` 里也搜不到 `btask` —— 它是纯前台 CLI，不存在"线上服务不能坏"这个前提。双轨的成本（代码同步、md5 对齐、晋级/回档脚本）在 `bridge/` 已经付过一次。模式差异用 flag 表达就够了。

## 2. 实测结果（同一台机器）

| 问题 | 模式 | 耗时 | 结果 |
| --- | --- | --- | --- |
| Python 3.13 有哪些主要新特性 | 默认 | **25.8s** | ✅ 正确（REPL、无 GIL、JIT 三条都对） |
| 同上 | `--think` | 160.3s | ✅ 更详细（补了支持期、启动快 10%、小整数内存） |
| RTX 2060 6GB vs 3060 12GB | `--think` | 323s | ⚠️ 数字对（12.7 vs 18.2 tok/s、FP32 6.45 vs 12.74 TFLOPS），但夹了"2060 12GB 跑不了任何模型"的错推论 |
| 成都今天天气 | 默认 | 8.8s | ✅ **正确地说了"资料不足"**（Bing 返回的是成都市百科） |
| Qwen3.5 发布时间 | 默认 | 8.5s | ✅ 同样正确地拒绝编造 |

**结论：能跑，但"检索质量"决定上限，不是模型。**

## 3. 三个真实踩到的坑（都已修）

### ① `num_predict` 是"思考 + 正文"的总预算

4B 开思考时，思考能写 **12941 字**。预算给 300 → 思考吃光 → 正文为空。

```js
// 修法
const budget = think ? Math.max(numPredict * 8, 6000) : numPredict;
```

即便给到 6000，**仍会截断**（12941 字超出），所以还留了一条兜底：正文为空时自动用 `think:false` 重跑一次，并在轨迹里标 `retried: true`。

### ② Bing 抓取会返回"泛化页面"

同一个 `Python 3.13 新特性`：

| 源 | 返回 |
| --- | --- |
| Bing | Python.org 首页、W3Schools 入门、PY4E —— 与 3.13 无关 |
| Tavily | 「Python 3.13 新特性解读：JIT、免 GIL、REPL」「掘金：新特性详解」—— 精准 |

**所以 B 档默认走 Tavily**（`btask/run.mjs` 会自己读 `/run/user/<uid>/qq-bridge.env`，读不到再退到 `~/.config/qq-bridge.env`，不依赖 systemd）。

> 这也意味着：**桥上的搜索如果只配 Bing，效果会很差**。这条对 L2 搜索的决策很关键。

### ③ 核查步骤的"格式漂移"

第一版让模型输出"OK / 补充：查询一 | 查询二"，它**直接照抄了占位符**，于是去搜了"查询一"。

改成严格的"格式A / 格式B"契约 + 明确禁止照抄占位符，并加了兜底：解析不出补充词就按"通过"处理，不空转。

## 4. 轨迹里存了什么（你要的记录）

每次运行写一份 `btask/traces/<时间>.json`：

```jsonc
{
  "question": "...",
  "config": { "model": "qwen3.5:4b", "think": true, "provider": "tavily", ... },
  "searches": [ { "query": "...", "provider": "tavily", "kept": 3,
                  "items": [ { "title": "...", "snippet": "...", "url": "..." } ] } ],
  "facts":    [ { "query": "...", "text": "提炼后的事实" } ],
  "steps":    [ { "step": "plan", "think": true, "retried": false,
                  "ms": 125055, "thinking": "……12941 字……", "output": "…" } ],
  "answer":   "最终回答",
  "elapsedMs": 160300,
  "warnings": ["plan: 开思考时正文为空，已用 think:false 重试"]
}
```

**搜索内容、每步输出、思考全文、耗时、降级记录**都在里面。

## 5. 已知限制

| 限制 | 说明 |
| --- | --- |
| 实时数值拿不到 | 天气/股价这类，检索源返回的是百科页而不是数值。B 档会诚实说"资料不足" |
| 思考很贵 | 4B 的思考是"英文思维链 + 反复自我检查"，动辄 1 万字；规划步一项就要 125 秒 |
| 结论仍可能过度推断 | 325 秒那次把"资料没提到"推成了"不行"。已加提示词约束，但 4B 不总能守住 |
| 与 A 档抢模型 | `OLLAMA_MAX_LOADED_MODELS=1`，跑 B 档会把 `qwen3.5:4b-chat` 挤出显存，A 档首条会慢 3~5 秒 |
| 没有并发控制 | 同时跑两个 btask 会互抢算力 |

## 6. 下一步（按性价比排序）

1. **把"思考"从生产路径里彻底拿掉**（默认已是关）。`--think` 只作排查用。
2. **规划阶段限流**：`--max-queries 3` 就够，4 条常在补充轮被重复搜到。
3. **事实卡片化**：现在 facts 是一段一段文本，改成 `{数字, 来源, 日期}` 结构，核查会更准。
4. **检索侧补专用源**：天气接 `wttr.in`，价格接电商/官方页；这是"资料不足"的主要来源。
5. **合并提取调用**：每条查询一次 LLM 调用（4 条查询 = 4 次），可合并成 1 次批量提取，省 6~9 秒。
6. **接进 QQ**：确认稳定后，作为 `task` 命令挂在 `bridge-test` 上，先影子跑。

## 7. 探针与工具索引

这些是**一次性取证脚本**，不属于常驻模块，也不参与任何双轨。想搞清楚某件事时用它们，不需要把它们改造成"功能模块"。

| 想搞清楚什么 | 用哪个 | 位置 |
| --- | --- | --- |
| 思考会不会吃掉 `num_predict` 预算、正文为什么为空 | `probe-think.mjs` | `btask/` |
| 同一 query 在 Bing / Tavily 下的原始条数 vs 过滤后条数 | `probe-search.mjs` | `btask/` |
| 舒适区/禁区扫描（8 个类别跑一遍） | `eval-suite.sh` | `btask/` |
| D 档 DeepSeek 的极限效率（含 thinking 长度） | `d-bench.mjs` | `scripts/` |
| 本地 3B/4B 模型横评 | `bench-models.mjs` | `scripts/` |
| 桥的能力开关是否还齐 | `check-bridge-features.mjs` / `check-bridge-test-features.mjs` | `scripts/` |
| 运行单元是否合规（禁 active drop-in、稳定 unit 必须指向 `bridge/`） | `check-runtime-units.mjs` | `scripts/` |
| 热调参（改完不用重启桥） | `tune.mjs` | `scripts/` |

```bash
node btask/probe-think.mjs qwen3.5:4b                        # 打 300/1200/2000 三档 num_predict
BTASK_PROVIDER=tavily node btask/probe-search.mjs "Python 3.13 新特性"
bash btask/eval-suite.sh                                     # 结果落 btask/eval-<时间>.jsonl
```

> `eval-suite.sh` 目前只**扫描**（跑 8 题、记答案和耗时、留人工判读），不做 pass/fail 断言。要升级成真正的回归测试，需要给每题加 `expect: { mustInclude, mustNotInclude, maxSec }` —— 见 `docs/23` 的后续任务。
