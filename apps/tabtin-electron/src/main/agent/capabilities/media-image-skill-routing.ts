import type { LocalSkill } from '@tabtin/agent-runtime/skills'

type SkillIdentity = Pick<
  LocalSkill,
  'canonicalKey' | 'slug' | 'name' | 'displayName' | 'primaryEnv'
>

const LIBTV_PRIMARY_ENV = 'LIBTV_ACCESS_KEY'
const LIBTV_IDENTITY_PATTERN = /(?:^|[:/._-])libtv(?:$|[:/._-])/i
const EXPLICIT_LIBTV_PATTERN = /\b(?:libtv|liblib(?:\.tv)?)\b/i

/** LibTV 的稳定识别优先依赖密钥声明，名称仅兼容旧版/第三方安装包。 */
export function isLibTvSkill(skill: SkillIdentity): boolean {
  if (skill.primaryEnv?.trim().toUpperCase() === LIBTV_PRIMARY_ENV) return true
  return [skill.canonicalKey, skill.slug, skill.name, skill.displayName]
    .filter((value): value is string => typeof value === 'string')
    .some((value) => LIBTV_IDENTITY_PATTERN.test(value))
}

export function isExplicitLibTvRequest(query: string | null | undefined): boolean {
  return typeof query === 'string' && EXPLICIT_LIBTV_PATTERN.test(query)
}

/**
 * 原生 `tabtin media image` 是通用生图主链路。LibTV 作为扩展 Skill，只有用户
 * 明确点名，或当前 Agent 已有可用密钥时才进入自动召回上下文。
 */
export function shouldInjectMediaSkill(
  skill: SkillIdentity,
  options: { query?: string; libTvCredentialAvailable: boolean },
): boolean {
  if (!isLibTvSkill(skill)) return true
  return isExplicitLibTvRequest(options.query) || options.libTvCredentialAvailable
}
