/**
 * dsh-persona-evolve — 明文存储层。
 *
 * 设计约束（来自任务规格）：长期记忆与版本必须以用户可读的明文落盘，
 * 向量/索引只能作为加速层。因此这里只有 JSON / JSONL / Markdown，写盘一律
 * 走「临时文件 + rename」的原子替换，避免半截文件。
 */
import { appendFile, mkdir, readFile, rename, writeFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 数据根目录：配置优先，否则 $DSH_HOME/persona-evolve（默认 ~/.dsh）。 */
export function resolveDataDir(config) {
  const configured = typeof config?.dataDir === 'string' ? config.dataDir.trim() : ''
  if (configured !== '') return configured
  const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(dshHome, 'persona-evolve')
}

/** 目录布局：全部是给人看的普通文件。 */
export function layout(root) {
  return {
    root,
    backups: join(root, 'backups'),
    revisions: join(root, 'persona-revisions'),
    current: join(root, 'current_revision.json'),
    deltas: join(root, 'persona_revisions.jsonl'),
    longTerm: join(root, 'long_term.md'),
    sessions: join(root, 'session-memory'),
    state: join(root, 'state.json'),
  }
}

export async function ensureLayout(paths) {
  await mkdir(paths.backups, { recursive: true })
  await mkdir(paths.revisions, { recursive: true })
  await mkdir(paths.sessions, { recursive: true })
}

export async function readText(path) {
  if (!existsSync(path)) return undefined
  return await readFile(path, 'utf8')
}

export async function writeTextAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

export async function readJson(path, fallback) {
  const text = await readText(path)
  if (text === undefined || text.trim() === '') return fallback
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

export async function writeJsonAtomic(path, value) {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** Append-only 的 JSONL 事实源；一行一条，行序即时间序。 */
export async function appendJsonl(path, record) {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8')
}

export async function readJsonl(path) {
  const text = await readText(path)
  if (text === undefined || text.trim() === '') return []
  const rows = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      rows.push(JSON.parse(trimmed))
    } catch {
      // 坏行不阻断整体：明文文件允许人工编辑，跳过即可。
    }
  }
  return rows
}

/** 用最后一条同 id 记录覆盖的方式重写 JSONL（状态迁移用）。 */
export async function rewriteJsonl(path, rows) {
  const body = rows.map((row) => JSON.stringify(row)).join('\n')
  await writeTextAtomic(path, body === '' ? '' : `${body}\n`)
}

/** 列出某个目录里匹配前缀的文件（版本号排序交给调用方）。 */
export async function listFiles(dir) {
  if (!existsSync(dir)) return []
  const names = await readdir(dir)
  const files = []
  for (const name of names) {
    const full = join(dir, name)
    try {
      const info = await stat(full)
      files.push({ name, path: full, mtimeMs: info.mtimeMs, size: info.size })
    } catch {
      // 并发删除：忽略。
    }
  }
  return files
}

/** 生成 vN 版本的相对序号。 */
export function nextRevisionNumber(names) {
  let max = 0
  for (const name of names) {
    const match = /^v(\d+)\.md$/.exec(name)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return max + 1
}

/** 简易内容指纹：用于判断卡是否真的变了（避免无意义的重载）。 */
export function fingerprint(text) {
  let hash = 2166136261
  const source = String(text)
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
