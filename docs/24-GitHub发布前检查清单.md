# 24 — 推上 GitHub 之前要做什么

> 2026-10-22 00:40 · 首次盘查。当前 `agent-dual-machine/` **还没有 `.git`**。

## 0. 结论先说

**现在是最好的时机。** 还没初始化仓库，意味着**没有历史需要重写**。
一旦把带密钥的提交推上去，即使后来删掉，它仍留在 history 里（GitHub 会一直能查到），
只能靠 `git filter-repo` 洗历史 + 强推 + 假定已泄露去轮换密钥。

所以：**先把内容洗干净，再 `git init`。** 顺序反了成本高一个量级。

---

## 1. 盘查结果（2026-10-22 实测）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| `.git` | ❌ 不存在 | 全新，无历史包袱 |
| 真实凭据 | ✅ **无** | 唯一一处是 DSH **临时** token（每次启动随机、服务停即失效），**已脱敏**，详见 §2.1 |
| 内网 IP | ✅ **已脱敏** | 全部换成 `192.168.1.x` 占位，实测残留 0 处（`127.0.0.1` 与公共 DNS 保留） |
| 群号 | ✅ **已脱敏** | `123456789` / `987654321`；真实值只留在 `.gitignore` 掉的 `bridge/config.json` |
| 个人 QQ 号 | ✅ **已脱敏** | `1000000000`（机器人）/ `1000000001` / `1000000002` |
| 用户名/主机名 | ✅ **已脱敏** | `user` / `ubuntu-laptop` / `gpu-node` |
| 提交邮箱 | ⚠️ **待设** | 全局 `user.email` 含个人 QQ 号，提交前必须改为 `用户名@users.noreply.github.com` |
| 群成员数据 | ✅ 已排除 | `bridge/.relations.json`（5.4K，含昵称/别名）已进 `.gitignore` |
| 聊天记录 | ✅ 已排除 | `bridge/.state.json`、`bridge-test/.state.json` 已进 `.gitignore` |
| API Key 文件 | ✅ 无 | `TAVILY_API_KEY` 只存在两处：主控端 vault `~/.secrets/qq-bridge.env`（项目目录之外）、算力端 tmpfs `/run/user/<uid>/qq-bridge.env`（不落盘）。**都不在仓库里** |

---

## 2. 硬问题（P0，推之前必须处理）

### 2.1 那条 DSH token —— ✅ 已处理，且**无需轮换**

> **2026-10-22 00:56 核验后的更正**：这个 token **不是持久凭据**。
> DSH 每次启动都重新随机生成（`~/dsh-*.log` 里能翻到 **10 个互不相同**的 token），
> `~/.dsh/` 目录也没有持久化它，服务一停即失效（当前 3080 端口未监听）。
> 所以**不需要去控制台作废重建**——我在 00:40 说"建议轮换"是过度紧张了。
> 脱敏只是为了让仓库干净，不是因为存在真实泄露风险。

已完成的脱敏（`docs/13-B档方案与基线.md`）：

```
http://localhost:3080/?token=p-FVPL...（原）
   ↓
http://localhost:3080/?token=<启动时随机生成，实际值见 ~/dsh-web2.log>
```

复查命令（应无输出）：

```bash
grep -rInE 'token=[A-Za-z0-9_-]{20,}' --include='*.md' --include='*.mjs' --include='*.sh' .
```

**教训**：这类临时口令也不要写进文档。写"看 `~/dsh-web2.log` 取实时值"就够了，
读者知道去哪找，而仓库里不留实际值。

### 2.2 群号与个人 QQ 号（✅ 已处理）

真实号码已统一替换成一眼可辨的占位值：

| 类型 | 占位值 |
| --- | --- |
| 群号（主测试群） | `123456789` |
| 群号（屏蔽群） | `987654321` |
| 机器人自身 QQ | `1000000000` |
| 群友 QQ | `1000000001` / `1000000002` |

**线上真实配置不进仓库**：`bridge/config.json` 已加入 `.gitignore`，仓库里放的是
`bridge/config.example.json`（同一份结构、值已脱敏）。这样"仓库模板"和"线上配置"
是两份文件，不会互相污染。

### 2.3 内网 IP 与主机名（✅ 已处理）

| 类型 | 占位值 |
| --- | --- |
| 算力端 | `192.168.1.20` |
| 控制端 | `192.168.1.10` |
| 网关 | `192.168.1.1` |
| 主机名 | `ubuntu-laptop` |
| SSH 用户名 | `user` |
| SSH 别名 | `gpu-node` |

**刻意保留不改**：`127.0.0.1`、公共 DNS（`223.5.5.5` / `119.29.29.29`）——
这些是任何人都会用的通用值，改了反而看不懂。

### 2.4 提交前自检

```bash
# 1) 看 .gitignore 是否真的挡住了
git init && git add -A --dry-run | grep -E 'relations|state\.json|\.pid|traces' 
# 应该没有任何输出

# 2) 扫一遍密钥（装一次即可）
#    brew/apt 装 gitleaks，或：
docker run --rm -v "$PWD:/p" zricethezav/gitleaks:latest detect -s /p --no-git
```

---

## 3. 结构决策：一个仓库还是两个？

这是比脱敏更重要的问题。当前 `docs/` 有 24 篇，**大部分是运维日记**，不是文档：

| 类型 | 例子 | 适合公开？ |
| --- | --- | --- |
| 代码与配置模板 | `bridge/*.mjs`、`btask/*.mjs`、`scripts/*` | ✅ 适合 |
| 通用设计文档 | `docs/15-开源搜索实现拆解`、`docs/23-版本迭代逻辑` | ✅ 适合 |
| 运维复盘与摸排 | `docs/01-本机控制端摸底报告`、`docs/02-2060算力端摸底报告`、`docs/14-复盘-从SSH开始的三次偏航` | ❌ 含大量内网/个人细节 |
| 评测记录 | `docs/18~21`（模型横向评测） | 🟡 可公开，但需去掉具体机器信息 |
| 施工公告板 | `CHANGELOG.md` | 🟡 含群号/QQ号/时间线，需脱敏 |

### 3.1 推荐做法（省事版）

**一个公开仓库 + 一个私有仓库**：

- `agent-dual-machine`（public）：`bridge/`、`btask/`、`scripts/`、`config/`、通用 docs、README、LICENSE
- `agent-dual-machine-ops`（private）：`CHANGELOG.md`、摸底报告、复盘、`releases/`、真实配置

在公开仓库的 `.gitignore` 里追加：

```gitignore
CHANGELOG.md
docs/0*-*摸底报告*.md
docs/14-复盘*.md
docs/03-*报告*.md
```

> 代价：公开仓库缺少"变更记录"这一层叙事。
> 折中方案：公开仓库里放一份**脱敏的** `CHANGELOG-public.md`，只写功能变更、不写群号和机器细节。

---

## 4. 建议的仓库结构（公开版）

```
agent-dual-machine/
├── README.md              # 面向外部重写（当前这份是内部交接文档）
├── LICENSE                # MIT 或 Apache-2.0
├── .gitignore
├── .env.example           # ONEBOT_TOKEN / TAVILY_API_KEY 的占位
├── bridge/                # 稳定版
├── bridge-test/           # 试验版（配置模板，无状态文件）
├── btask/                 # 任务流水线
├── scripts/               # 运维脚本
├── config/
├── docs/                  # 只留通用设计文档
└── .github/workflows/ci.yml
```

### README 要重写的理由

现在的 README 是写给"下一个接手的人"的（含机器地址、部署路径、历史踩坑）。
公开仓库的 README 应该回答三个问题：

1. 这是什么？（6GB 显卡上跑本地模型的 QQ 机器人，双轨发布机制）
2. 怎么跑起来？（依赖、`config.example.json` → `config.json`、env）
3. 为什么这样设计？（双轨/影子模式/配置与代码分离，这部分最有价值）

---

## 5. CI（可选，但便宜）

`.github/workflows/ci.yml`：

```yaml
name: ci
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: for f in bridge/*.mjs btask/*.mjs scripts/*.mjs; do node --check "$f"; done
      - run: bash -n scripts/*.sh
```

加上 `node --check` 就能挡住大部分低级错误。`file-guard` 依赖真实运行环境，不适合放 CI。

---

## 6. 执行顺序（照这个来不会返工）

1. ~~轮换 DSH token~~ ✅ **不需要**：核验为每次启动随机的临时口令（§2.1）
2. ~~处理 `docs/13` 里的 token~~ ✅ **已脱敏**
3. 决定仓库结构（公开/私有怎么切）
4. 跑脱敏命令（群号 / QQ 号 / IP / 主机名）
5. 放好 `.gitignore`、`.env.example`、`LICENSE`
6. 重写 README
7. `git init` → `git add -A --dry-run` 核对 → **首次提交**
8. 推送前最后跑一次 `gitleaks`
9. 之后每次改完照旧 `file-guard stamp`

---

## 7. 一个容易忽略的点

`releases/` 里的 5 个快照**内容完全相同**（见 §8 依赖表），推上去等于把同一份代码存 5 遍。
体积无所谓（80K），但会让 history 显得很乱。建议只保留**内容不同**的快照，或者干脆不推 `releases/`。

---

## 8. 归档依赖表（2026-10-22 实测）

| 文件 | 024713 | 024752 | 024832 | 024912 | 024927 |
| --- | --- | --- | --- | --- | --- |
| `qq-bridge.mjs` | fac5d5 | fac5d5 | fac5d5 | fac5d5 | fac5d5 |
| `relations.mjs` | f3e226 | f3e226 | f3e226 | f3e226 | f3e226 |
| `relations-nl.mjs` | 288ec8 | 288ec8 | 288ec8 | 288ec8 | 288ec8 |
| `search.mjs` | 6276aa | 6276aa | 6276aa | 6276aa | 6276aa |

**20 个文件 = 4 个唯一内容 × 5 份重复。** 那 5 次"晋级 / 回滚"实际没有产生任何代码差异 ——
因为第一次、第二次 promote 都失败并自动回滚，快照记的都是回滚后的同一状态。

**建议**：以后 `promote-bridge.sh` 建快照前先比对内容，与最近一份相同时跳过。
这样 `releases/` 里每一条都代表"真的变过一次"，回滚时有意义。
