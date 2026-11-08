/** 从一条会话消息里取出可读文本（容忍 content 是字符串或 block 数组）。 */
export function messageText(message) {
  if (typeof message === 'string') return message
  if (message === null || typeof message !== 'object') return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (block === null || typeof block !== 'object') return ''
      if (typeof block.text === 'string') return block.text
      return ''
    })
    .filter((text) => text !== '')
    .join('\n')
}
