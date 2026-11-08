/**
 * dsh-persona-evolve — 人设热重载。
 *
 * 为什么不靠 `patchReload`：Loader 对「仅 config 变化」走 `_patchContext` →
 * `fiber.update(config)`，**不保证重新实例化**。承载人设的插件（dsh-cosplay）在
 * `apply()` 里注册 systemPrompt 变量与 section，只有 fiber 被 dispose 后重新 init
 * 才会重跑注册。`disabled` 分支是唯一确定的重新注册触发点。
 *
 * 因此这里复用 dsh-preset-reload 验证过的同一套机制：
 *   读 profile patch → 递归给目标行加 disabled → reconcile（关闭）
 *   → 去掉 disabled → reconcile（重新 init）
 * 对 agent preset 型人设，再补一次 `recompose` 把活会话绑到新 revision。
 */
import {
  composeEntries,
  readProfilePatches,
  reconcileProfilePatches,
} from '@deepseek-ai/dsh-app-boot'

/** 在 patch 结构里找出声明目标行的 Loader id。 */
export function findRowId(patches, entryId) {
  const rows = composeEntries(patches)
  const row = rows.find((entry) => entry.id === entryId) ?? rows.find((entry) => entry.name === entryId)
  return row?.id
}

/** 递归给匹配 id 的行打上 `disabled`，返回改动后的副本（不就地修改）。 */
export function withDisabled(node, rowId, disabled) {
  if (Array.isArray(node)) return node.map((item) => withDisabled(item, rowId, disabled))
  if (node === null || typeof node !== 'object') return node
  const copy = {}
  for (const [key, value] of Object.entries(node)) copy[key] = withDisabled(value, rowId, disabled)
  if (copy.id === rowId && typeof copy.name === 'string') copy.disabled = disabled
  return copy
}

/**
 * 用 disable → enable 强制目标行重新实例化。
 * @param ctx - 宿主上下文（需要 root 与 profile）。
 * @param profile - profile 事实（`ctx.get('profileContext')`）。
 * @param rowId - 目标 Loader 行 id。
 * @returns {string[]} 两次 reconcile 的诊断行。
 */
export async function forceRemountRow(ctx, profile, rowId) {
  const patches = readProfilePatches('dsh', profile)
  const diagnostics = []
  const off = await reconcileProfilePatches(ctx.root, withDisabled(patches, rowId, true), 'dsh')
  diagnostics.push(...off.map((line) => `disable: ${line}`))
  const on = await reconcileProfilePatches(ctx.root, withDisabled(patches, rowId, false), 'dsh')
  diagnostics.push(...on.map((line) => `enable: ${line}`))
  return diagnostics
}

/** 把绑定在指定 preset 上的活 agent 重绑到最新 revision。 */
export async function rebindPresets(ctx, presetIds) {
  const moved = []
  const failed = []
  if (!Array.isArray(presetIds) || presetIds.length === 0) return { moved, failed }
  const agents = typeof ctx.agents?.list === 'function' ? ctx.agents.list() : []
  for (const presetId of presetIds) {
    for (const agent of agents) {
      let composed
      try {
        composed = ctx.agentPresets.composedPreset(agent.ctx)
      } catch {
        continue
      }
      if (composed !== presetId) continue
      try {
        await ctx.agentPresets.recompose(agent.ctx, presetId)
        moved.push(`${presetId}:${agent.id}`)
      } catch (error) {
        failed.push({ agentId: agent.id, presetId, reason: String(error?.message ?? error) })
      }
    }
  }
  return { moved, failed }
}

/**
 * 重载人设：关闭承载行、再打开，然后（可选）重绑 agent preset 上的活会话。
 * @param ctx - 宿主上下文。
 * @param {object} config - 插件配置。
 * @returns {Promise<object>} 重载结果与诊断。
 */
export async function reloadPersona(ctx, config) {
  const profile = ctx.get('profileContext')
  if (profile === undefined) throw new Error('persona-evolve: 需要 profile 上下文（dsh web / profile 启动）')
  const patches = readProfilePatches('dsh', profile)
  const rowId = findRowId(patches, config.entryId)
  const result = { entryId: config.entryId, rowId, remounted: false, diagnostics: [], moved: [], failed: [] }
  if (rowId === undefined) {
    result.note = `找不到声明 ${config.entryId} 的 Loader 行，跳过强制重挂（新会话仍会读到新人设）`
  } else {
    result.diagnostics = await forceRemountRow(ctx, profile, rowId)
    result.remounted = true
  }
  const rebound = await rebindPresets(ctx, config.presets)
  result.moved = rebound.moved
  result.failed = rebound.failed
  return result
}
