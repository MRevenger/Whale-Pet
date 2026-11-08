/**
 * dsh-persona-evolve — 对话判读器（低频 LLM）。
 *
 * 设计（v2）：不再用关键词预筛决定“值不值得学”。每一批 N 轮真实对话交给模型
 * 自己判读：主人的话里有没有对“怎么说话 / 怎么做”的反馈。模型说不该学，就
 * 什么都不发生；说该学，才产出小幅 delta。
 *
 * 硬约束：每次调用只能看到最近 N 轮对话与少数可变字段，max_tokens ≤ 800；
 * 输出必须是严格 JSON；解析失败就当没学到东西，不猜、不重试轰炸模型。
 */

const CARD_FIELD_LABELS = {
  description: '角色简介',
  personality: '性格',
  style: '说话风格',
  rules: '行为守则',
  behavior: '行为模式',
  scenario: '场景',
  system_prompt: '系统提示',
}

/** 单次判读允许的最大改动条数（防止一次重写整张卡）。 */
const MAX_DELTAS = 2
/** 单条 delta 的字符增量上限：超过视为重写而非微调。 */
const MAX_DELTA_GROWTH = 160

/**
 * 构造判读提示。
 * @param {object} input
 * @param {Array<{turn:number,text:string}>} input.turns - 最近 N 轮主人说的话。
 * @param {object} input.card - 当前角色卡。
 * @param {string[]} input.editable - 允许微调的字段。
 * @param {string} [input.styleNote] - 上一版微调的备注，用于避免来回摇摆。
 */
export function buildLearnPrompt({ turns, card, editable, styleNote }) {
  const sections = editable.filter((field) => CARD_FIELD_LABELS[field])
  const current = sections
    .map((field) => `【${field}｜${CARD_FIELD_LABELS[field]}】\n${String(card[field] ?? '（空）').slice(0, 400)}`)
    .join('\n\n')
  const dialogue = (turns ?? [])
    .map((item, index) => `${index + 1}. 主人：${String(item.text ?? '').slice(0, 300)}`)
    .join('\n')

  const system = [
    '你在维护一个聊天机器人的人设。给你「主人最近说的话」和「当前人设里允许微调的字段」。',
    '任务：判断这段时间里，主人有没有对「它该怎么说话、该怎么做事」表达过要求或示范。',
    '',
    '判断口径：',
    '- 只有涉及表达方式、语气、称呼、口头禅、句式、主动性、边界的内容才算；',
    '- 普通提问、闲聊、让干活、吐槽别人、聊游戏剧情，都不算——should_learn=false；',
    '- 主人明确纠正或提出要求（哪怕语气很随意）算；主人自己示范了想要的说话方式也算；',
    '- 一次只能改一点点：最多 1–2 条，每条是整段替换后的文本，长度增量不超过 160 字；',
    '- 宁可少改也不要猜：证据不足就 false；不要顺手“优化”没被提到的字段。',
    '',
    '只输出一个 JSON 对象，不要代码块、不要解释文字：',
    '{"should_learn": boolean, "reason": string, "evidence": [string], "deltas": [{"section": string, "after": string, "reason": string}]}',
    `section 只能是 ${sections.join(' / ')} 之一；evidence 里引用主人的原话，每条不超过 60 字。`,
  ].join('\n')

  const user = [
    `## 当前人设（仅可微调字段）\n${current || '（无可微调字段）'}`,
    styleNote ? `## 上一版微调\n${styleNote}` : '',
    `## 主人最近说的话\n${dialogue || '（无）'}`,
  ]
    .filter((part) => part !== '')
    .join('\n\n')

  return { system, user }
}

/** 从模型回复里抽出 JSON 对象（容忍 ```json 包裹与前后废话）。 */
export function extractJsonObject(text) {
  const body = String(text ?? '').trim()
  if (body === '') return undefined
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(body)
  const candidate = fenced ? fenced[1] : body
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return undefined
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return undefined
  }
}

/**
 * 校验并规整判读结果。
 * @param {unknown} parsed - extractJsonObject 的结果。
 * @param {object} card - 当前角色卡。
 * @param {string[]} editable - 允许修改的字段。
 * @returns {{should_learn: boolean, reason: string, evidence: string[], deltas: Array}} 规整后的结果。
 */
export function normalizeLearnResult(parsed, card, editable) {
  const empty = { should_learn: false, reason: 'no-valid-result', evidence: [], deltas: [] }
  if (parsed === null || typeof parsed !== 'object') return empty
  const reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : ''
  const evidence = Array.isArray(parsed.evidence)
    ? parsed.evidence.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.slice(0, 120)).slice(0, 3)
    : []
  if (parsed.should_learn !== true) return { should_learn: false, reason: reason || 'declined', evidence, deltas: [] }
  if (!Array.isArray(parsed.deltas)) return empty

  const deltas = []
  for (const raw of parsed.deltas) {
    if (raw === null || typeof raw !== 'object') continue
    const section = typeof raw.section === 'string' ? raw.section.trim() : ''
    if (!editable.includes(section)) continue
    const after = typeof raw.after === 'string' ? raw.after.trim() : ''
    if (after === '') continue
    const before = typeof card[section] === 'string' ? card[section].trim() : ''
    if (after === before) continue
    if (after.length - before.length > MAX_DELTA_GROWTH) continue
    deltas.push({
      section,
      before,
      after,
      reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 200) : '',
    })
    if (deltas.length >= MAX_DELTAS) break
  }
  return { should_learn: deltas.length > 0, reason: reason || 'learned', evidence, deltas }
}

export function buildLongTermPrompt({ summary, keyFacts, openQuestions }) {
  const system = [
    '你从一段对话摘要里提炼值得长期记住的事实，供角色日后回忆。',
    '只输出 JSON：{"entries": [{"text": string, "evidence": string}]}，最多 3 条。',
    '只写客观、可复用的事实或偏好；不要写一次性事件、不要写角色自己的感受、不要编造。',
    '没有值得记的就输出 {"entries": []}。',
  ].join('\n')
  const user = [
    `摘要：${summary || '（空）'}`,
    `事实候选：${(keyFacts ?? []).join('；') || '（无）'}`,
    `未决问题：${(openQuestions ?? []).join('；') || '（无）'}`,
  ].join('\n')
  return { system, user }
}

export function normalizeLongTermResult(parsed) {
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) return []
  const entries = []
  for (const raw of parsed.entries) {
    if (raw === null || typeof raw !== 'object') continue
    const text = typeof raw.text === 'string' ? raw.text.trim() : ''
    if (text === '' || text.length > 240) continue
    entries.push({
      text,
      evidence: typeof raw.evidence === 'string' ? raw.evidence.slice(0, 200) : '',
    })
    if (entries.length >= 3) break
  }
  return entries
}
