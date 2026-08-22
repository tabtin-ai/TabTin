import { useEffect, useState } from 'react'
import { apiService } from '@/services/api'

export interface EffectiveFeature {
  enabled: boolean
  reason: string
}

const DISABLED_FEATURE: EffectiveFeature = { enabled: false, reason: 'disabled' }
type FeatureState = EffectiveFeature & { organizationId: string | null }

export function readEffectiveFeature(
  features: Record<string, EffectiveFeature> | null | undefined,
  featureKey: string,
): EffectiveFeature {
  const feature = features?.[featureKey]
  return typeof feature?.enabled === 'boolean' && typeof feature.reason === 'string'
    ? feature
    : DISABLED_FEATURE
}

export function effectiveFeaturesUrl(organizationId: string): string {
  return `/platform-config/features/effective?organization_id=${encodeURIComponent(organizationId)}`
}

/** 服务端是版本和组织灰度的唯一判定方；本地只消费最终结果。 */
export function useEffectiveFeature(featureKey: string, organizationId?: string | null): EffectiveFeature {
  const [feature, setFeature] = useState<FeatureState>({ ...DISABLED_FEATURE, organizationId: null })

  useEffect(() => {
    let cancelled = false
    if (!organizationId) {
      setFeature({ ...DISABLED_FEATURE, organizationId: null })
      return
    }
    apiService.request<Record<string, EffectiveFeature>>({ method: 'GET', url: effectiveFeaturesUrl(organizationId) })
      .then(features => {
        if (!cancelled) setFeature({ ...readEffectiveFeature(features, featureKey), organizationId })
      })
      .catch(() => {
        if (!cancelled) setFeature({ ...DISABLED_FEATURE, organizationId })
      })

    return () => {
      cancelled = true
    }
  }, [featureKey, organizationId])

  return feature.organizationId === organizationId
    ? { enabled: feature.enabled, reason: feature.reason }
    : DISABLED_FEATURE
}
