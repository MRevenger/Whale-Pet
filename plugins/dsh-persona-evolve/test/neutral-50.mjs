// 验收 2：连续 50 轮普通对话不产生学习候选（预筛器零 LLM、纯正则）。
import { inspect, compileRules, DEFAULT_RULES, roughTokens } from '../src/prescreen.js'

const NEUTRAL = [
  '今天服务器负载怎么样', '帮我看下 10930 端口通了没', '这个视频点赞数多少', '现在几点了',
  '把日志最后 20 行贴出来', '磁盘还剩多少空间', '这个 BV 号对应什么视频', 'DNS 解析正常吗',
  '刚才那条评论发出去了吗', '内存占用高不高', 'nginx 配置有没有语法错误', '跑一下 status 接口',
  '昨天的日报在哪', '收藏夹里现在有几个视频', 'QQ 掉线了没有', '向量服务活着吗',
  '看一下定时器下次触发时间', '这个字符串是合法的 YAML 吗', 'stderr 里有异常吗', '上一次重启是什么时候',
  'docker 容器跑了多久', 'bge-m3 模型多大', '配置里 batchSize 是多少', '这条日志是哪个进程打的',
  'crontab 里有几条任务', '备份目录多大', '现在有多少个会话', '这个接口返回 200 吗',
  '帮我算一下 17 乘 23', '把 uname -a 的输出给我', '当前系统时间戳', 'nginx 版本是多少',
  'llama-server 进程还在吗', '收藏夹 id 是多少', '这个文件的第一行是什么', '看下 df -h',
  '服务依赖顺序对不对', '这个端口被谁占用了', 'json 能不能解析', '看下今天的 out 目录',
  '有没有新的 delta', '当前 revision 是几', '这个查询返回几行', 'sudo 可用吗',
  '系统负载 1 分钟值', 'swap 用了多少', 'cookies 过期了吗', '这个进程的 PID', '网络延迟多少',
  '现在能连上 SnowLuma 吗',
]

const rules = compileRules(DEFAULT_RULES)
const hits = []
let tokens = 0
NEUTRAL.forEach((text, index) => {
  const result = inspect(text, rules)
  tokens += roughTokens(text)
  if (result.hit) hits.push({ turn: index + 1, text, reasons: result.reasons })
})
console.log(JSON.stringify({ turns: NEUTRAL.length, candidates: hits.length, hits, tokens }, null, 2))
if (hits.length !== 0) {
  console.error('FAIL: 普通对话不应触发学习候选')
  process.exit(1)
}
console.log('PASS: 50 轮普通对话 0 候选 → 0 次学习 LLM 调用')
