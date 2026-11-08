/**
 * dsh-persona-evolve — 规则预筛器（零 LLM）。
 *
 * 这是学习漏斗的第一级：每轮只看用户自己的话，命中教学/纠正/偏好/风格示范/
 * 事实断言才进入候选缓冲。普通闲聊一轮都不会产生候选，因此不会触发任何模型
 * 调用（验收标准 2 的结构性保证）。
 */

/** 内置规则：label 会写进候选的 trigger_reason，pattern 用正则字符串以便配置覆盖。 */
export const DEFAULT_RULES = [
  {
    id: 'teaching',
    label: '教学句式',
    pattern: '你应该|你得|你总是|以后都|每次都|下次要|不要再|不准再|必须得',
  },
  {
    id: 'correction',
    label: '纠正句式',
    pattern: '不对[,，]?是|不是这样|说错了|你搞错|重来|改一下|应该是|别这么',
  },
  {
    id: 'preference',
    label: '偏好表达',
    pattern: '我喜欢|我不喜欢|我讨厌|我希望|我习惯|我想让你|我更喜欢|我爱',
  },
  {
    id: 'style',
    label: '风格示范',
    pattern: '像这样|这种语气|这种口吻|你要用.{0,8}(语气|口吻)|说话(别|要)|别那么(正|官|机)',
  },
  {
    id: 'fact',
    label: '事实断言',
    pattern: '我(今年|住在|在.{1,12}(工作|上班|上学|读))|我的.{1,10}是|我从.{1,10}来',
  },
]

/** 把配置里的字符串规则编译成正则；坏正则只丢该条，不影响其它规则。 */
export function compileRules(configured) {
  const source = Array.isArray(configured) && configured.length > 0 ? configured : DEFAULT_RULES
  const rules = []
  for (const rule of source) {
    if (rule === null || typeof rule !== 'object') continue
    const pattern = typeof rule.pattern === 'string' ? rule.pattern : ''
    if (pattern === '') continue
    try {
      rules.push({
        id: String(rule.id ?? pattern),
        label: String(rule.label ?? rule.id ?? pattern),
        regex: new RegExp(pattern, 'i'),
      })
    } catch {
      // 非法正则：跳过该条。
    }
  }
  return rules
}

/** 抽出一条用户消息里的纯文本（多模态消息只取文字块）。 */
export function messageText(message) {
  if (message === null || typeof message !== 'object') return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * 预筛一条用户消息。
 * @param {string} text - 用户消息正文。
 * @param {Array} rules - compileRules 的结果。
 * @returns {{hit: boolean, reasons: string[], text: string}} 命中信息。
 */
export function inspect(text, rules) {
  const body = String(text ?? '').trim()
  if (body === '') return { hit: false, reasons: [], text: '' }
  const reasons = []
  for (const rule of rules) {
    if (rule.regex.test(body)) reasons.push(rule.label)
  }
  return { hit: reasons.length > 0, reasons, text: body }
}

/** 估算 CJK 友好的「token 量」：一个汉字约 1 token，ASCII 词约 1.3 token。 */
export function roughTokens(text) {
  const body = String(text ?? '')
  let cjk = 0
  let latin = 0
  for (const char of body) {
    if (/[\u3400-\u9fff\uf900-\ufaff]/.test(char)) cjk += 1
    else if (/[A-Za-z0-9]/.test(char)) latin += 1
  }
  return Math.ceil(cjk + latin / 4)
}
