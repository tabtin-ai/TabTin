export type SemVerParts = {
  major: string
  minor: string
  patch: string
}

export const INITIAL_PUBLISH_VERSION_LABEL = '0.0.1'

const SEMVER_CORE_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const SEMVER_TWO_PART_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const SEMVER_MAJOR_ONLY_RE = /^(0|[1-9]\d*)$/
const VERSION_V_PREFIX_RE = /^v+/i

/** 去掉首尾空白与重复的 v/V 前缀（避免 UI 再拼 v 时出现 vv1.0） */
export function stripVersionLabelPrefix(label: string): string {
  return (label || '').trim().replace(VERSION_V_PREFIX_RE, '')
}

/**
 * 将版本号标签规范为 SemVer 三段（展示与比较共用）。
 * - 1.2.3 → 1.2.3
 * - 1.2 / v1.2 → 1.2.0
 * - 6 / v6 → 6.0.0
 *
 * 重要：展示版本号来自数据库发布记录的 `version_label`，不是让用户手改
 * SKILL.md 的 `version`。`version_seq` 是内部单调序号，**绝不**参与版本号展示——
 * 否则 seq=2 会被误显示成 v2.0.0，与真实 label（如 1.0.0）矛盾。
 */
export function coerceSemVerParts(
  label: string | null | undefined,
): SemVerParts | null {
  const raw = (label || '').trim()
  const core = raw ? stripVersionLabelPrefix(raw) : ''

  if (SEMVER_CORE_RE.test(core)) {
    const [major, minor, patch] = core.split('.')
    return { major, minor, patch }
  }
  if (SEMVER_TWO_PART_RE.test(core)) {
    const [major, minor] = core.split('.')
    return { major, minor, patch: '0' }
  }
  if (SEMVER_MAJOR_ONLY_RE.test(core)) {
    return { major: core, minor: '0', patch: '0' }
  }
  return null
}

/**
 * Skill 版本 UI 展示：永远是单个 v + 三段 SemVer（如 v6.0.0）。
 */
export function formatSkillVersionLabel(
  label: string | null | undefined,
): string {
  const parts = coerceSemVerParts(label)
  if (!parts) return ''
  return `v${formatSemVer(parts)}`
}

export function normalizeVersionPart(value: string): string {
  const digits = value.replace(/\D/g, '')
  if (!digits) return ''
  return digits.replace(/^0+(?=\d)/, '')
}

export function isCompleteSemVer(parts: SemVerParts): boolean {
  return Boolean(parts.major && parts.minor && parts.patch)
}

export function formatSemVer(parts: SemVerParts): string {
  return `${parts.major}.${parts.minor}.${parts.patch}`
}

export function initialPublishVersionParts(): SemVerParts {
  const [major, minor, patch] = INITIAL_PUBLISH_VERSION_LABEL.split('.')
  return { major, minor, patch }
}

export function isValidSemVerLabel(label: string): boolean {
  return SEMVER_CORE_RE.test(label.trim())
}

export function parseSemVerTuple(label: string): [number, number, number] | null {
  if (!isValidSemVerLabel(label)) return null
  const [major, minor, patch] = label.trim().split('.').map(part => Number(part))
  return [major, minor, patch]
}

export function compareSemVer(left: string, right: string): number | null {
  const l = parseSemVerTuple(left)
  const r = parseSemVerTuple(right)
  if (!l || !r) return null
  if (l < r) return -1
  if (l > r) return 1
  return 0
}

export function maxSemVerLabel(labels: string[]): string | null {
  let best: string | null = null
  for (const raw of labels) {
    const parts = coerceSemVerParts(raw)
    if (!parts) continue
    const label = formatSemVer(parts)
    if (!best || (compareSemVer(label, best) ?? -1) > 0) {
      best = label
    }
  }
  return best
}

/** 默认发布建议：首次发布 0.0.1；已有版本时在最高版本上 bump patch。 */
export function suggestNextSemVer(existingLabels: string[]): SemVerParts {
  const best = maxSemVerLabel(existingLabels)
  if (!best) return initialPublishVersionParts()
  const tuple = parseSemVerTuple(best)
  if (!tuple) return initialPublishVersionParts()
  return {
    major: String(tuple[0]),
    minor: String(tuple[1]),
    patch: String(tuple[2] + 1),
  }
}

/** 发布表单预设：小版本升级（1.2.3 → 1.3.0） */
export function suggestNextMinorSemVer(existingLabels: string[]): SemVerParts {
  const best = maxSemVerLabel(existingLabels)
  if (!best) return initialPublishVersionParts()
  const tuple = parseSemVerTuple(best)
  if (!tuple) return initialPublishVersionParts()
  return {
    major: String(tuple[0]),
    minor: String(tuple[1] + 1),
    patch: '0',
  }
}

export function validatePublishSemVer(
  candidate: string,
  existingLabels: string[],
): string | null {
  if (!isValidSemVerLabel(candidate)) {
    return 'invalid'
  }
  const normalized = candidate.trim()
  const existingNormalized = existingLabels
    .map((label) => coerceSemVerParts(label))
    .filter((parts): parts is SemVerParts => Boolean(parts))
    .map((parts) => formatSemVer(parts))
  if (existingNormalized.includes(normalized)) {
    return 'duplicate'
  }
  const maxLabel = maxSemVerLabel(existingLabels)
  if (maxLabel && (compareSemVer(normalized, maxLabel) ?? -1) <= 0) {
    return 'notGreater'
  }
  return null
}
