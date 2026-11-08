/**
 * dsh-persona-evolve — 批量学习器（低频 LLM）。
 *
 * 硬约束：这里**只在**候选缓冲达到阈值时被调用一次，且每次只能看到候选片段与
 * 人设里允许微调的字段（不是全量人设），max_tokens 由配置卡在 800。
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

/** 单次学习允许的最大改动条数（防止一次重写整张卡）。 */
const MAX_DELTAS = 3
/** 单条 delta 的字符增量上限：超过视为重写而非微调。 */
const MAX_DELTA_GROWTH = 160

export function buildLearnPrompt({ candidates, card, editable }) {
  const sections = editable.filter((field) => CARD_FIELD_LABELS[field])
  const current = sections
    .map((field) => `【${field}｜${CARD_FIELD_LABELS[field]}】\n${String(card[field] ?? '（空）').slice(0, 400)}`)
    .join('\n\n')
  const snippets = candidates
    .map((candidate, index) => `${index + 1}. [${candidate.reasons.join('/')}] ${candidate.text.slice(0, 300)}`)
    .join('\n')

  const system = [
    '你是人设维护器，只做小幅、可验证的微调，不重写人格。',
    '输入是「用户最近的候选片段」与「当前人设里允许微调的字段」。',
    '只输出一个 JSON 对象，不要代码块、不要解释文字。',
    'JSON 结构：{"should_learn": boolean, "reason": string, "deltas": [{"section": string, "after": string, "reason": string}]}',
    `规则：section 只能是 ${sections.join(' / ')} 之一；最多 ${MAX_DELTAS} 条 delta；`,
    'after 必须是该字段修改后的完整文本（不是补丁），且与原文相比只是局部调整；',
    '没有足够证据就 should_learn=false、deltas=[]，reason 写一句话。',
  ].join('\n')

  const user = [
    `## 当前人设（仅可微调字段）\n${current || '（无可微调字段）'}`,
    `## 候选片段\n${snippets || '（无）'}`,
  ].join('\n\n')

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
 * 校验并规整学习结果。
 * @param {unknown} parsed - extractJsonObject 的结果。
 * @param {object} card - 当前角色卡。
 * @param {string[]} editable - 允许修改的字段。
 * @returns {{should_learn: boolean, reason: string, deltas: Array}} 规整后的结果。
 */
export function normalizeLearnResult(parsed, card, editable) {
  const empty = { should_learn: false, reason: 'no-valid-result', deltas: [] }
  if (parsed === null || typeof parsed !== 'object') return empty
  const reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : ''
  if (parsed.should_learn !== true) return { should_learn: false, reason: reason || 'declined', deltas: [] }
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
  return { should_learn: deltas.length > 0, reason: reason || 'learned', deltas }
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
