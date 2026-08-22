/**
 * Shared readiness utilities for Skill components.
 *
 * Extracted from SkillsSection so that both SkillsSection (settings page)
 * and SkillPanel (sidebar panel) can reuse the same logic.
 */
import type { SkillIndexEntry, SkillConfig } from '@/skills/types'
import { normalizeSkillSource } from '@/skills/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SkillReadiness = 'ready' | 'needs_config' | 'needs_install' | 'incompatible'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** @deprecated Use isConfigurable() instead — accepts raw source and normalizes. */
export const CONFIGURABLE_SOURCES = new Set(['user', 'local_agent', 'managed'])
/** @deprecated Use isUninstallable() instead — accepts raw source and normalizes. */
export const UNINSTALLABLE_SOURCES = new Set(['user', 'managed'])

export function isConfigurable(source: string): boolean {
  return normalizeSkillSource(source) === 'user'
}
export function isUninstallable(source: string): boolean {
  return normalizeSkillSource(source) === 'user'
}

export const READINESS_STYLES: Record<SkillReadiness, string> = {
  ready: 'bg-success',
  needs_config: 'bg-warning',
  needs_install: 'bg-info',
  incompatible: 'bg-muted-foreground/40',
}

export const READINESS_ORDER: Record<SkillReadiness, number> = {
  ready: 0,
  needs_config: 1,
  needs_install: 2,
  incompatible: 3,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function detectPlatform(): string | null {
  if (typeof navigator === 'undefined') return null
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes('mac')) return 'darwin'
  if (ua.includes('linux')) return 'linux'
  if (ua.includes('win')) return 'win32'
  return null
}

/**
 * Determine whether a skill is ready to use based on its metadata and
 * the user's current configuration.
 *
 * Precedence:
 *  1. OS mismatch                    → incompatible
 *  2. Missing required binaries      → needs_install
 *  3. Missing env / credential_id    → needs_config
 *  4. Otherwise                      → ready
 *
 * Note: we can only do a *best-effort* client-side check. The backend
 * eligibility service does the authoritative gating at runtime.
 */
export function computeReadiness(
  skill: SkillIndexEntry,
  cfg: SkillConfig | undefined,
): SkillReadiness {
  // 1. OS compatibility
  const osFilter = skill.os_filter
  if (osFilter && osFilter.length > 0) {
    const platform = detectPlatform()
    if (platform && !osFilter.includes(platform)) {
      return 'incompatible'
    }
  }

  // 2. Binary requirements — if the skill declares bins we assume the user
  //    hasn't installed them yet *unless* there's no install spec (meaning
  //    the binary is common like `curl`). This is a heuristic; the backend
  //    does the real check.
  const requiredBins = skill.requires?.bins || []
  if (requiredBins.length > 0 && (skill.install || []).length > 0) {
    const commonBins = new Set(['curl', 'bash', 'sh', 'python3', 'node'])
    const hasUncommon = requiredBins.some((b) => !commonBins.has(b))
    if (hasUncommon) {
      return 'needs_install'
    }
  }

  // 3. Env / credential requirements
  //    primary_env 对应 Skill 的主密钥：已绑定 credential_id 即视为可用
  //    （真实密钥明文由运行时从凭据库解密注入，客户端无需、也不应拿到明文）。
  const requiredEnv = skill.requires?.env || []
  if (requiredEnv.length > 0) {
    const envObj = cfg?.env || {}
    const hasCredential = Boolean(cfg?.credential_id)
    const primaryEnv = skill.primary_env

    for (const envKey of requiredEnv) {
      if (envKey === primaryEnv) {
        if (!hasCredential && !envObj[envKey]) return 'needs_config'
      } else {
        if (!envObj[envKey]) return 'needs_config'
      }
    }
  }

  return 'ready'
}
