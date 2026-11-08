# Whale-Pet · dsh-persona-evolve

一个 DeepSeek Harness（DSH）插件：在已有角色卡（dsh-cosplay）之上，**根据对话微调人设**，并维护用户可读的短期 / 长期记忆；改完人设**不重启 dsh**、不中断会话。

> 本仓库目前只包含插件源码。运行环境与部署脚本不在仓库内。

## 它做什么

```
用户消息 ──► 规则预筛（零 LLM，纯正则）
                │  命中教学/纠正/偏好/风格/事实 5 类句式才记候选
                ▼
            攒够 batchSize 轮 ──► 一次 LLM 调用（严格 JSON，max_tokens ≤ 800）
                │
                ▼
            delta 落盘（status: suggested）──► 用户确认
                                                   │
                                                   ▼
                                    写回角色卡 ──► 热重载（disable → enable + recompose）
```

- **不改内核字段**：只有 `editableSections`（默认 `style` / `rules` / `behavior`）允许自动调整，`description` / `personality` 这类内核不会被改写。
- **不重复发人设**：热重载后不往上下文里插全量卡，只提供只读工具 `persona_current_digest`（≤ 200 token），由模型自己决定要不要拉。
- **记忆是明文**：`persona_revisions.jsonl` + `long_term.md`，任何编辑器都能读懂；向量检索只能当加速层。
- **默认需要确认**：`suggested` 的 delta 不确认就不生效、不触发重载。

## 目录

| 路径 | 作用 |
|---|---|
| `src/index.js` | 宿主侧：工具、pre-step 观察、学习/确认、Typert Remote |
| `src/prescreen.js` | 规则预筛器（零 LLM），可配置正则 |
| `src/learn.js` | 批量学习与长期记忆的 prompt 构造、JSON 归一化 |
| `src/summary.js` | 短期摘要（句频打分，无 LLM）、`long_term.md` 渲染/解析 |
| `src/store.js` | 明文存储布局与原子写 |
| `src/reload.js` | force-reload：`readProfilePatches → reconcile(disabled) → reconcile(enabled)` + `recompose` |
| `src/client.js` | 设置页「人设演化」四个 tab |
| `test/neutral-50.mjs` | 验收用：50 轮普通对话应产生 0 个候选 |

## 数据目录（默认 `$DSH_HOME/persona-evolve`）

```
backups/persona-original.{md,json}   改动前的基线
persona-revisions/vN.md              每次确认后的版本快照
current_revision.json                当前指针
persona_revisions.jsonl              delta 流水（suggested / confirmed / rejected）
long_term.md                         长期记忆（## 正式 / ## 待确认）
session-memory/<sessionId>.json      滚动短期摘要
state.json                           计数与最近错误
```

## 安装

```bash
# 依赖：提供 disable→enable 强制重挂的原语
dsh plugin --profile <profile> add github:CK-Rebi/dsh-preset-reload
# 本插件（本地目录或打包后的 tarball）
dsh plugin --profile <profile> add <path-to-this-repo>
```

`cordis.patch.yml` 会插入一行 `persona-evolve`。人设本体仍然写在 `dsh-cosplay` 的 `cosplay-core` 行里，插件只读写它的 `roles[roleId]`。

## 配置

```yaml
- id: persona-evolve
  config:
    enabled: true
    entryId: cosplay-core     # 承载人设的 settings 条目
    roleId: dafeiyu           # 要演化哪个角色
    batchSize: 6              # 6–10 轮候选才触发一次学习
    batchTokenThreshold: 1200
    editableSections: [style, rules, behavior]
    trustMode: false          # true 时低风险 delta 自动确认
    presets: []               # 需要一起重绑的 agent preset id
```

其余键：`learnProvider` / `learnModel` / `learnMaxTokens`（默认 800）、`shortTermEveryTurns`、`longTermPromoteTurns`、`longTermUseLlm`、`digestTokens`、`dataDir`、`rules`。

## 工具（agent 侧）

`persona_current_digest` · `persona_evolve_status` · `persona_delta_list` · `persona_delta_confirm` · `persona_delta_reject` · `persona_memory_confirm`

## 验收

| # | 标准 | 怎么验 |
|---|---|---|
| 1 | 改人设不重启、不丢上下文 | 确认后日志出现两行 `[dsh-cosplay] cosplay-core activated` 与 `[persona-evolve] revision vN 生效`，下一轮回复即新风格 |
| 2 | 普通对话零学习调用 | `node test/neutral-50.mjs` → `candidates: 0` |
| 3 | 记忆可读 | 直接打开数据目录里的 `.md` / `.jsonl` |
| 4 | 未确认不生效 | `suggested` 的 delta 只进 jsonl，卡片与 `persona-revisions/` 都不动 |
| 5 | force 路径不可用要显式失败 | `writeCard` 写后逐字段回读比对，不一致直接抛「人设写入未生效…」 |

## 已知坑（实现时踩过的）

- `ctx.settings.describe()` 的 `value` 是**打包默认值**，profile 覆盖层在 **`row.user`**；按 `value` 读会改错卡。
- `ctx.settings.update(ns, patch)` 在新版 DSH 里由 `configEditor` 直接改写该 profile 的 `cordis.patch.yml`；命令行 `--patch` 覆盖时写入会抛「被 overlay 覆盖」。
- 写入失败要回读校验：`settings.update` 在某些覆盖层下会「看起来成功但没落盘」，所以所有写卡都有逐字段回读自检。
- provider id 不是 `deepseek`（实际是 `deepseek-official` / `deepseek-account`），按能力探测而不是硬编码。
