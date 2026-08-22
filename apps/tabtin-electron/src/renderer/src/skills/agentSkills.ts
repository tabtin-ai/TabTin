/**
 * Agent skill 本地扫描（Wave 1 起仅本地用途）。
 *
 * Wave 1（PRD V3.3 §11.5，2026-05-02）：``syncAgentSkills`` 已删除——
 * 草稿不上云路径废弃，本地索引由主进程 LocalSkillRegistry 在 ``~/.agents/skills/`` /
 * sandbox 下扫描。本文件保留 ``scanAgentSkills`` 仅作为本地工具函数。
 */
import type { AgentDefinition, SkillIndexEntry } from './types'
import { createLogger } from '@/utils/logger'

const log = createLogger('Skills')

const SKILLS_DIR = 'skills'
const SKILL_DOC = 'SKILL.md'
const AGENTS_DIR = 'agents'
const DEFAULT_MAX_BYTES = 64 * 1024

const joinPath = (base: string, next: string): string => {
  if (!base) return next
  const sep = base.includes('\\') ? '\\' : '/'
  if (base.endsWith(sep)) return `${base}${next}`
  return `${base}${sep}${next}`
}

const joinRelative = (...parts: string[]): string => {
  return parts.filter(Boolean).join('/')
}

type FrontmatterValue = string | string[]

const stripQuotes = (s: string): string => s.replace(/^["']|["']$/g, '')

const parseInlineArray = (raw: string): string[] =>
  raw.split(',').map(s => stripQuotes(s.trim())).filter(Boolean)

const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** slug / 目录名 → Title Case 展示名兜底（`table-operator` → `Table Operator`）。 */
const beautifySkillSlug = (slug: string): string => {
  if (!slug) return ''
  const seg = slug.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? slug
  const words = seg.split(/[-_\s]+/).filter(Boolean)
  if (!words.length) return seg
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

export const parseFrontmatter = (lines: string[]): { data: Record<string, FrontmatterValue>; bodyStart: number } => {
  if (!lines.length || lines[0].trim() !== '---') return { data: {}, bodyStart: 0 }
  const data: Record<string, FrontmatterValue> = {}
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (line === '---') return { data, bodyStart: i + 1 }
    const idx = line.indexOf(':')
    if (idx > 0) {
      const key = line.slice(0, idx).trim().toLowerCase()
      if (!key) continue
      const raw = line.slice(idx + 1).trim()

      const bracketMatch = raw.match(/^\[(.*)]\s*$/)
      if (bracketMatch) {
        data[key] = parseInlineArray(bracketMatch[1])
        continue
      }

      if (!raw) {
        const items: string[] = []
        let j = i + 1
        while (j < lines.length) {
          const nextLine = lines[j]
          if (nextLine.trim() === '---') break
          const itemMatch = nextLine.match(/^\s+-\s+(.+)/)
          if (!itemMatch) break
          items.push(stripQuotes(itemMatch[1].trim()))
          j += 1
        }
        if (items.length > 0) {
          data[key] = items
          i = j - 1
          continue
        }
      }

      data[key] = raw
    }
  }
  return { data: {}, bodyStart: 0 }
}

const fmString = (data: Record<string, FrontmatterValue>, key: string): string => {
  const v = data[key]
  if (!v) return ''
  return Array.isArray(v) ? v.join(', ') : v
}

const fmArray = (data: Record<string, FrontmatterValue>, key: string): string[] => {
  const v = data[key]
  if (!v) return []
  if (Array.isArray(v)) return v
  return v.split(',').map(s => s.trim()).filter(Boolean)
}

const parseSkillDoc = (content: string) => {
  const lines = content.split('\n')
  const { data, bodyStart } = parseFrontmatter(lines)
  const name = fmString(data, 'name')
  let description = fmString(data, 'description')
  // version：缩进的 `metadata.version`（key 被 trim 提升为顶层）与顶层 version 都落在
  // 'version'，所以新旧格式都能读到。
  const version = fmString(data, 'version')
  // displayName 归一（不回退 `#` 一级标题）：metadata.tabtin.displayName（提升后 key
  // 小写为 displayname）→ 旧格式顶层 name(非 kebab)；都没有则留空，交由扫描层按目录名美化。
  const explicitDisplay = fmString(data, 'displayname') || fmString(data, 'display_name')
  const displayName = explicitDisplay || (name && !KEBAB_RE.test(name) ? name : '')

  if (!description) {
    const paragraph: string[] = []
    for (let i = bodyStart; i < lines.length; i += 1) {
      const line = lines[i].trim()
      if (!line) {
        if (paragraph.length) break
        continue
      }
      if (line.startsWith('#')) continue
      paragraph.push(line)
    }
    description = paragraph.join(' ').trim()
  }

  return {
    name: name || '',
    displayName: displayName || '',
    description: description || '',
    version: version || ''
  }
}

const parseAgentDoc = (content: string, filename: string): AgentDefinition | null => {
  const lines = content.split('\n')
  const { data, bodyStart } = parseFrontmatter(lines)
  const name = fmString(data, 'name')
  if (!name) return null

  let description = fmString(data, 'description')
  if (!description) {
    const paragraph: string[] = []
    for (let i = bodyStart; i < lines.length; i += 1) {
      const line = lines[i].trim()
      if (!line) {
        if (paragraph.length) break
        continue
      }
      if (line.startsWith('#')) continue
      paragraph.push(line)
    }
    description = paragraph.join(' ').trim()
  }

  const toolDomains = fmArray(data, 'tool_domains')

  return {
    filename,
    name,
    description: description || undefined,
    model: fmString(data, 'model') || undefined,
    reply_mode: fmString(data, 'reply_mode') || undefined,
    tool_domains: toolDomains.length ? toolDomains : undefined,
  }
}

interface TabtinFS {
  readDir: (path: string) => Promise<{ success?: boolean; entries?: Array<{ name: string; path: string; isDirectory: boolean }> } | null>
  readFilePreview: (path: string, opts: { maxBytes: number }) => Promise<{ success?: boolean; data?: { kind: string; content?: string } } | null>
}

const scanAgentsDir = async (fs: TabtinFS, skillDirPath: string): Promise<AgentDefinition[]> => {
  const agentsPath = joinPath(skillDirPath, AGENTS_DIR)
  const dirResult = await fs.readDir(agentsPath)
  if (!dirResult?.success || !Array.isArray(dirResult.entries)) return []

  const agents: AgentDefinition[] = []
  for (const file of dirResult.entries) {
    if (file.isDirectory || !file.name?.endsWith('.md')) continue
    const preview = await fs.readFilePreview(file.path, { maxBytes: DEFAULT_MAX_BYTES })
    if (!preview?.success || preview?.data?.kind !== 'text') continue
    const agentDef = parseAgentDoc(preview.data?.content || '', file.name)
    if (agentDef) {
      agents.push(agentDef)
    } else {
      log.warn('agent doc missing required "name" field, skipped:', { file: `agents/${file.name}` })
    }
  }
  return agents
}

export const scanAgentSkills = async (agentRoot: string): Promise<SkillIndexEntry[]> => {
  const tabtin = window.tabtin
  if (!tabtin?.fileSystem?.readDir || !tabtin?.fileSystem?.readFilePreview) return []

  const skillsRoot = joinPath(agentRoot, SKILLS_DIR)
  const dirResult = await tabtin.fileSystem.readDir(skillsRoot)
  if (!dirResult?.success || !Array.isArray(dirResult.entries)) return []

  const skills: SkillIndexEntry[] = []

  for (const entry of dirResult.entries) {
    if (!entry?.isDirectory) continue
    const skillId = entry.name
    if (!skillId) continue

    const docPath = joinPath(entry.path, SKILL_DOC)
    const preview = await tabtin.fileSystem.readFilePreview(docPath, { maxBytes: DEFAULT_MAX_BYTES })
    if (!preview?.success || preview?.data?.kind !== 'text') continue
    const content = preview.data?.content || ''
    const parsed = parseSkillDoc(content)

    const name = parsed.name || skillId
    const displayName = parsed.displayName || beautifySkillSlug(skillId)
    const description = parsed.description || undefined
    const version = parsed.version || undefined

    const agents = await scanAgentsDir(tabtin.fileSystem as TabtinFS, entry.path)

    skills.push({
      skill_id: skillId,
      name,
      display_name: displayName,
      description,
      version,
      source: 'user',
      app_id: null,
      path: joinRelative(SKILLS_DIR, skillId),
      doc_path: joinRelative(SKILLS_DIR, skillId, SKILL_DOC),
      status: 'enabled',
      ...(agents.length ? { agents } : {}),
    })
  }

  return skills
}

/**
 * @deprecated Wave 3b M9: 文件监听统一由主进程 SkillDirWatcher 处理，
 * 渲染进程通过 IPC 'skills:dir-changed' 事件触发同步。
 * 这两个函数保留为 no-op 以兼容未更新的调用方。
 */
export const startAgentSkillsWatcher = async (_spaceId: string, _agentRoot: string) => {}
export const stopAgentSkillsWatcher = async (_spaceId: string) => {}
