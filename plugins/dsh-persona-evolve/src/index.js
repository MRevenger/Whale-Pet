/**
 * dsh-persona-evolve — 主机侧入口。
 *
 * 职责分层：
 *   B 预筛（零 LLM）  → prescreen.js
 *   C 批量学习（低频） → learn.js
 *   D 记忆（明文）    → summary.js + store.js
 *   A 版本/备份       → 本文件的 revision 相关函数
 *   E 设置页/可观测性 → Typert Remote + client.js
 *
 * 人设本体不另存一份：直接读写 dsh-cosplay 的角色卡（settings 条目 `cosplay-core`
 * 的 roles[roleId]），因此永远只有一套人设。
 */
import { randomUUID } from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { composeEntries, readProfilePatches } from '@deepseek-ai/dsh-app-boot'
import * as store from './store.js'
import { compileRules, inspect, messageText, roughTokens, DEFAULT_RULES } from './prescreen.js'
import {
  buildLearnPrompt,
  buildLongTermPrompt,
  extractJsonObject,
  normalizeLearnResult,
  normalizeLongTermResult,
} from './learn.js'
import { parseLongTerm, renderLongTerm, renderLongTermForPrompt, summarizeTurns } from './summary.js'
import { reloadPersona } from './reload.js'

export const name = 'persona-evolve'

/** `profileContext` 是 profile 事实而非服务，用 `ctx.get` 读，故不写进 inject。 */
export const inject = ['settings', 'tools', 'llm', 'typert']

export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  entryId: Schema.string().default('cosplay-core'),
  roleId: Schema.string().default('dafeiyu'),
  editableSections: Schema.array(Schema.string()).default(['style', 'rules', 'behavior']),
  batchSize: Schema.number().default(8),
  batchTokenThreshold: Schema.number().default(1200),
  trustMode: Schema.boolean().default(false),
  presets: Schema.array(Schema.string()).default([]),
  learnProvider: Schema.string().default('deepseek'),
  learnModel: Schema.string().default('deepseek-chat'),
  learnMaxTokens: Schema.number().default(800),
  shortTermEveryTurns: Schema.number().default(2),
  longTermPromoteTurns: Schema.number().default(20),
  longTermUseLlm: Schema.boolean().default(true),
  digestTokens: Schema.number().default(200),
  dataDir: Schema.string().default(''),
  rules: Schema.array(
    Schema.object({
      id: Schema.string().default(''),
      label: Schema.string().default(''),
      pattern: Schema.string().default(''),
    }),
  ).default([]),
})

/** 0.2.x 把每个 volatile 字段单独包成带 `.get()` 的引用，逐层解包。 */
function field(holder) {
  let current = holder
  for (let depth = 0; depth < 8; depth++) {
    if (current === undefined || current === null) return current
    if (typeof current.get !== 'function') return current
    current = current.get()
  }
  return current
}

/** 把整份（可能被引用包裹的）配置读成普通对象。 */
function plainConfig(config) {
  const source = field(config) ?? {}
  const pick = (key, fallback) => {
    const value = field(source[key])
    return value === undefined || value === null ? fallback : value
  }
  return {
    enabled: pick('enabled', true) === true,
    entryId: String(pick('entryId', 'cosplay-core')),
    roleId: String(pick('roleId', 'dafeiyu')),
    editableSections: Array.isArray(pick('editableSections', ['style', 'rules', 'behavior']))
      ? pick('editableSections', []).map(String)
      : ['style', 'rules', 'behavior'],
    batchSize: Math.max(1, Number(pick('batchSize', 8)) || 8),
    batchTokenThreshold: Math.max(100, Number(pick('batchTokenThreshold', 1200)) || 1200),
    trustMode: pick('trustMode', false) === true,
    presets: Array.isArray(pick('presets', [])) ? pick('presets', []).map(String) : [],
    learnProvider: String(pick('learnProvider', 'deepseek')),
    learnModel: String(pick('learnModel', 'deepseek-chat')),
    learnMaxTokens: Math.min(800, Math.max(64, Number(pick('learnMaxTokens', 800)) || 800)),
    shortTermEveryTurns: Math.max(1, Number(pick('shortTermEveryTurns', 2)) || 2),
    longTermPromoteTurns: Math.max(4, Number(pick('longTermPromoteTurns', 20)) || 20),
    longTermUseLlm: pick('longTermUseLlm', true) !== false,
    digestTokens: Math.max(60, Number(pick('digestTokens', 200)) || 200),
    dataDir: String(pick('dataDir', '')),
    rules: Array.isArray(pick('rules', [])) ? pick('rules', []) : [],
  }
}

const CARD_LABELS = {
  name: '名字',
  description: '角色简介',
  personality: '性格',
  style: '说话风格',
  rules: '行为守则',
  behavior: '行为模式',
  scenario: '场景',
  system_prompt: '系统提示',
  post_history_instructions: '历史后指令',
}

const textOutput = {
  schema: { type: 'string' },
  render(_args, value) {
    return [{ type: 'text', text: String(value) }]
  },
}

/** 把 schemastery 的 volatile 值逐层解包成普通对象（函数 / .get() / 嵌套）。 */
function materialize(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return value
  if (typeof value === 'function') {
    try {
      return materialize(value(), depth + 1)
    } catch {
      return value
    }
  }
  if (typeof value !== 'object') return value
  if (!Array.isArray(value) && typeof value.get === 'function') {
    try {
      return materialize(value.get(), depth + 1)
    } catch {
      return value
    }
  }
  if (Array.isArray(value)) return value.map((item) => materialize(item, depth + 1))
  const out = {}
  for (const [key, inner] of Object.entries(value)) out[key] = materialize(inner, depth + 1)
  return out
}

/** 读取承载人设的 settings 条目：`base` 是打包默认值，`user` 是 profile 补丁层（真正的卡在这里）。 */
function describeEntry(ctx, entryId) {
  const rows = ctx.settings.describe()
  const row = rows.find((item) => item.ns === entryId)
  if (row === undefined) throw new Error(`persona-evolve: 找不到设置条目 ${entryId}（人设承载行是否已安装？）`)
  const base = materialize(row.base ?? row.value ?? {})
  const user = materialize(row.user ?? {})
  const merged = { ...base, ...user }
  // roles / activeRole 有值时以 profile 层为准，避免被打包默认卡盖掉。
  if (user.roles !== undefined) merged.roles = user.roles
  if (user.activeRole !== undefined) merged.activeRole = user.activeRole
  if (findRoleSafe(merged, undefined) === undefined && user.roles === undefined) {
    const override = patchConfigOf(ctx, entryId)
    if (override !== undefined) return { ...merged, ...materialize(override) }
  }
  return merged
}

function findRoleSafe(state, roleId) {
  const roles = Array.isArray(state?.roles) ? state.roles : []
  return roles.find((role) => role !== null && typeof role === 'object' && (roleId === undefined || role.id === roleId))
}

/** 从当前 profile 的补丁文件里找某行的 config（settings.describe 看不到补丁层，只能自己读）。 */
function patchConfigOf(ctx, entryId) {
  const profile = ctx.get('profileContext')
  if (profile === undefined || profile === null) return undefined
  let found
  try {
    const entries = composeEntries(readProfilePatches('dsh', profile))
    const flat = Array.isArray(entries) ? entries : []
    const matches = []
    for (const entry of flat) {
      if (entry === null || typeof entry !== 'object') continue
      const rowConfig = entry.config ?? entry.options ?? entry.value
      if (entry.id === entryId && rowConfig !== undefined) matches.push(rowConfig)
      if (Array.isArray(entry.insert)) {
        for (const inner of entry.insert) {
          if (inner !== null && inner?.id === entryId && inner.config !== undefined) matches.push(inner.config)
        }
      }
    }
    if (matches.length > 0) {
      // 同一个 id 可能既出现在 bundle 的 insert（壳配置）又出现在 profile 补丁（真卡）：
      // 合并后取「带 roles 的那一份」为准。
      const merged = {}
      for (const item of matches) Object.assign(merged, item)
      const withRoles = matches.filter((item) => item?.roles !== undefined)
      if (withRoles.length > 0) merged.roles = withRoles[withRoles.length - 1].roles
      if (matches.some((item) => item?.activeRole !== undefined)) {
        merged.activeRole = matches.filter((item) => item?.activeRole !== undefined).pop().activeRole
      }
      found = merged
    }
    if (found === undefined) {
      console.warn(
        `[persona-evolve] 补丁里没找到 ${entryId}；entries=${flat.map((item) => item?.id ?? item?.name).slice(0, 12).join(',')}`,
      )
    }
  } catch (error) {
    console.warn('[persona-evolve] 读 profile 补丁失败', error)
    return undefined
  }
  return found
}

function findRole(state, roleId) {
  const roles = Array.isArray(state?.roles) ? state.roles : []
  return roles.find((role) => role !== null && typeof role === 'object' && role.id === roleId)
}

function roleCard(ctx, cfg) {
  const state = describeEntry(ctx, cfg.entryId)
  const role = findRole(state, cfg.roleId)
  if (role === undefined) {
    let probe = ''
    try {
      probe = ` keys=${Object.keys(state ?? {}).join(',')} rolesType=${typeof state?.roles} isArray=${Array.isArray(state?.roles)} raw=${JSON.stringify(state).slice(0, 300)}`
    } catch (error) {
      probe = ` probe失败=${String(error?.message ?? error)}`
    }
    throw new Error(`persona-evolve: 条目 ${cfg.entryId} 里没有角色 ${cfg.roleId}${probe}`)
  }
  return role
}

/** 写回角色卡字段（settings 条目是唯一事实源，cosplay 下一轮组装时读到新值）。 */
async function writeCard(ctx, cfg, patch) {
  const state = describeEntry(ctx, cfg.entryId)
  const roles = Array.isArray(state.roles) ? state.roles : []
  let touched = false
  const next = roles.map((role) => {
    if (role === null || typeof role !== 'object' || role.id !== cfg.roleId) return role
    touched = true
    return { ...role, ...patch }
  })
  if (!touched) throw new Error(`persona-evolve: 条目 ${cfg.entryId} 里没有角色 ${cfg.roleId}`)
  await ctx.settings.update(cfg.entryId, { roles: next })
  // 写后自检：settings 可能被上层补丁挡住而静默不生效，这里必须显式失败而不是假装成功。
  const verify = findRole(describeEntry(ctx, cfg.entryId), cfg.roleId)
  for (const [key, value] of Object.entries(patch)) {
    if (String(verify?.[key] ?? '') !== String(value ?? '')) {
      throw new Error(`persona-evolve: 人设写入未生效（字段 ${key} 仍是旧值）。可能是该行被 home patch 或命令行 --patch 覆盖，需要在设置页或 profile 补丁层里改。`)
    }
  }
  return next.find((role) => role?.id === cfg.roleId)
}

/** 把角色卡渲染成可读 Markdown（版本文件与摘要都用它）。 */
function renderCardMarkdown(role) {
  const lines = [`# ${role.name ?? role.id}`, '']
  for (const [key, label] of Object.entries(CARD_LABELS)) {
    const value = typeof role[key] === 'string' ? role[key].trim() : ''
    if (value === '') continue
    lines.push(`## ${label}`, '', value, '')
  }
  return lines.join('\n')
}

/** 摘要用：把卡里可微调字段压成短段落。 */
function cardDigest(role, editable, maxChars) {
  const parts = []
  for (const section of editable) {
    const value = typeof role[section] === 'string' ? role[section].trim() : ''
    if (value === '') continue
    parts.push(`${section}: ${value}`)
  }
  const body = parts.join('\n')
  return body.length > maxChars ? `${body.slice(0, maxChars)}…` : body
}

/** 单次模型调用（批量学习与长期记忆共用），流式拼文本。 */
/**
 * 解析学习调用该用哪家 provider / 哪个模型。
 *
 * 配置里写的 provider 可能是用户拍的（如 `deepseek`），而运行时真正的路由 id 往往
 * 带后缀（`deepseek-api-key`）。所以：优先用配置且确认存在；否则取列表里第一个含
 * deepseek 的路由；再否则取第一个可用路由。模型同理，配置为空时用路由自己的默认模型。
 */
function resolveLearnTarget(ctx, cfg) {
  let providers = []
  try {
    providers = ctx.llm.listProviders() ?? []
  } catch {
    providers = []
  }
  if (process.env.PE_DEBUG) {
    console.warn('[persona-evolve] providers:', JSON.stringify(providers).slice(0, 600))
  }
  const wanted = String(cfg.learnProvider ?? '').trim()
  const exact = providers.find((item) => String(item?.id ?? item?.provider ?? '') === wanted)
  const preferred =
    exact ??
    providers.find((item) => String(item?.id ?? item?.provider ?? '').includes('deepseek')) ??
    providers[0]
  const provider = String(preferred?.id ?? preferred?.provider ?? wanted ?? '')
  const configuredModel = String(cfg.learnModel ?? '').trim()
  const providerDefault = String(preferred?.defaultModel ?? preferred?.model ?? '').trim()
  const model = configuredModel !== '' && configuredModel !== 'deepseek-chat' ? configuredModel : providerDefault || configuredModel
  return { provider, model }
}

async function callModel(ctx, cfg, system, user, maxTokens) {
  const target = resolveLearnTarget(ctx, cfg)
  const stream = ctx.llm.stream({
    provider: target.provider,
    model: target.model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    maxTokens,
    temperature: 0,
  })
  let text = ''
  const seenTypes = new Set()
  for await (const chunk of stream) {
    if (chunk !== null && typeof chunk === 'object' && typeof chunk.type === 'string') {
      if (!seenTypes.has(chunk.type)) {
        seenTypes.add(chunk.type)
        if (process.env.PE_DEBUG) console.warn('[persona-evolve] chunk type:', chunk.type, JSON.stringify(chunk).slice(0, 200))
      }
    }
    if (chunk !== null && typeof chunk === 'object' && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text
    }
  }
  return text
}

/**
 * 插件主体。
 * @param ctx - 主机侧插件上下文。
 * @param config - 本行 Config（volatile 引用）。
 */
export function apply(ctx, config) {
  const paths = store.layout(store.resolveDataDir(plainConfig(config)))
  let rules = compileRules(plainConfig(config).rules)
  let rulesSource = JSON.stringify(plainConfig(config).rules)

  /** 每会话的观察缓冲；进程内即可，落盘的是摘要与 delta。 */
  const buffers = new Map()
  /** 学习任务是低频的：同一会话串行，且失败不重排。 */
  const learnQueue = new Map()
  let counters = {
    turnsObserved: 0,
    candidates: 0,
    learnCalls: 0,
    longTermCalls: 0,
    lastLearnAt: '',
    lastReloadAt: '',
    lastError: '',
  }
  let revision = 0
  let ready = false

  const cfg = () => plainConfig(config)
  const logger = () => ctx.logger

  function warn(message, error) {
    const detail = error === undefined || error === null ? '' : `: ${String(error?.message ?? error)}`
    counters.lastError = `${new Date().toISOString()} ${message}${detail}`
    try {
      const log = logger()
      if (typeof log?.warn === 'function') log.warn(`[persona-evolve] ${message}${detail}`)
      else console.warn(`[persona-evolve] ${message}${detail}`)
    } catch {
      // 日志不可用时不阻断主流程。
    }
  }

  function bufferOf(sessionId) {
    let buffer = buffers.get(sessionId)
    if (buffer === undefined) {
      buffer = { candidates: [], turns: [], lastTurn: -1, tokens: 0, learning: false }
      buffers.set(sessionId, buffer)
    }
    return buffer
  }

  // ── 启动：备份基线 + 恢复版本指针 ──────────────────────────────────────────
  async function bootstrap() {
    await store.ensureLayout(paths)
    console.log(`[persona-evolve] bootstrap · data=${paths.root}`)
    const current = await store.readJson(paths.current, undefined)
    revision = Number(current?.revision ?? 0) || 0
    const baseline = await store.readText(`${paths.backups}/persona-original.md`)
    if (baseline === undefined) {
      try {
        const role = roleCard(ctx, cfg())
        const markdown = renderCardMarkdown(role)
        await store.writeTextAtomic(`${paths.backups}/persona-original.md`, markdown)
        await store.writeJsonAtomic(`${paths.backups}/persona-original.json`, {
          createdAt: new Date().toISOString(),
          entryId: cfg().entryId,
          roleId: cfg().roleId,
          hash: store.fingerprint(markdown),
          card: role,
        })
        console.log(`[persona-evolve] 基线已备份（${paths.backups}/persona-original.md）`)
      } catch (error) {
        console.error('[persona-evolve] 基线备份失败', error)
        warn('基线备份失败（稍后重试）', error)
      }
    }
    const state = await store.readJson(paths.state, undefined)
    if (state !== undefined && typeof state === 'object') {
      counters = { ...counters, ...(state.counters ?? {}) }
      revision = Number(state.revision ?? revision) || revision
    }
    ready = true
  }

  async function persistState() {
    await store.writeJsonAtomic(paths.state, {
      revision,
      counters,
      updatedAt: new Date().toISOString(),
    })
  }

  // ── A：版本与备份 ─────────────────────────────────────────────────────────
  async function snapshotRevision(role, note) {
    const files = await store.listFiles(paths.revisions)
    const next = store.nextRevisionNumber(files.map((file) => file.name))
    const markdown = [`<!-- revision v${next} · ${new Date().toISOString()} · ${note} -->`, '', renderCardMarkdown(role)].join('\n')
    const path = `${paths.revisions}/v${next}.md`
    await store.writeTextAtomic(path, markdown)
    revision = next
    await store.writeJsonAtomic(paths.current, {
      revision: next,
      file: path,
      hash: store.fingerprint(markdown),
      updatedAt: new Date().toISOString(),
      note,
    })
    await persistState()
    return next
  }

  // ── D：长期记忆明文文件 ───────────────────────────────────────────────────
  async function readLongTerm() {
    const text = await store.readText(paths.longTerm)
    if (text === undefined) return []
    return parseLongTerm(text)
  }

  async function writeLongTerm(entries) {
    await store.writeTextAtomic(paths.longTerm, renderLongTerm(entries))
  }

  async function addLongTermCandidates(items, sessionId) {
    const entries = await readLongTerm()
    for (const item of items) {
      entries.push({
        id: `lt_${randomUUID().slice(0, 8)}`,
        text: item.text,
        evidence: item.evidence,
        source: `session:${sessionId}`,
        createdAt: new Date().toISOString(),
        status: 'pending',
      })
    }
    await writeLongTerm(entries)
    return entries.filter((entry) => entry.status === 'pending')
  }

  // ── C：增量条目（suggested）与落地 ────────────────────────────────────────
  async function recordSuggested(deltas, sessionId, reason) {
    const rows = await store.readJsonl(paths.deltas)
    const created = []
    for (const delta of deltas) {
      const record = {
        id: `dl_${randomUUID().slice(0, 8)}`,
        createdAt: new Date().toISOString(),
        sessionId,
        section: delta.section,
        before: delta.before,
        after: delta.after,
        reason: delta.reason || reason,
        status: 'suggested',
      }
      rows.push(record)
      created.push(record)
    }
    await store.rewriteJsonl(paths.deltas, rows)
    return created
  }

  async function setDeltaStatus(id, status) {
    const rows = await store.readJsonl(paths.deltas)
    const row = rows.find((item) => item.id === id)
    if (row === undefined) throw new Error(`persona-evolve: 找不到 delta ${id}`)
    row.status = status
    row.decidedAt = new Date().toISOString()
    await store.rewriteJsonl(paths.deltas, rows)
    return row
  }

  /**
   * 把若干已确认的 delta 写进角色卡，再触发热重载。
   * @param {Array} deltas - 已确认的条目。
   * @param {string} note - 版本备注。
   * @param {string} sessionId - 触发来源会话。
   * @returns {Promise<object>} 新的卡、revision 与重载结果。
   */
  async function applyDeltas(deltas, note, sessionId) {
    const config = cfg()
    const patch = {}
    for (const delta of deltas) {
      if (!config.editableSections.includes(delta.section)) continue
      patch[delta.section] = delta.after
    }
    if (Object.keys(patch).length === 0) throw new Error('persona-evolve: 没有可应用的 delta')
    const role = await writeCard(ctx, config, patch)
    const next = await snapshotRevision(role, note)
    let reload = { remounted: false, moved: [], failed: [], diagnostics: [], skipped: true }
    try {
      reload = await reloadPersona(ctx, config)
      counters.lastReloadAt = new Date().toISOString()
      if (reload.failed.length > 0) warn(`重载期间 ${reload.failed.length} 个会话重绑失败`)
    } catch (error) {
      warn('热重载失败（新会话仍会读到新人设）', error)
    }
    await persistState()
    try {
      const digest = cardDigest(role, config.editableSections, 400)
      console.log(`[persona-evolve] revision v${next} 生效（${sessionId}）：${digest.slice(0, 80)}…`)
    } catch {
      // 诊断输出失败不影响结果。
    }
    return { revision: next, role, reload }
  }

  // ── 学习：候选缓冲 → 一次批量调用 ─────────────────────────────────────────
  async function learnNow(sessionId) {
    const buffer = bufferOf(sessionId)
    if (buffer.learning || buffer.candidates.length === 0) return
    const config = cfg()
    buffer.learning = true
    const batch = buffer.candidates.slice(0, config.batchSize)
    buffer.candidates = buffer.candidates.slice(batch.length)
    buffer.tokens = buffer.candidates.reduce((sum, item) => sum + item.tokens, 0)
    try {
      let role
      try {
        role = roleCard(ctx, config)
      } catch (error) {
        warn('读取角色卡失败，跳过本轮学习', error)
        return
      }
      const prompt = buildLearnPrompt({ candidates: batch, card: role, editable: config.editableSections })
      counters.learnCalls += 1
      const reply = await callModel(ctx, config, prompt.system, prompt.user, config.learnMaxTokens)
      if (process.env.PE_DEBUG) console.warn('[persona-evolve] learn raw:', String(reply).slice(0, 600))
      const parsed = extractJsonObject(reply)
      const result = normalizeLearnResult(parsed, role, config.editableSections)
      if (process.env.PE_DEBUG) console.warn('[persona-evolve] learn normalized:', JSON.stringify(result).slice(0, 400))
      counters.lastLearnAt = new Date().toISOString()
      if (!result.should_learn) {
        await persistState()
        return
      }
      if (config.trustMode) {
        const applied = await applyDeltas(
          result.deltas,
          `自动应用（信任模式）· ${result.reason}`,
          sessionId,
        )
        await store.appendJsonl(paths.deltas, {
          id: `dl_${randomUUID().slice(0, 8)}`,
          createdAt: new Date().toISOString(),
          sessionId,
          sections: result.deltas.map((delta) => delta.section),
          reason: result.reason,
          status: 'auto-applied',
          revision: applied.revision,
        })
      } else {
        await recordSuggested(result.deltas, sessionId, result.reason)
      }
      await persistState()
    } catch (error) {
      warn('批量学习失败（已忽略，不影响对话）', error)
    } finally {
      buffer.learning = false
    }
  }

  function scheduleLearn(sessionId) {
    const config = cfg()
    const buffer = bufferOf(sessionId)
    const shouldLearn = buffer.candidates.length >= config.batchSize || buffer.tokens >= config.batchTokenThreshold
    if (!shouldLearn) return
    const previous = learnQueue.get(sessionId) ?? Promise.resolve()
    const next = previous.then(() => learnNow(sessionId)).catch((error) => warn('学习队列异常', error))
    learnQueue.set(sessionId, next)
  }

  // ── 观察：pre-step 里只做零成本的事 ───────────────────────────────────────
  function observe(payload) {
    const config = cfg()
    if (!config.enabled) return
    const agent = payload?.agent
    if (agent === undefined) return
    // 子代理的提示词不是主人的话，混进来会污染人设：只跟根会话。
    if (agent.parent !== undefined && agent.parent !== null) return
    const sessionId = String(agent.session?.id ?? agent.id ?? 'unknown')
    // 同一个回合可能被多个 step 触发 pre-step：只按第一步计轮，避免重复计入候选。
    if (Number(payload.step ?? 1) > 1) return
    const turn = Number(payload.turn ?? 0)
    const buffer = bufferOf(sessionId)
    const messages = Array.isArray(payload.messages) ? payload.messages : []
    const texts = messages.map(messageText).filter((text) => text.trim() !== '')
    if (texts.length === 0) return
    const joined = texts.join('\n')
    const current = JSON.stringify(config.rules)
    if (current !== rulesSource) {
      rulesSource = current
      rules = compileRules(config.rules)
    }
    const seen = inspect(joined, rules)
    buffer.turns.push({ turn, role: 'user', text: joined })
    if (buffer.turns.length > 40) buffer.turns = buffer.turns.slice(-40)
    if (seen.hit) {
      buffer.candidates.push({ turn, text: seen.text.slice(0, 600), reasons: seen.reasons, tokens: roughTokens(seen.text) })
      buffer.tokens += roughTokens(seen.text)
      counters.candidates += 1
    }
    if (turn !== buffer.lastTurn) {
      buffer.lastTurn = turn
      counters.turnsObserved += 1
      const every = config.shortTermEveryTurns
      if (counters.turnsObserved % every === 0) void refreshShortTerm(sessionId, buffer)
    }
    scheduleLearn(sessionId)
  }

  // ── D：短期摘要 → 阈值时提升长期候选 ─────────────────────────────────────
  async function refreshShortTerm(sessionId, buffer) {
    try {
      const config = cfg()
      const summary = summarizeTurns(buffer.turns, { maxChars: 700 })
      const path = `${paths.sessions}/${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`
      const previous = await store.readJson(path, undefined)
      const record = {
        sessionId,
        updatedAt: new Date().toISOString(),
        turns: buffer.turns.length,
        ...summary,
      }
      await store.writeJsonAtomic(path, record)
      const accumulated = Number(previous?.accumulatedTurns ?? 0) + (summary.turn_range.to - summary.turn_range.from + 1)
      record.accumulatedTurns = accumulated
      await store.writeJsonAtomic(path, record)
      if (accumulated >= config.longTermPromoteTurns) {
        await promoteLongTerm(sessionId, summary, config)
        record.accumulatedTurns = 0
        await store.writeJsonAtomic(path, record)
      }
    } catch (error) {
      warn('短期记忆刷新失败', error)
    }
  }

  async function promoteLongTerm(sessionId, summary, config) {
    let items = []
    if (config.longTermUseLlm) {
      try {
        const prompt = buildLongTermPrompt(summary)
        counters.longTermCalls += 1
        const reply = await callModel(ctx, config, prompt.system, prompt.user, 400)
        items = normalizeLongTermResult(extractJsonObject(reply))
      } catch (error) {
        warn('长期记忆候选生成失败，退回启发式', error)
      }
    }
    if (items.length === 0) {
      items = (summary.key_facts ?? []).slice(0, 3).map((text) => ({ text, evidence: '摘要抽取' }))
    }
    if (items.length === 0) return
    await addLongTermCandidates(items, sessionId)
    await persistState()
  }

  // ── 工具 ─────────────────────────────────────────────────────────────────
  async function digestText() {
    const config = cfg()
    let role
    try {
      role = roleCard(ctx, config)
    } catch (error) {
      return `人设条目不可读：${String(error?.message ?? error)}`
    }
    const maxChars = Math.round(config.digestTokens * 1.6)
    const pending = (await store.readJsonl(paths.deltas)).filter((row) => row.status === 'suggested')
    const memories = await readLongTerm()
    const facts = renderLongTermForPrompt(memories, 240)
    const lines = [
      `人设：${role.name ?? role.id}（revision v${revision}${pending.length > 0 ? `，待确认 ${pending.length} 条` : ''}）`,
      cardDigest(role, config.editableSections, maxChars),
    ]
    if (facts !== '') lines.push(`长期记忆：\n${facts}`)
    const text = lines.join('\n')
    return text.length > maxChars * 2 ? `${text.slice(0, maxChars * 2)}…` : text
  }

  function statusText() {
    const config = cfg()
    const buffered = [...buffers.values()].reduce((sum, buffer) => sum + buffer.candidates.length, 0)
    return [
      `persona-evolve：${config.enabled ? '开启' : '关闭'}`,
      `人设：${config.entryId}/${config.roleId} · revision v${revision}`,
      `学习：${counters.learnCalls} 次批量调用 · 观察 ${counters.turnsObserved} 轮 · 候选 ${counters.candidates} 条（缓冲 ${buffered}）`,
      `长期记忆：${counters.longTermCalls} 次提炼调用`,
      `最近学习：${counters.lastLearnAt || '—'}`,
      `最近重载：${counters.lastReloadAt || '—'}`,
      `信任模式：${config.trustMode ? '开' : '关'}`,
      counters.lastError === '' ? '' : `最近错误：${counters.lastError}`,
    ].filter((line) => line !== '').join('\n')
  }

  async function deltasList(status) {
    const rows = await store.readJsonl(paths.deltas)
    const filtered = status === undefined || status === '' ? rows : rows.filter((row) => row.status === status)
    return filtered.slice(-50).reverse()
  }

  async function confirmDelta(id) {
    const rows = await store.readJsonl(paths.deltas)
    const row = rows.find((item) => item.id === id)
    if (row === undefined) throw new Error(`persona-evolve: 找不到 delta ${id}`)
    if (row.status !== 'suggested') throw new Error(`persona-evolve: ${id} 当前状态为 ${row.status}，不能确认`)
    const applied = await applyDeltas([row], `确认 ${id}`, row.sessionId ?? 'manual')
    await setDeltaStatus(id, 'confirmed')
    await persistState()
    return { id, revision: applied.revision, reload: applied.reload }
  }

  async function rejectDelta(id) {
    const row = await setDeltaStatus(id, 'rejected')
    return { id: row.id, status: row.status }
  }

  async function confirmLongTerm(id) {
    const entries = await readLongTerm()
    const entry = entries.find((item) => item.id === id)
    if (entry === undefined) throw new Error(`persona-evolve: 找不到记忆 ${id}`)
    entry.status = 'confirmed'
    await writeLongTerm(entries)
    return { id, status: 'confirmed' }
  }

  function registerTools() {
    ctx.tools.register({
      name: 'persona_current_digest',
      description: '读取当前人设的简短摘要（≤200 token）与待确认改动数量。只在需要确认当前人设细节时调用。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: textOutput,
      async execute() {
        return await digestText()
      },
    })

    ctx.tools.register({
      name: 'persona_evolve_status',
      description: '查看人设演化插件的运行状态：今日学习调用次数、观察轮数、待确认改动、最近重载时间。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: textOutput,
      async execute() {
        return statusText()
      },
    })

    ctx.tools.register({
      name: 'persona_delta_list',
      description: '列出人设改动建议（默认最近 50 条），可按状态过滤：suggested / confirmed / rejected / auto-applied。',
      parameters: {
        type: 'object',
        properties: { status: { type: 'string', description: '状态过滤；省略则返回全部。' } },
        additionalProperties: false,
      },
      output: textOutput,
      async execute(args) {
        const rows = await deltasList(args?.status)
        if (rows.length === 0) return '没有符合条件的改动建议。'
        return rows
          .map((row) => `${row.id} [${row.status}] ${row.section} · ${String(row.reason ?? '').slice(0, 60)}\n  → ${String(row.after ?? '').slice(0, 160)}`)
          .join('\n')
      },
    })

    ctx.tools.register({
      name: 'persona_delta_confirm',
      description: '确认一条人设改动建议：写入角色卡、生成新 revision，并热重载正在运行的会话（无需重启 dsh）。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '建议 id，形如 dl_xxxxxxxx。' } },
        required: ['id'],
        additionalProperties: false,
      },
      output: textOutput,
      async execute(args) {
        const result = await confirmDelta(String(args.id))
        return `已确认 ${result.id}，人设升至 revision v${result.revision}；重挂 ${result.reload.remounted ? '完成' : '跳过'}，重绑 ${result.reload.moved.length} 个会话。`
      },
    })

    ctx.tools.register({
      name: 'persona_delta_reject',
      description: '拒绝一条人设改动建议，它不会进入人设。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '建议 id。' } },
        required: ['id'],
        additionalProperties: false,
      },
      output: textOutput,
      async execute(args) {
        const row = await rejectDelta(String(args.id))
        return `已拒绝 ${row.id}。`
      },
    })

    ctx.tools.register({
      name: 'persona_memory_confirm',
      description: '把一条「待确认」的长期记忆移入正式区，之后模型才能在对话中看到它。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '记忆 id，形如 lt_xxxxxxxx。' } },
        required: ['id'],
        additionalProperties: false,
      },
      output: textOutput,
      async execute(args) {
        const row = await confirmLongTerm(String(args.id))
        return `记忆 ${row.id} 已转正。`
      },
    })
  }

  // ── E：设置页数据通道（Remote 命名空间 `personaEvolve`） ─────────────────
  class PersonaEvolveRuntime extends TypertRemoteService {
    constructor(context) {
      super(context, 'personaEvolve')
    }
    async getOverview() {
      const config = cfg()
      const rows = await store.readJsonl(paths.deltas)
      const memories = await readLongTerm()
      let card = undefined
      try {
        card = roleCard(ctx, config)
      } catch (error) {
        card = { error: String(error?.message ?? error) }
      }
      return {
        enabled: config.enabled,
        trustMode: config.trustMode,
        entryId: config.entryId,
        roleId: config.roleId,
        revision,
        dataDir: paths.root,
        status: statusText(),
        counts: {
          suggested: rows.filter((row) => row.status === 'suggested').length,
          pendingMemory: memories.filter((entry) => entry.status === 'pending').length,
          confirmedMemory: memories.filter((entry) => entry.status === 'confirmed').length,
        },
        card: card === undefined ? undefined : {
          name: card.name,
          style: card.style,
          rules: card.rules,
          behavior: card.behavior,
        },
      }
    }
    async listDeltas(status) {
      const rows = await deltasList(status)
      return { rows: rows.map((row) => ({
        id: row.id,
        status: row.status,
        section: row.section,
        reason: row.reason,
        before: String(row.before ?? '').slice(0, 800),
        after: String(row.after ?? '').slice(0, 800),
        createdAt: row.createdAt,
        sessionId: row.sessionId,
      })) }
    }
    async confirmDelta(id) {
      return await confirmDelta(String(id))
    }
    async rejectDelta(id) {
      return await rejectDelta(String(id))
    }
    async listShortTerm() {
      const files = await store.listFiles(paths.sessions)
      const rows = []
      for (const file of files.slice(-20)) {
        const record = await store.readJson(file.path, undefined)
        if (record === undefined) continue
        rows.push({
          sessionId: record.sessionId,
          turns: record.turns,
          accumulatedTurns: record.accumulatedTurns ?? 0,
          updatedAt: record.updatedAt,
          summary: String(record.summary ?? ''),
          keyFacts: Array.isArray(record.key_facts) ? record.key_facts : [],
          openQuestions: Array.isArray(record.open_questions) ? record.open_questions : [],
        })
      }
      return { rows: rows.reverse() }
    }
    async listLongTerm() {
      const entries = await readLongTerm()
      return {
        path: paths.longTerm,
        confirmed: entries.filter((entry) => entry.status === 'confirmed'),
        pending: entries.filter((entry) => entry.status === 'pending'),
      }
    }
    async confirmMemory(id) {
      return await confirmLongTerm(String(id))
    }
    async setFlags(patch) {
      const next = {}
      if (typeof patch?.enabled === 'boolean') next.enabled = patch.enabled
      if (typeof patch?.trustMode === 'boolean') next.trustMode = patch.trustMode
      if (Object.keys(next).length > 0) await ctx.settings.update(name, next)
      const config = cfg()
      return { enabled: config.enabled, trustMode: config.trustMode }
    }
    async reloadNow() {
      const result = await reloadPersona(ctx, cfg())
      counters.lastReloadAt = new Date().toISOString()
      await persistState()
      return result
    }
  }

  /** 以纯 JS 应用 TC39 现代装饰器 @Remote（与 dsh-cosplay 相同的做法）。 */
  function markRemoteMethod(proto, methodName) {
    const marker = {
      kind: 'method',
      name: methodName,
      static: false,
      private: false,
      addInitializer(fn) {
        fn.call({})
      },
    }
    try {
      Remote(proto[methodName], marker)
    } catch (error) {
      console.warn(`[persona-evolve] Remote marker 失败（${methodName}）: ${error?.message ?? error}`)
    }
  }

  const REMOTE_METHODS = [
    'getOverview',
    'listDeltas',
    'confirmDelta',
    'rejectDelta',
    'listShortTerm',
    'listLongTerm',
    'confirmMemory',
    'setFlags',
    'reloadNow',
  ]
  for (const method of REMOTE_METHODS) markRemoteMethod(PersonaEvolveRuntime.prototype, method)

  const srcJsonCodec = (typeSymbol) => ({ mode: 'src-json', typeSymbol })
  const jsonParam = (name, typeSymbol) => ({ name, wire: name, source: 'json', codec: srcJsonCodec(typeSymbol) })

  const INVOCATIONS = [
    { id: 'dsh-persona-evolve#personaEvolve/getOverview', service: 'personaEvolve', namespace: 'personaEvolve', method: 'getOverview', invocation: { kind: 'direct' }, parameters: [], result: srcJsonCodec('dsh-persona-evolve#Overview') },
    { id: 'dsh-persona-evolve#personaEvolve/listDeltas', service: 'personaEvolve', namespace: 'personaEvolve', method: 'listDeltas', invocation: { kind: 'direct' }, parameters: [jsonParam('status', 'dsh-persona-evolve#Status')], result: srcJsonCodec('dsh-persona-evolve#DeltaList') },
    { id: 'dsh-persona-evolve#personaEvolve/confirmDelta', service: 'personaEvolve', namespace: 'personaEvolve', method: 'confirmDelta', invocation: { kind: 'direct' }, parameters: [jsonParam('id', 'dsh-persona-evolve#Id')], result: srcJsonCodec('dsh-persona-evolve#Confirm') },
    { id: 'dsh-persona-evolve#personaEvolve/rejectDelta', service: 'personaEvolve', namespace: 'personaEvolve', method: 'rejectDelta', invocation: { kind: 'direct' }, parameters: [jsonParam('id', 'dsh-persona-evolve#Id')], result: srcJsonCodec('dsh-persona-evolve#Reject') },
    { id: 'dsh-persona-evolve#personaEvolve/listShortTerm', service: 'personaEvolve', namespace: 'personaEvolve', method: 'listShortTerm', invocation: { kind: 'direct' }, parameters: [], result: srcJsonCodec('dsh-persona-evolve#ShortTerm') },
    { id: 'dsh-persona-evolve#personaEvolve/listLongTerm', service: 'personaEvolve', namespace: 'personaEvolve', method: 'listLongTerm', invocation: { kind: 'direct' }, parameters: [], result: srcJsonCodec('dsh-persona-evolve#LongTerm') },
    { id: 'dsh-persona-evolve#personaEvolve/confirmMemory', service: 'personaEvolve', namespace: 'personaEvolve', method: 'confirmMemory', invocation: { kind: 'direct' }, parameters: [jsonParam('id', 'dsh-persona-evolve#Id')], result: srcJsonCodec('dsh-persona-evolve#Memory') },
    { id: 'dsh-persona-evolve#personaEvolve/setFlags', service: 'personaEvolve', namespace: 'personaEvolve', method: 'setFlags', invocation: { kind: 'direct' }, parameters: [jsonParam('patch', 'dsh-persona-evolve#Flags')], result: srcJsonCodec('dsh-persona-evolve#FlagsResult') },
    { id: 'dsh-persona-evolve#personaEvolve/reloadNow', service: 'personaEvolve', namespace: 'personaEvolve', method: 'reloadNow', invocation: { kind: 'direct' }, parameters: [], result: srcJsonCodec('dsh-persona-evolve#Reload') },
  ]

  const TYPERT_MANIFEST = {
    package: 'dsh-persona-evolve',
    face: 'host',
    schemas: [],
    model: {
      services: [
        {
          key: 'personaEvolve',
          exportName: 'PersonaEvolveRuntime',
          description: '人设演化状态、改动建议与记忆（dsh-persona-evolve 设置页数据通道）。',
          tags: [],
          members: REMOTE_METHODS.map((method) => ({ kind: 'method', name: method, signature: `${method}(...): unknown` })),
        },
      ],
      events: [],
      objects: [],
    },
    invocations: INVOCATIONS,
  }

  function registerRemote() {
    new PersonaEvolveRuntime(ctx)
    ctx.effect(() => {
      const dispose = ctx.typert.register(TYPERT_MANIFEST)
      return () => {
        void dispose()
      }
    }, 'dsh-persona-evolve: typert manifest')
    ctx.inject(['settings'], (child) => {
      child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
    })
  }

  // ── 装配 ─────────────────────────────────────────────────────────────────
  ctx.on('agent/pre-step', async (payload, next) => {
    try {
      observe(payload)
    } catch (error) {
      warn('pre-step 观察失败', error)
    }
    return next()
  })

  try {
    registerTools()
  } catch (error) {
    warn('工具注册失败', error)
  }

  if (typeof ctx.typert?.register === 'function') {
    try {
      registerRemote()
    } catch (error) {
      warn('设置页数据通道注册失败', error)
    }
  }

  void bootstrap()
    .then(() => {
      console.log(`[persona-evolve] 已启用（${paths.root}）· 规则 ${rules.length} 条 · 人设 ${cfg().entryId}/${cfg().roleId} · 批量 ${cfg().batchSize}`)
    })
    .catch((error) => warn('初始化失败', error))
}
