/**
 * dsh-persona-evolve — 浏览器侧（dsh.client 声明，包入口 dsh-persona-evolve/client）。
 *
 * 设置页新增「人设演化」页，四个分区：
 *   人设版本 / 短期记忆 / 长期记忆 / 学习规则。
 *
 * 0.2.x 客户端三条硬约束（与 dsh-cosplay 同源）：
 *   1. 参数 codec 必须是 strict 且带 create() 工厂；result 可用 src-json。
 *   2. 挂载必须由 async apply 自身 await 并 return disposer，不要包在 ctx.effect 里。
 *   3. 读 ctx.remote.<ns> 前必须用 ctx.inject(['remote.<ns>'], ...) 声明，且在 $mount 之后。
 */
window.__ModuleLoader__.load({
  id: 'dsh-persona-evolve',
  factory: (require) => {
    const React = require('react')
    const { useSyncExternalStore, useState, useEffect } = React

    const styles = {
      page: { display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 0', maxWidth: '760px' },
      card: { border: '1px solid var(--dsw-alias-border-strong, rgba(128,128,128,.3))', borderRadius: '12px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px' },
      row: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      tabs: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
      tab: { border: '1px solid var(--dsw-alias-border-strong, rgba(128,128,128,.3))', background: 'transparent', color: 'inherit', borderRadius: '999px', padding: '4px 12px', fontSize: '13px', cursor: 'pointer', fontFamily: 'inherit' },
      tabActive: { border: 'none', background: 'var(--dsw-specific-accent, #4d6bfe)', color: '#fff', borderRadius: '999px', padding: '4px 12px', fontSize: '13px', cursor: 'pointer', fontFamily: 'inherit' },
      title: { fontSize: '14px', fontWeight: 600 },
      hint: { fontSize: '12.5px', opacity: 0.72, lineHeight: '1.6', whiteSpace: 'pre-wrap' },
      button: { border: '1px solid var(--dsw-alias-border-strong, rgba(128,128,128,.3))', background: 'transparent', color: 'inherit', borderRadius: '8px', padding: '3px 10px', fontSize: '12.5px', cursor: 'pointer', fontFamily: 'inherit' },
      buttonPrimary: { border: 'none', background: 'var(--dsw-specific-accent, #4d6bfe)', color: '#fff', borderRadius: '8px', padding: '4px 12px', fontSize: '12.5px', cursor: 'pointer', fontFamily: 'inherit' },
      item: { borderTop: '1px dashed var(--dsw-alias-border-strong, rgba(128,128,128,.25))', paddingTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px', opacity: 0.8, wordBreak: 'break-all' },
    }

    const strictCodec = (typeSymbol) => ({ mode: 'strict', typeSymbol, create: () => ({}) })
    const resultCodec = (typeSymbol) => ({ mode: 'src-json', typeSymbol })
    const p = (name, symbol) => ({ name, wire: name, source: 'json', codec: strictCodec(symbol) })

    const INVOCATIONS = [
      { id: 'dsh-persona-evolve#personaEvolve/getOverview', service: 'personaEvolve', namespace: 'personaEvolve', method: 'getOverview', invocation: { kind: 'direct' }, parameters: [], result: resultCodec('dsh-persona-evolve#Overview') },
      { id: 'dsh-persona-evolve#personaEvolve/listDeltas', service: 'personaEvolve', namespace: 'personaEvolve', method: 'listDeltas', invocation: { kind: 'direct' }, parameters: [p('status', 'dsh-persona-evolve#Status')], result: resultCodec('dsh-persona-evolve#DeltaList') },
      { id: 'dsh-persona-evolve#personaEvolve/confirmDelta', service: 'personaEvolve', namespace: 'personaEvolve', method: 'confirmDelta', invocation: { kind: 'direct' }, parameters: [p('id', 'dsh-persona-evolve#Id')], result: resultCodec('dsh-persona-evolve#Confirm') },
      { id: 'dsh-persona-evolve#personaEvolve/rejectDelta', service: 'personaEvolve', namespace: 'personaEvolve', method: 'rejectDelta', invocation: { kind: 'direct' }, parameters: [p('id', 'dsh-persona-evolve#Id')], result: resultCodec('dsh-persona-evolve#Reject') },
      { id: 'dsh-persona-evolve#personaEvolve/listShortTerm', service: 'personaEvolve', namespace: 'personaEvolve', method: 'listShortTerm', invocation: { kind: 'direct' }, parameters: [], result: resultCodec('dsh-persona-evolve#ShortTerm') },
      { id: 'dsh-persona-evolve#personaEvolve/listLongTerm', service: 'personaEvolve', namespace: 'personaEvolve', method: 'listLongTerm', invocation: { kind: 'direct' }, parameters: [], result: resultCodec('dsh-persona-evolve#LongTerm') },
      { id: 'dsh-persona-evolve#personaEvolve/confirmMemory', service: 'personaEvolve', namespace: 'personaEvolve', method: 'confirmMemory', invocation: { kind: 'direct' }, parameters: [p('id', 'dsh-persona-evolve#Id')], result: resultCodec('dsh-persona-evolve#Memory') },
      { id: 'dsh-persona-evolve#personaEvolve/setFlags', service: 'personaEvolve', namespace: 'personaEvolve', method: 'setFlags', invocation: { kind: 'direct' }, parameters: [p('patch', 'dsh-persona-evolve#Flags')], result: resultCodec('dsh-persona-evolve#FlagsResult') },
      { id: 'dsh-persona-evolve#personaEvolve/reloadNow', service: 'personaEvolve', namespace: 'personaEvolve', method: 'reloadNow', invocation: { kind: 'direct' }, parameters: [], result: resultCodec('dsh-persona-evolve#Reload') },
    ]
    const REMOTE = { package: 'dsh-persona-evolve', descriptors: INVOCATIONS }

    /** 用 useSyncExternalStore 驱动的最小快照存储。 */
    function createStore(getRemote) {
      let snapshot = { status: 'loading', value: undefined, error: undefined }
      const listeners = new Set()
      const emit = () => {
        for (const listener of [...listeners]) listener()
      }
      const settle = (next) => {
        snapshot = next
        emit()
      }
      const call = async (fn) => {
        const remote = getRemote()
        if (remote === undefined) {
          settle({ status: 'unavailable', value: snapshot.value, error: 'Remote 尚未挂载' })
          return undefined
        }
        try {
          return await fn(remote)
        } catch (error) {
          settle({ status: 'unavailable', value: snapshot.value, error: String(error && error.message ? error.message : error) })
          return undefined
        }
      }
      return {
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        getSnapshot: () => snapshot,
        fail(error) {
          settle({ status: 'unavailable', value: undefined, error: String(error && error.message ? error.message : error) })
        },
        async load() {
          const res = await call((remote) => remote.getOverview())
          if (res === undefined) return
          if (res.ok) settle({ status: 'ready', value: res.value })
          else settle({ status: 'unavailable', value: snapshot.value, error: res.error?.message ?? '读取失败' })
        },
        async mutate(fn, reloadAfter = true) {
          const res = await call(fn)
          if (res === undefined) return undefined
          if (!res.ok) settle({ status: 'unavailable', value: snapshot.value, error: res.error?.message ?? '操作失败' })
          else settle({ status: 'ready', value: snapshot.value, error: undefined })
          if (reloadAfter) await this.load()
          return res
        },
      }
    }

    function DataList({ title, rows, empty, render }) {
      return React.createElement(
        'div',
        { style: styles.card },
        React.createElement('div', { style: styles.title }, title),
        rows.length === 0 ? React.createElement('div', { style: styles.hint }, empty) : rows.map(render),
      )
    }

    function PersonaSection({ store }) {
      const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
      const [tab, setTab] = useState('versions')
      const [deltas, setDeltas] = useState([])
      const [shortTerm, setShortTerm] = useState([])
      const [longTerm, setLongTerm] = useState({ confirmed: [], pending: [], path: '' })
      const [busy, setBusy] = useState(false)

      const overview = snapshot.value
      const remoteReady = snapshot.status === 'ready' && overview !== undefined

      const refreshExtras = async () => {
        if (!remoteReady) return
        const remote = store.remote?.()
        if (remote === undefined) return
        try {
          const deltaRes = await remote.listDeltas('suggested')
          if (deltaRes?.ok) setDeltas(deltaRes.value?.rows ?? [])
          const shortRes = await remote.listShortTerm()
          if (shortRes?.ok) setShortTerm(shortRes.value?.rows ?? [])
          const longRes = await remote.listLongTerm()
          if (longRes?.ok) setLongTerm(longRes.value ?? { confirmed: [], pending: [], path: '' })
        } catch {
          // 设置页附加数据读取失败不阻断主面板。
        }
      }

      useEffect(() => {
        void refreshExtras()
      }, [snapshot.status, overview?.revision, tab])

      if (snapshot.status === 'loading') return React.createElement('div', { style: styles.hint }, '加载中…')
      if (snapshot.status === 'unavailable' && overview === undefined) {
        return React.createElement('div', { style: styles.hint }, `人设演化不可用：${snapshot.error ?? '未知原因'}`)
      }

      const act = async (fn) => {
        setBusy(true)
        try {
          await fn()
          await refreshExtras()
        } finally {
          setBusy(false)
        }
      }

      const tabButton = (id, label) =>
        React.createElement(
          'button',
          { key: id, style: tab === id ? styles.tabActive : styles.tab, onClick: () => setTab(id) },
          label,
        )

      const versionsTab = [
        React.createElement(
          'div',
          { style: styles.card, key: 'overview' },
          React.createElement('div', { style: styles.title }, '当前人设'),
          React.createElement('div', { style: styles.hint }, `${overview?.entryId ?? ''}/${overview?.roleId ?? ''} · revision v${overview?.revision ?? 0}`),
          React.createElement('div', { style: styles.hint }, `数据目录：${overview?.dataDir ?? ''}`),
          React.createElement('div', { style: styles.row },
            React.createElement('button', { style: styles.buttonPrimary, disabled: busy, onClick: () => act(() => store.mutate((remote) => remote.reloadNow())) }, '立即重载人设'),
            React.createElement('span', { style: styles.hint }, `待确认改动 ${overview?.counts?.suggested ?? 0} 条 · 待确认记忆 ${overview?.counts?.pendingMemory ?? 0} 条`),
          ),
          overview?.card ? React.createElement('div', { style: styles.hint }, `风格：${overview.card.style ?? '（空）'}\n守则：${overview.card.rules ?? '（空）'}`) : null,
        ),
        React.createElement(DataList, {
          key: 'deltas',
          title: '待确认的人设改动',
          rows: deltas,
          empty: '没有待确认的改动。',
          render: (row) =>
            React.createElement('div', { key: row.id, style: styles.item },
              React.createElement('div', { style: styles.row },
                React.createElement('span', { style: styles.mono }, `${row.id} · ${row.section}`),
                React.createElement('button', {
                  style: styles.buttonPrimary,
                  disabled: busy,
                  onClick: () => act(() => store.mutate((remote) => remote.confirmDelta(row.id))),
                }, '确认并生效'),
                React.createElement('button', {
                  style: styles.button,
                  disabled: busy,
                  onClick: () => act(() => store.mutate((remote) => remote.rejectDelta(row.id))),
                }, '拒绝'),
              ),
              row.reason ? React.createElement('div', { style: styles.hint }, `理由：${row.reason}`) : null,
              React.createElement('div', { style: styles.hint }, `原文：${row.before || '（空）'}`),
              React.createElement('div', { style: styles.hint }, `改为：${row.after || '（空）'}`),
            ),
        }),
      ]

      const shortTermTab = [
        React.createElement(DataList, {
          key: 'short',
          title: '短期记忆（滚动摘要，只读）',
          rows: shortTerm,
          empty: '还没有生成短期摘要。',
          render: (row) =>
            React.createElement('div', { key: `${row.sessionId}-${row.updatedAt}`, style: styles.item },
              React.createElement('div', { style: styles.mono }, `${row.sessionId} · ${row.turns} 轮 · 累计 ${row.accumulatedTurns} 轮`),
              React.createElement('div', { style: styles.hint }, row.summary || '（空）'),
              row.keyFacts?.length ? React.createElement('div', { style: styles.hint }, `事实：${row.keyFacts.join('；')}`) : null,
              row.openQuestions?.length ? React.createElement('div', { style: styles.hint }, `未决：${row.openQuestions.join('；')}`) : null,
            ),
        }),
      ]

      const longTermTab = [
        React.createElement(DataList, {
          key: 'pending',
          title: '长期记忆 · 待确认',
          rows: longTerm.pending ?? [],
          empty: '没有待确认的事实。',
          render: (row) =>
            React.createElement('div', { key: row.id, style: styles.item },
              React.createElement('div', { style: styles.row },
                React.createElement('span', { style: styles.mono }, row.id),
                React.createElement('button', {
                  style: styles.buttonPrimary,
                  disabled: busy,
                  onClick: () => act(() => store.mutate((remote) => remote.confirmMemory(row.id))),
                }, '转为正式'),
              ),
              React.createElement('div', { style: styles.hint }, row.text),
              React.createElement('div', { style: styles.mono }, `${row.createdAt} · ${row.source}`),
            ),
        }),
        React.createElement(DataList, {
          key: 'confirmed',
          title: '长期记忆 · 正式',
          rows: longTerm.confirmed ?? [],
          empty: '还没有转正的长期记忆。',
          render: (row) => React.createElement('div', { key: row.id, style: styles.item },
            React.createElement('div', { style: styles.hint }, row.text),
            React.createElement('div', { style: styles.mono }, `${row.createdAt} · ${row.source}`),
          ),
        }),
        React.createElement('div', { key: 'path', style: styles.hint }, `明文文件：${longTerm.path ?? ''}`),
      ]

      const rulesTab = [
        React.createElement(
          'div',
          { style: styles.card, key: 'rules' },
          React.createElement('div', { style: styles.title }, '学习开关'),
          React.createElement('div', { style: styles.row },
            React.createElement('button', {
              style: overview?.enabled ? styles.buttonPrimary : styles.button,
              disabled: busy,
              onClick: () => act(() => store.mutate((remote) => remote.setFlags({ enabled: !overview?.enabled }))),
            }, overview?.enabled ? '已开启 · 点击关闭' : '已关闭 · 点击开启'),
            React.createElement('button', {
              style: overview?.trustMode ? styles.buttonPrimary : styles.button,
              disabled: busy,
              onClick: () => act(() => store.mutate((remote) => remote.setFlags({ trustMode: !overview?.trustMode }))),
            }, overview?.trustMode ? '信任模式：开（自动应用）' : '信任模式：关（需确认）'),
          ),
          React.createElement('div', { style: styles.hint }, '预筛规则与批量阈值在插件配置（cordis.patch.yml 的 persona-evolve 行）里修改：batchSize 默认 8，batchTokenThreshold 默认 1200；普通闲聊不会触发模型调用。'),
        ),
        React.createElement('div', { key: 'status', style: styles.card },
          React.createElement('div', { style: styles.title }, '运行状态'),
          React.createElement('div', { style: styles.hint }, overview?.status ?? ''),
        ),
      ]

      return React.createElement(
        'div',
        { style: styles.page },
        React.createElement('div', { style: styles.tabs },
          tabButton('versions', '人设版本'),
          tabButton('short', '短期记忆'),
          tabButton('long', '长期记忆'),
          tabButton('rules', '学习规则'),
        ),
        snapshot.error ? React.createElement('div', { style: styles.hint }, `提示：${snapshot.error}`) : null,
        ...(tab === 'versions' ? versionsTab : tab === 'short' ? shortTermTab : tab === 'long' ? longTermTab : rulesTab),
      )
    }

    return {
      name: 'persona-evolve-client',
      inject: ['remote', 'slots', 'connection'],
      async apply(ctx) {
        let remoteNamespace = undefined
        let unregister = undefined
        const store = createStore(() => remoteNamespace)
        store.remote = () => remoteNamespace
        const report = (error) => {
          const message = String(error && error.message ? error.message : error)
          store.fail(`Remote 挂载失败：${message}`)
          console.error('[dsh-persona-evolve] Remote 挂载失败:', message, error)
          return new Error(`PERSONA_EVOLVE_MOUNT_FAILED: ${message}`)
        }
        try {
          const disposeRemote = await ctx.remote.$mount(REMOTE)
          const ui = ctx.inject(['remote.personaEvolve', 'slots'], (child) => {
            const remote = child.remote?.personaEvolve
            if (remote === undefined) throw new Error('the personaEvolve Remote namespace did not resolve after mount')
            remoteNamespace = remote
            unregister = child.slots.inject('settings.section', () =>
              child.slots.register(
                { name: 'settings.section', id: 'persona-evolve', priority: 120, label: '人设演化' },
                () => React.createElement(PersonaSection, { store }),
              ),
            )
            void store.load()
          })
          try {
            await ui
          } catch (error) {
            await ui.dispose()
            await disposeRemote()
            throw error
          }
          return async () => {
            if (typeof unregister === 'function') unregister()
            await ui.dispose()
            await disposeRemote()
          }
        } catch (error) {
          throw report(error)
        }
      },
    }
  },
})
