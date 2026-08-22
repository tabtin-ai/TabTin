/**
 * SKILL.md 纯函数工具：解析 / 生成 / 校验。
 *
 * **不再** 在 renderer 拼 platform-data 物理路径——见 `skill:write-content` /
 * `skill:resolve-path` surface（避免漏传 organizationId 落到 `_unscoped`，导致
 * LocalSkillRegistry 扫不到）。renderer 只持 `spaceId/organizationId/skillKey/content`。
 */

import { slugifySkillName } from './skillSlug'

export interface ParsedSkillMd {
  /** kebab 机器 id（新格式顶层 name）；旧格式里可能是人类标题。 */
  name: string
  /** 归一化展示名：metadata.tabtin.displayName / 旧 name(非kebab) / slug 美化。 */
  displayName: string
  description: string
  /** 历史文件兼容读取；新发布版本以数据库发布记录为准。 */
  version: string
  body: string
  rawFrontmatter: Record<string, string>
}

const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function scalarFrontmatterKey(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  const colon = trimmed.indexOf(':')
  if (colon <= 0) return null
  return trimmed.slice(0, colon).trim()
}

function leadingSpaceCount(line: string): number {
  const match = line.match(/^ */)
  return match ? match[0].length : 0
}

/** slug / 名称 → Title Case 展示名兜底（`table-operator` → `Table Operator`）。 */
function beautifySkillName(slug: string): string {
  if (!slug) return ''
  const seg = slug.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? slug
  const words = seg.split(/[-_\s]+/).filter(Boolean)
  if (!words.length) return seg
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

export function skillSlugFromKey(skillKey: string): string {
  const idx = skillKey.indexOf(':')
  return idx >= 0 ? skillKey.slice(idx + 1) : skillKey
}

/**
 * 解析 SKILL.md frontmatter（归一化双读新旧格式）。
 *
 * 逐行扁平扫描：缩进的嵌套 scalar（历史 `metadata.version` /
 * `metadata.tabtin.displayName`）因为 key 被 trim，会被提升为顶层键——所以
 * version / displayName 双格式都能读到。本工具只取 name / description /
 * version / displayName 四个 scalar，不需要嵌套数组/对象，
 * 故不引入 YAML 库（rich 字段由 agent-runtime / Django 的 YAML 解析器负责）。
 */
export function parseSkillMd(content: string): ParsedSkillMd {
  const empty = (body: string): ParsedSkillMd => ({
    name: '', displayName: '', description: '', version: '', body, rawFrontmatter: {},
  })
  const trimmed = content.trimStart()
  if (!trimmed.startsWith('---')) return empty(content.trim())

  const match = trimmed.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
  if (!match) return empty(content.trim())

  const rawFrontmatter: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim()
    let value = line.slice(colon + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    rawFrontmatter[key] = value
  }

  const name = rawFrontmatter.name ?? ''
  // version 仅用于读取历史 SKILL.md；发布版本来自数据库 SkillPublishedVersion。
  const version = rawFrontmatter.version ?? ''
  // displayName：metadata.tabtin.displayName（提升）→ 旧格式顶层 name(非 kebab) → 美化。
  const displayName =
    rawFrontmatter.displayName
    || rawFrontmatter.display_name
    || (name && !KEBAB_RE.test(name) ? name : '')
    || beautifySkillName(name)

  return {
    name,
    displayName,
    description: rawFrontmatter.description ?? '',
    version,
    body: match[2].trim(),
    rawFrontmatter,
  }
}

/**
 * Remove file-maintained version fields from SKILL.md frontmatter.
 *
 * Published versions are owned by SkillPublishedVersion.version_label. The
 * editor should not expose legacy top-level `version` or `metadata.version`
 * as something users can maintain in the source file.
 */
export function stripSkillMdFileVersion(content: string): string {
  const trimmed = content.trimStart()
  const leading = content.slice(0, content.length - trimmed.length)
  if (!trimmed.startsWith('---')) return content

  const match = trimmed.match(/^(---\s*\n)([\s\S]*?)(\n---\s*\n?)([\s\S]*)$/)
  if (!match) return content

  const lines = match[2].split('\n')
  const stack: Array<{ indent: number; key: string }> = []
  const nextLines = lines.filter(line => {
    const key = scalarFrontmatterKey(line)
    if (!key) return true

    const indent = leadingSpaceCount(line)
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop()
    }
    const parent = stack[stack.length - 1]
    const shouldDrop =
      key === 'version'
      && (indent === 0 || (parent?.key === 'metadata' && parent.indent === 0))

    const value = line.slice(line.indexOf(':') + 1).trim()
    if (!shouldDrop && value === '') {
      stack.push({ indent, key })
    }
    return !shouldDrop
  })

  return `${leading}${match[1]}${nextLines.join('\n')}${match[3]}${match[4]}`
}

/**
 * 把 SKILL.md 顶层 `name` 写成唯一机器 slug（通常=目录名 / 后端 skill_key 后缀）。
 *
 * 导入撞名时后端会给 `algorithmic-art-2`，但上游 SKILL.md 仍写 `name: algorithmic-art`。
 * Agent 扫描若跟 frontmatter name，会与首份同名 skill 撞 key，后导入的被丢掉。
 * 物化时对齐 name，避免「面板已启用、斜杠命令 skill_not_found」。
 */
export function ensureSkillMdName(content: string, canonicalSlug: string): string {
  const slug = canonicalSlug.trim()
  if (!slug || !KEBAB_RE.test(slug)) return content

  const trimmed = content.trimStart()
  const leading = content.slice(0, content.length - trimmed.length)
  const match = trimmed.match(/^(---\s*\n)([\s\S]*?)(\n---\s*\n?)([\s\S]*)$/)
  if (!match) return content

  const lines = match[2].split('\n')
  let replaced = false
  const nextLines = lines.map((line) => {
    const key = scalarFrontmatterKey(line)
    if (key !== 'name') return line
    // 只改顶层 name（indent=0）；嵌套字段不碰。
    if (leadingSpaceCount(line) !== 0) return line
    replaced = true
    return `name: ${slug}`
  })
  if (!replaced) {
    nextLines.unshift(`name: ${slug}`)
  }
  return `${leading}${match[1]}${nextLines.join('\n')}${match[3]}${match[4]}`
}

/** 缺省 description 时用 displayName / name 兜底，与 generateSkillSkeleton 口径一致。 */
export function ensureSkillMdDescription(content: string): string {
  const parsed = parseSkillMd(content)
  if (parsed.description.trim()) return content

  const fallback = (
    parsed.displayName.trim()
    || beautifySkillName(parsed.name)
    || parsed.name.trim()
  ).trim()
  if (!fallback) return content

  const trimmed = content.trimStart()
  const leading = content.slice(0, content.length - trimmed.length)
  const match = trimmed.match(/^(---\s*\n)([\s\S]*?)(\n---\s*\n?)([\s\S]*)$/)
  if (!match) return content

  const safe = fallback.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const lines = match[2].split('\n')
  let replaced = false
  const nextLines = lines.map((line) => {
    const key = scalarFrontmatterKey(line)
    if (key !== 'description') return line
    replaced = true
    const indent = line.match(/^ */)?.[0] ?? ''
    return `${indent}description: "${safe}"`
  })
  if (!replaced) {
    const inserted: string[] = []
    let done = false
    for (const line of nextLines) {
      inserted.push(line)
      if (!done && scalarFrontmatterKey(line) === 'name') {
        inserted.push(`description: "${safe}"`)
        done = true
      }
    }
    if (!done) inserted.unshift(`description: "${safe}"`)
    return `${leading}${match[1]}${inserted.join('\n')}${match[3]}${match[4]}`
  }
  return `${leading}${match[1]}${nextLines.join('\n')}${match[3]}${match[4]}`
}

function quoteFrontmatterScalar(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * 标题栏改名 → 同步 SKILL.md 里名称相关字段（编辑缓冲用）：
 * - 顶层 `name`（kebab 机器 id）
 * - `description`（仅当原先为空 / 等于旧展示名时，避免覆盖自定义说明）
 * - `metadata.tabtin.displayName`（或顶层 displayName）
 * - 正文首个 `#` 标题（仅当等于旧展示名时）
 */
export function applySkillDisplayNameToSkillMd(content: string, nextDisplayName: string): string {
  const nextDisplay = (nextDisplayName || '').trim()
  if (!nextDisplay) return content

  const parsed = parseSkillMd(content)
  const prevDisplay = (parsed.displayName || '').trim()
  const prevDescription = (parsed.description || '').trim()
  const nextSlug = slugifySkillName(nextDisplay)
  // 纯中文等场景 slugify 会落到兜底 `skill`——此时保留原机器名，避免把
  // `skill-test-update-name` 误改成无区分度的 `skill`。
  const shouldSyncName = Boolean(nextSlug) && nextSlug !== 'skill'
  const quotedDisplay = quoteFrontmatterScalar(nextDisplay)
  const shouldSyncDescription = !prevDescription || prevDescription === prevDisplay

  const trimmed = content.trimStart()
  const leading = content.slice(0, content.length - trimmed.length)
  const match = trimmed.match(/^(---\s*\n)([\s\S]*?)(\n---\s*\n?)([\s\S]*)$/)
  if (!match) {
    // 无 frontmatter：尽量只改正文首个 H1
    const body = content.replace(/^(\s*#\s+)([^\n]*)/, (_full, prefix: string, title: string) => {
      if (!prevDisplay || title.trim() === prevDisplay) return `${prefix}${nextDisplay}`
      return `${prefix}${title}`
    })
    return body
  }

  const lines = match[2].split('\n')
  let replacedName = false
  let replacedDescription = false
  let replacedDisplayName = false
  const nextLines = lines.map((line) => {
    const key = scalarFrontmatterKey(line)
    if (!key) return line
    const indent = line.match(/^ */)?.[0] ?? ''
    if (key === 'name' && leadingSpaceCount(line) === 0 && shouldSyncName) {
      replacedName = true
      return `name: ${nextSlug}`
    }
    if (key === 'description' && shouldSyncDescription) {
      replacedDescription = true
      return `${indent}description: ${quotedDisplay}`
    }
    if (key === 'displayName' || key === 'display_name') {
      replacedDisplayName = true
      return `${indent}${key}: ${quotedDisplay}`
    }
    return line
  })

  if (shouldSyncName && !replacedName) {
    nextLines.unshift(`name: ${nextSlug}`)
  }
  if (shouldSyncDescription && !replacedDescription) {
    const inserted: string[] = []
    let done = false
    for (const line of nextLines) {
      inserted.push(line)
      if (!done && scalarFrontmatterKey(line) === 'name' && leadingSpaceCount(line) === 0) {
        inserted.push(`description: ${quotedDisplay}`)
        done = true
      }
    }
    if (!done) inserted.unshift(`description: ${quotedDisplay}`)
    nextLines.splice(0, nextLines.length, ...inserted)
  }
  if (!replacedDisplayName) {
    // 优先插到 tabtin: 块下；否则补最小 metadata.tabtin 结构。
    const tabtinIdx = nextLines.findIndex((line) => {
      return scalarFrontmatterKey(line) === 'tabtin' && line.trimEnd().endsWith(':')
    })
    if (tabtinIdx >= 0) {
      const tabtinIndent = leadingSpaceCount(nextLines[tabtinIdx])
      nextLines.splice(tabtinIdx + 1, 0, `${' '.repeat(tabtinIndent + 2)}displayName: ${quotedDisplay}`)
    } else {
      const metaIdx = nextLines.findIndex((line) => {
        return scalarFrontmatterKey(line) === 'metadata' && leadingSpaceCount(line) === 0
      })
      if (metaIdx >= 0) {
        nextLines.splice(
          metaIdx + 1,
          0,
          '  tabtin:',
          `    displayName: ${quotedDisplay}`,
        )
      } else {
        nextLines.push('metadata:', '  tabtin:', `    displayName: ${quotedDisplay}`)
      }
    }
  }

  let body = match[4]
  body = body.replace(/^(\s*#\s+)([^\n]*)/, (full, prefix: string, title: string) => {
    if (!prevDisplay || title.trim() === prevDisplay) return `${prefix}${nextDisplay}`
    return full
  })

  return `${leading}${match[1]}${nextLines.join('\n')}${match[3]}${body}`
}

export function generateSkillSkeleton(
  displayName: string,
  description: string,
  category?: string | null,
  /** kebab-case 机器标识（= slug / 目录名）；缺省时按展示名归一化 */
  slug?: string | null,
): string {
  const display = (displayName || '').trim() || 'Skill'
  // name = kebab 机器 id（新标准格式）；展示名进 metadata.tabtin.displayName。
  const machineSlug = slug?.trim() || slugifySkillName(display)
  const safeDisplay = display.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const safeDesc = (description || display).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const categoryLine = category?.trim() ? `    category: ${category.trim()}\n` : ''
  return `---
name: ${machineSlug}
description: "${safeDesc}"
metadata:
  tabtin:
    displayName: "${safeDisplay}"
${categoryLine}---

# ${display}

## 什么时候用这个 Skill

<!--
描述触发条件：用户对话里出现什么关键词 / 意图时，Agent 该调用这个 Skill。
-->

## 步骤

1. ...

## 注意事项

- ...
`
}

/**
 * 调主进程 `skill:write-content` surface 持久化草稿。
 * organizationId 必传（避免落到 _unscoped 分裂目录）。
 */
export async function writeSkillContent(params: {
  spaceId: string
  organizationId: string
  skillKey: string
  content: string
}): Promise<{ mdPath: string; skillDir: string }> {
  const api = window.tabtin?.skill?.writeContent
  if (!api) {
    throw new Error('IPC skill:write-content unavailable')
  }
  return api(params)
}

/**
 * 调主进程 `skill:resolve-path` 查询 skill 在本地的绝对路径。
 * 不创建目录；`exists` 标记目录是否真有。
 */
export async function resolveSkillLocalPath(params: {
  spaceId: string
  organizationId: string
  skillKey: string
  /** 当前 space 没有 SKILL.md 时跨 space 回退查找源目录（发布/分享场景传 true）。 */
  searchAcrossSpaces?: boolean
}): Promise<{ skillDir: string; mdPath: string; exists: boolean; mdExists: boolean; resolvedAcrossSpaces?: boolean } | null> {
  const api = window.tabtin?.skill?.resolvePath
  if (!api) return null
  return api(params)
}
