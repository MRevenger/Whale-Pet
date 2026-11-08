/**
 * dsh-persona-evolve — 记忆层（短期摘要 + 长期明文文件）。
 *
 * 短期记忆：纯启发式抽取（句频打分 + 事实/疑问句筛选），**不调用模型**，因此
 * 每轮都能安全刷新。
 * 长期记忆：`long_term.md` 是事实源，分「正式 / 待确认」两区；只有确认后的条目
 * 才会被模型看到，而且它**不直接改人设**——人设只走 delta 路径。
 */

const FACT_PATTERNS = [
  /我(?:今年|住在|在.{1,12}(?:工作|上班|上学|读))/,
  /我的.{1,10}是/,
  /我(?:喜欢|讨厌|习惯|希望)/,
  /我从.{1,10}来/,
]

/** 把一段文本切成句子（中英文标点都认）。 */
export function splitSentences(text) {
  return String(text ?? '')
    .split(/(?<=[。！？!?；;])\s*|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4)
}

/** 中文二元组 + 英文词的粗粒度词频，用来给句子打分。 */
function termFrequency(sentences) {
  const counts = new Map()
  const bump = (term) => counts.set(term, (counts.get(term) ?? 0) + 1)
  for (const sentence of sentences) {
    const cjk = sentence.match(/[\u3400-\u9fff]{2,}/g) ?? []
    for (const run of cjk) {
      for (let i = 0; i + 1 < run.length; i++) bump(run.slice(i, i + 2))
    }
    for (const word of sentence.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) ?? []) bump(word.toLowerCase())
  }
  return counts
}

function scoreSentence(sentence, counts, index) {
  let score = 0
  const cjk = sentence.match(/[\u3400-\u9fff]{2,}/g) ?? []
  for (const run of cjk) {
    for (let i = 0; i + 1 < run.length; i++) score += counts.get(run.slice(i, i + 2)) ?? 0
  }
  for (const word of sentence.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) ?? []) {
    score += counts.get(word.toLowerCase()) ?? 0
  }
  // 位置加权：越靠后越新，记忆里新鲜的更值得留。
  return score / Math.sqrt(sentence.length) + index * 0.35
}

/** 抽取可提取的事实断言句。 */
export function extractFacts(text) {
  return splitSentences(text).filter((sentence) => FACT_PATTERNS.some((pattern) => pattern.test(sentence)))
}

/**
 * 生成一次短期摘要。
 * @param {{turn: number, role: string, text: string}[]} turns - 窗口内的轮次。
 * @param {{maxChars?: number}} options - 摘要长度上限。
 * @returns {{summary: string, key_facts: string[], open_questions: string[], turn_range: object}} 摘要对象。
 */
export function summarizeTurns(turns, options = {}) {
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : 700
  const valid = turns.filter((turn) => typeof turn?.text === 'string' && turn.text.trim() !== '')
  if (valid.length === 0) {
    return { summary: '', key_facts: [], open_questions: [], turn_range: { from: 0, to: 0 } }
  }
  const sentences = []
  for (const turn of valid) {
    for (const sentence of splitSentences(turn.text)) sentences.push({ sentence, turn: turn.turn, index: sentences.length })
  }
  const counts = termFrequency(sentences.map((item) => item.sentence))
  const ranked = sentences
    .map((item) => ({ ...item, score: scoreSentence(item.sentence, counts, item.index) }))
    .sort((a, b) => b.score - a.score)

  const picked = []
  let chars = 0
  for (const item of ranked) {
    if (chars + item.sentence.length > maxChars) continue
    picked.push(item)
    chars += item.sentence.length
    if (picked.length >= 5) break
  }
  picked.sort((a, b) => a.index - b.index)

  const keyFacts = []
  const openQuestions = []
  for (const turn of valid) {
    for (const fact of extractFacts(turn.text)) if (!keyFacts.includes(fact)) keyFacts.push(fact)
    for (const sentence of splitSentences(turn.text)) {
      if (/[？?]\s*$/.test(sentence) && !openQuestions.includes(sentence)) openQuestions.push(sentence)
    }
  }

  return {
    summary: picked.map((item) => item.sentence).join(''),
    key_facts: keyFacts.slice(0, 8),
    open_questions: openQuestions.slice(0, 5),
    turn_range: {
      from: Math.min(...valid.map((turn) => turn.turn)),
      to: Math.max(...valid.map((turn) => turn.turn)),
    },
  }
}

/** 长期记忆条目的磁盘格式：一行一条，人可读、可手改。 */
export function renderLongTerm(entries) {
  const formatTime = (iso) => String(iso ?? '').slice(0, 16).replace('T', ' ')
  const line = (entry) => `- ${formatTime(entry.createdAt)} · ${entry.text} · ${entry.source ?? 'unknown'} · ${entry.id}`
  const confirmed = entries.filter((entry) => entry.status === 'confirmed')
  const pending = entries.filter((entry) => entry.status === 'pending')
  return [
    '# 长期记忆',
    '',
    '> 明文事实源，可直接编辑。`待确认` 区的条目在确认前不会被模型看到，也不会改动人设。',
    '> 每行格式：`- 时间 · 内容 · 来源 · id`。删行即删除该条记忆。',
    '',
    '## 正式',
    '',
    ...(confirmed.length === 0 ? ['（空）'] : confirmed.map(line)),
    '',
    '## 待确认',
    '',
    ...(pending.length === 0 ? ['（空）'] : pending.map(line)),
    '',
  ].join('\n')
}

/** 解析长期记忆文件；人工改动（增删行、调整顺序）都能被读回。 */
export function parseLongTerm(text) {
  const entries = []
  let section = 'confirmed'
  for (const raw of String(text ?? '').split('\n')) {
    const trimmed = raw.trim()
    if (trimmed.startsWith('## ')) {
      section = trimmed.includes('待确认') ? 'pending' : 'confirmed'
      continue
    }
    if (!trimmed.startsWith('- ')) continue
    const body = trimmed.slice(2)
    if (body === '（空）') continue
    const parts = body.split(' · ')
    if (parts.length < 4) continue
    const id = parts[parts.length - 1].trim()
    const source = parts[parts.length - 2].trim()
    const createdAt = parts[0].trim()
    const content = parts.slice(1, parts.length - 2).join(' · ').trim()
    if (content === '' || id === '') continue
    entries.push({ id, text: content, source, createdAt, status: section })
  }
  return entries
}

/** 把记忆条目渲染成给模型看的短段落（只含正式区）。 */
export function renderLongTermForPrompt(entries, maxChars = 800) {
  const confirmed = entries.filter((entry) => entry.status === 'confirmed')
  if (confirmed.length === 0) return ''
  const lines = []
  let chars = 0
  for (const entry of confirmed.slice(-20)) {
    const line = `- ${entry.text}`
    if (chars + line.length > maxChars) break
    lines.push(line)
    chars += line.length
  }
  return lines.join('\n')
}
