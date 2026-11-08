# Whale-Pet

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的自托管 bot 相关源码。目前只有一个人设插件。

## dsh-persona-evolve

让 bot 的人设随对话慢慢长出来：没有关键词规则，每攒够 6 轮由模型自己判断「这次该不该改说话方式」，改完写卡 + 留版本快照 + 热重载，不重启 DSH。改错了可以 `persona_rollback` 回上一版。

- 人设卡复用 `dsh-cosplay`（SillyTavern v2 字段），不引入第二套人设
- 记忆与 `dsh-memory` 并行：evolve 管人设演化与明文事实层，memory 管跨平台共享
- 热重载依赖 [`dsh-preset-reload`](https://github.com/CK-Rebi/dsh-preset-reload) 的 disable→enable 强制重挂
- 明文可读：`persona_revisions.jsonl` / `long_term.md` / `persona-revisions/vN.{md,json}`

详见 [`plugins/dsh-persona-evolve/README.md`](plugins/dsh-persona-evolve/README.md)。

```
plugins/
└── dsh-persona-evolve/
    ├── cordis.patch.yml      # loader 行（host 层）
    ├── package.json
    ├── src/
    │   ├── index.js          # pre-step 缓冲、判读、写卡、热重载、工具、远程服务
    │   ├── learn.js          # 判读提示词与 delta 护栏
    │   ├── reload.js         # dsh-preset-reload 的 force 路径封装
    │   ├── store.js          # 数据目录、原子写、jsonl
    │   ├── summary.js        # 无 LLM 的短期摘要与 long_term.md 渲染
    │   ├── text.js
    │   └── client.js         # 设置页「人设演化」四个 tab
    └── test/guard.mjs        # 8 项 delta 护栏自检
```

自检：`node plugins/dsh-persona-evolve/test/guard.mjs`

## License

MIT
