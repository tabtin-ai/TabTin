/**
 * Skill「从 npm / GitHub」输入解析与失败文案（无重依赖，便于单测）。
 * ：浏览器标题粘贴、ANSI 横幅、网络中断提示。
 */

function isNoisyNpmWarnLine(line: string): boolean {
  return /npm warn Unknown (?:env|project) config/i.test(line)
    || /This will stop working in the next major version of npm/i.test(line)
    || /See `npm help npmrc`/i.test(line)
}

/** 终端 ANSI 转义（skills CLI 横幅 / 颜色），诊断包与 toast 都不该原样展示。 */
const ANSI_ESCAPE_RE =
  /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, '').replace(/\r/g, '')
}

const JUNK_SKILL_SOURCES = new Set([
  'npx', 'npm', 'yarn', 'pnpm', 'github', 'skills', 'add', 'git', 'http', 'https',
])

function looksLikeSkillSource(value: string): boolean {
  const s = value.trim()
  if (!s) return false
  if (/^https?:\/\//i.test(s)) return true
  if (s.startsWith('@') && s.includes('/')) return true
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/.test(s)
}

/**
 * 浏览器标签常被整段粘贴：`GitHub - owner/repo: Description...` → `owner/repo`。
 *  生产诊断：用户粘贴标题后 Source 变成字面量 `GitHub`。
 */
export function rewriteGithubBrowserTitle(raw: string): string {
  const text = raw.trim()
  const titled = text.match(
    /^GitHub\s*[-–—]\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:\s*[:：].*)?$/i,
  )
  if (titled?.[1]) return titled[1].replace(/\.git$/i, '')

  // `owner/repo: Some description`（无 GitHub 前缀，但带标题式冒号说明）
  if (!text.includes('://') && !/--/.test(text)) {
    const colonTitle = text.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s*[:：]\s+\S/)
    if (colonTitle?.[1]) return colonTitle[1].replace(/\.git$/i, '')
  }
  return text
}

function tokenizeSkillsAddArgs(raw: string): string[] {
  const tokens: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? '')
  }
  return tokens.filter(Boolean)
}

export interface ParsedSkillsAddInput {
  source: string
  skills: string[]
}

/**
 * 解析面板 / CLI 输入：支持包名、GitHub URL，以及用户粘贴的整段
 * `npx skills add <source> --skill foo`。
 */
export function parseSkillsAddInput(raw: unknown): ParsedSkillsAddInput {
  let text = String(raw ?? '').trim()
  text = text.replace(/^npm:/i, '').trim()
  text = text.replace(/^(?:npx\s+)?(?:--yes\s+)?skills\s+add\s+/i, '').trim()
  text = rewriteGithubBrowserTitle(text)

  const tokens = tokenizeSkillsAddArgs(text)
  const skills: string[] = []
  const positional: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok === '--skill' || tok === '-s') {
      const next = tokens[i + 1]
      if (next && !next.startsWith('-')) {
        skills.push(next)
        i += 1
      }
      continue
    }
    if (tok.startsWith('--skill=')) {
      const value = tok.slice('--skill='.length).trim()
      if (value) skills.push(value)
      continue
    }
    if (
      tok === '-y'
      || tok === '--yes'
      || tok === '-g'
      || tok === '--global'
      || tok === '--all'
      || tok === '--copy'
      || tok === '-l'
      || tok === '--list'
    ) {
      continue
    }
    // 浏览器标题里的 `GitHub - owner/repo`：单独的 `-` / `–` 不是 CLI flag
    if (tok === '-' || tok === '–' || tok === '—') continue
    if (tok.startsWith('-')) continue
    positional.push(tok.replace(/^npm:/i, '').replace(/:$/, ''))
  }

  // `npx https://github.com/...`：误把 npx 当源时，若后一位像真源则跳过
  while (
    positional.length >= 2
    && JUNK_SKILL_SOURCES.has(positional[0].toLowerCase())
    && looksLikeSkillSource(positional[1])
  ) {
    positional.shift()
  }

  // 标题拆词后：首词仍是 GitHub，第二词才是 owner/repo
  if (
    positional.length >= 2
    && positional[0].toLowerCase() === 'github'
    && looksLikeSkillSource(positional[1])
  ) {
    positional.shift()
  }

  let source = (positional[0] || '').trim()
  source = rewriteGithubBrowserTitle(source)

  return {
    source,
    skills: [...new Set(skills.map((s) => s.trim()).filter(Boolean))],
  }
}

export function assertValidSkillsAddSource(source: string): void {
  const trimmed = source.trim()
  if (!trimmed) {
    throw new Error('请提供 npm 包名或 GitHub 源（如 owner/repo、https://github.com/...）')
  }
  if (JUNK_SKILL_SOURCES.has(trimmed.toLowerCase())) {
    throw new Error(
      `「${trimmed}」不是有效的 Skill 源。请填写仓库路径（如 anthropics/skills）或完整 GitHub URL，不要粘贴浏览器标题或 npx 命令前缀。`,
    )
  }
  if (/\s/.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    throw new Error(
      `Skill 源「${trimmed}」含空格，无法识别。请只填 owner/repo 或 https://github.com/owner/repo。`,
    )
  }
}

export function normalizeNpmPackageName(raw: unknown): string {
  return parseSkillsAddInput(raw).source
}

/** 把 skills CLI 的横幅 / 旋转动画收成可展示的中文失败原因。 */
export function formatNpxSkillsAddFailure(
  detail: string,
  source: string,
  code: number | null,
): string {
  const plain = stripAnsi(detail)
  const interesting = plain
    .split('\n')
    .map((line) => line.replace(/^[|•oxT—\s]+/, '').trim())
    .filter(Boolean)
    .filter((line) => !isNoisyNpmWarnLine(line))
    .filter((line) => !/^[█╔╚║═▐▌]+/.test(line))
    .filter((line) =>
      /fail|fatal|error|curl|does not exist|timeout|reset|denied|not found|canceled|cancelled/i.test(line),
    )
  const summary = [...new Set(interesting)].slice(0, 3).join('；')

  if (/curl\s*28|connection was reset|recv failure|expected flush|ETIMEDOUT|ECONNRESET/i.test(plain)) {
    return (
      `从 GitHub 拉取 Skill 失败（网络中断）。源：${source}。`
      + '请检查网络或代理后重试；也可改用「从目录」导入已下载的 Skill。'
      + (summary ? ` 详情：${summary}` : '')
    )
  }
  if (/repository ['"]?[^'"]+['"]? does not exist|failed to clone/i.test(plain)) {
    return (
      `无法克隆 Skill 源「${source}」。`
      + '请填写仓库路径（如 owner/repo）或完整 GitHub URL，不要粘贴浏览器标题。'
      + (summary ? ` 详情：${summary}` : '')
    )
  }
  return `npx skills add 失败（exit ${code ?? '?'}）：${summary || source}`
}

export function isTransientSkillsAddFailure(message: string): boolean {
  return /curl\s*28|connection was reset|recv failure|expected flush|ETIMEDOUT|ECONNRESET|network/i.test(
    message,
  )
}
