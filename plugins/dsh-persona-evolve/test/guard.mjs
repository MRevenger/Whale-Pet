/**
 * 判读结果的护栏测试：模型可以决定改不改，但改动本身必须过这几道闸。
 * 运行：node test/guard.mjs
 */
import { normalizeLearnResult, buildLearnPrompt, extractJsonObject } from '../src/learn.js'

const card = {
  id: 'dafeiyu',
  style: '口语短句，能一句说完就不说两句。',
  rules: '不主动提自己是 AI。',
  behavior: '看到感兴趣的视频会主动分享。',
  personality: '温柔但有点懒。',
}

const editable = ['style', 'rules', 'behavior']
let failed = 0

function check(name, pass, detail) {
  if (!pass) {
    failed += 1
    console.error(`FAIL ${name}${detail ? ` → ${detail}` : ''}`)
  } else {
    console.log(`ok   ${name}`)
  }
}

// 1) 模型说不该学：一条都不许落
const declined = normalizeLearnResult({ should_learn: false, reason: '闲聊', deltas: [{ section: 'style', after: 'x' }] }, card, editable)
check('declined → 0 delta', declined.should_learn === false && declined.deltas.length === 0)

// 2) 不可编辑字段一律丢弃
const kernel = normalizeLearnResult(
  { should_learn: true, reason: 'r', deltas: [{ section: 'personality', after: '完全换个人' }] },
  card,
  editable,
)
check('内核字段被丢弃', kernel.should_learn === false && kernel.deltas.length === 0)

// 3) 大幅重写（增量 > 160 字）被丢弃
const rewrite = normalizeLearnResult(
  { should_learn: true, reason: 'r', deltas: [{ section: 'style', after: '长'.repeat(400) }] },
  card,
  editable,
)
check('重写被丢弃', rewrite.should_learn === false)

// 4) 一次最多两条
const many = normalizeLearnResult(
  {
    should_learn: true,
    reason: 'r',
    deltas: [
      { section: 'style', after: `${card.style} 少用感叹号。` },
      { section: 'rules', after: `${card.rules} 不追问隐私。` },
      { section: 'behavior', after: `${card.behavior} 不主动催更。` },
    ],
  },
  card,
  editable,
)
check('最多两条 delta', many.deltas.length === 2)

// 5) evidence 透传，便于事后回看“凭什么改”
const withEvidence = normalizeLearnResult(
  {
    should_learn: true,
    reason: '主人不喜欢那个/那位式指代',
    evidence: ['以后不要用“xxx的那个”这种句式'],
    deltas: [{ section: 'style', after: `${card.style} 不用“那个/那位”式指代。`, reason: '避开 AI 味' }],
  },
  card,
  editable,
)
check('evidence 透传', withEvidence.evidence.length === 1 && withEvidence.deltas.length === 1)

// 6) 判读提示只带可微调字段，不带内核
const prompt = buildLearnPrompt({ turns: [{ turn: 1, text: '以后说话短点' }], card, editable })
check('提示不含内核字段', !prompt.user.includes('温柔但有点懒'))
check('提示要求严格 JSON', prompt.system.includes('should_learn'))

// 7) 容忍 ```json 包裹
check('容忍代码块包裹', extractJsonObject('```json\n{"a":1}\n```')?.a === 1)

if (failed > 0) {
  console.error(`\n${failed} 项未通过`)
  process.exit(1)
}
console.log('\nPASS: 护栏全部生效')
