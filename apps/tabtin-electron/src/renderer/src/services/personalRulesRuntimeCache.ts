import { apiService } from '@/services/api'
import { createLogger } from '@/utils/logger'

const log = createLogger('PersonalRulesRuntimeCache')

interface PersonalRulesCacheEntry {
  ownerKey: string
  value: string
}

let cachedPersonalRules: PersonalRulesCacheEntry | null = null
let inFlightPersonalRules: { ownerKey: string; promise: Promise<string | undefined> } | null = null

function toRuntimeValue(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim() ?? ''
  return trimmed ? trimmed : undefined
}

function hasPersonalRulesField(agent: { personal_rules?: string | null } | null | undefined): boolean {
  return !!agent && Object.prototype.hasOwnProperty.call(agent, 'personal_rules')
}

export function setCachedPersonalRules(value: string | null | undefined, ownerKey: string): void {
  cachedPersonalRules = { ownerKey, value: value ?? '' }
}

export function clearCachedPersonalRules(ownerKey?: string): void {
  if (!ownerKey || cachedPersonalRules?.ownerKey === ownerKey) {
    cachedPersonalRules = null
  }
  if (!ownerKey || inFlightPersonalRules?.ownerKey === ownerKey) {
    inFlightPersonalRules = null
  }
}

export function getCachedPersonalRulesForRuntime(ownerKey: string): string | undefined {
  if (cachedPersonalRules?.ownerKey !== ownerKey) return undefined
  return toRuntimeValue(cachedPersonalRules.value)
}

function hasCachedPersonalRules(ownerKey: string): boolean {
  return cachedPersonalRules?.ownerKey === ownerKey
}

export async function resolvePersonalRulesForRuntime(
  agent: { personal_rules?: string | null } | null | undefined,
  ownerKey: string,
  options: { allowApiFallback?: boolean } = {},
): Promise<string | undefined> {
  if (hasPersonalRulesField(agent)) {
    setCachedPersonalRules(agent?.personal_rules, ownerKey)
    return getCachedPersonalRulesForRuntime(ownerKey)
  }

  if (hasCachedPersonalRules(ownerKey)) {
    return getCachedPersonalRulesForRuntime(ownerKey)
  }

  if (options.allowApiFallback === false) return undefined

  if (inFlightPersonalRules?.ownerKey !== ownerKey) {
    const promise = apiService.getPersonalRules()
      .then((res) => {
        setCachedPersonalRules(res?.personal_rules, ownerKey)
        return getCachedPersonalRulesForRuntime(ownerKey)
      })
      .catch((err) => {
        log.warn('Failed to load personal rules for runtime fallback:', err)
        return undefined
      })
      .finally(() => {
        if (inFlightPersonalRules?.ownerKey === ownerKey) {
          inFlightPersonalRules = null
        }
      })
    inFlightPersonalRules = { ownerKey, promise }
  }

  return inFlightPersonalRules.promise
}
