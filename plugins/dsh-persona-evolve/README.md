# dsh-persona-evolve

让 bot 的人设随对话慢慢长出来——不加关键词规则，由模型自己判断「这次该不该改说话方式」，改完立刻生效，不用重启 DSH。

> 给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的社区插件。人设卡复用 `dsh-cosplay`，记忆复用 `dsh-memory`，本插件只做两件事：**判读 + 演化**。

---

## 它做什么

```
QQ / Web 每一条主人消息
        │
        ▼
   pre-step 钩子：只记进 pending 缓冲（不调用模型、不写文件）
        │
   攒满 batchSize（默认 6）轮
        │
        ▼
   一次小模型调用：读这 6 轮 + 当前卡的可微调字段
        │
   ┌────┴─────┐
   │          │
should_learn  should_learn
  = false      = true
   │          │
 什么都不做   写卡 → 版本快照 → 热重载 → 下一条回复就是新风格
              （autoApply=false 时改为存草稿等你确认）
```

没有「以后都」「不要再」这类关键词表。普通提问、让你干活、闲聊，模型自己判定不需要改，就不会落任何改动。

## 为什么要 LLM 判读而不是关键词

最初版本用正则预筛（`以后都|不要再|别再这么`），实测漏掉了「以后不要用『xxx的那个』这种句式，看着像 AI」——真实用户不会按正则说话。改由模型判读后，代价是每 `batchSize` 轮一次小调用（`max_tokens` 800），换来的是不再靠人猜句式。

## 硬约束（设计时不能破的）

| 约束 | 做法 |
| --- | --- |
| 热重载不重启 | 走 `dsh-preset-reload` 的 force 路径：`reconcileProfilePatches(disable)` → `(enable)` → `agentPresets.recompose` |
| 不断会话 | 只重挂 Loader 行，不碰 `agents` 之外的运行时 |
| LLM 频率受控 | 只在攒满 `batchSize` 轮时调一次；`autoApply=false` 时确认走工具而不是每轮提示 |
| 明文可读 | `persona_revisions.jsonl`、`long_term.md`、`persona-revisions/vN.md|json` 全是文本；向量只是加速层 |
| 未确认不生效 | `autoApply=false` 时 delta 落 `status: suggested`，`persona_delta_confirm` 之后才写卡 |
| 重载后不重发全量人设 | 只给只读 `persona_current_digest()`（≤ `digestTokens`，默认 200） |

## 安装

```bash
# 插件本体（本地目录或 tarball 都行）
dsh plugin --profile web add file:./vendor/dsh-persona-evolve

# 依赖：提供不重启的 force-reload
dsh plugin --profile web add github:CK-Rebi/dsh-preset-reload
```

然后在 profile 的 `cordis.patch.yml` 里加一行（**必须在 host 层**，不能放进 preset）：

```yaml
- id: persona-evolve
  name: 'dsh-persona-evolve'
  config:
    enabled: true
    entryId: 'cosplay-core'   # 复用 dsh-cosplay 的 Loader 行
    roleId: 'dafeiyu'         # 允许演化的角色 id
    batchSize: 6
    autoApply: true
```

重启一次 DSH 让行生效；之后所有人设改动都不再需要重启。

## 工具

| 工具 | 用途 |
| --- | --- |
| `persona_current_digest()` | 当前人设摘要（≤200 token），热重载后给模型对齐用 |
| `persona_evolve_status()` | 看已判读轮数、调用次数、上一版改了什么 |
| `persona_delta_list()` | 列出 `suggested` 草稿 |
| `persona_delta_confirm(id)` / `persona_delta_reject(id)` | 确认 / 驳回草稿（`autoApply=false` 时用） |
| `persona_rollback(revision?)` | 回滚到某一版，留空回上一版；回滚本身也留快照 |
| `persona_memory_confirm(id)` | 把长期记忆候选转正 |

## 数据目录

默认 `$DSH_HOME/persona-evolve`：

```
persona-evolve/
├── backups/persona-original.md|json   接管时的原始卡
├── persona_revisions.jsonl            每次改动一行（含 before/after/evidence/status）
├── persona-revisions/vN.md|json       版本快照，vN.json 含完整 role，可直接回滚
├── current_revision.json              当前版本指针 + 改动备注
├── long_term.md                       「## 正式 / ## 待确认」两区，人工可读写
└── session-memory/<sid>.json          短期摘要
```

## 验收

| 项 | 结果 |
| --- | --- |
| 改人设不重启 | ✅ headless 端到端：delta → confirm → `v1.md` → 第二次 `cosplay-core activated` → 下一条回复已是新风格 |
| 普通闲聊不改人设 | ✅ `test/guard.mjs` 8 项护栏全过（不接受内核字段、单条增量 >160 字丢弃、一次最多 2 条） |
| 明文可读 | ✅ 上面四个文件都是纯文本/JSON |
| 未确认不生效 | ✅ `status` 从 `suggested` → `confirmed` 才写卡 |
| force 路径不可用要显式报错 | ✅ 写卡后回读比对，字段没变就抛「人设写入未生效」 |

跑自检：`node test/guard.mjs`

## 已知坑

- `ctx.settings.describe()` 返回的 `value` 是**合并前的默认卡**，profile 覆盖层在 `row.user` 里；只读 `value` 会拿到包里自带角色，表现为「条目里没有角色 xxx」。本插件按 `{...base, ...user}` 合并。
- `ctx.settings.update(ns, patch)` 写的是 profile 的 `cordis.patch.yml`（不是 `$DSH_HOME/settings.yaml`）。如果该行被 `--patch` 命令行覆盖，写入会被拒绝——因此写卡后有回读自检。
- `ctx.llm.listProviders()` 返回的是 `deepseek-official` / `deepseek-account` 这类 id，配置里写 `deepseek` 会报 `no adapter registered for provider "deepseek"`。插件会按「精确匹配 → 含 deepseek → 第一个」兜底。
- 同一回合多 step 会重复触发 `agent/pre-step`，要按 `step > 1` 跳过，否则一次消息被计成两轮。

## License

MIT
