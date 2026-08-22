import type { Model } from '@tabtin/chat-client'

export type ModelSource = 'platform' | 'organizationByok' | 'userByok'

export interface ModelSourceGroupable {
  provider_scope?: Model['provider_scope']
  provider: string
  provider_display_name?: string
}

export interface ModelSourceProviderGroup<TModel extends ModelSourceGroupable = Model> {
  key: string
  source: ModelSource
  provider: string
  providerDisplayName?: string
  models: TModel[]
}

const SOURCE_ORDER: Record<ModelSource, number> = {
  platform: 0,
  organizationByok: 1,
  userByok: 2,
}

export const MODEL_SOURCE_DEFAULT_LABELS: Record<ModelSource, string> = {
  platform: '平台模型',
  organizationByok: '组织 BYOK',
  userByok: '我的 BYOK',
}

export const MODEL_SOURCE_BADGE_CLASSNAMES: Record<ModelSource, string> = {
  platform: 'bg-accent/10 text-accent',
  organizationByok: 'bg-warning/10 text-warning',
  userByok: 'bg-success/10 text-success',
}

export const resolveModelSource = (
  providerScope: Model['provider_scope'],
): ModelSource => {
  if (providerScope === 'organization') return 'organizationByok'
  if (providerScope === 'user') return 'userByok'
  return 'platform'
}

export const groupModelsBySourceAndProvider = <TModel extends ModelSourceGroupable>(
  models: readonly TModel[],
): ModelSourceProviderGroup<TModel>[] => {
  const groups = new Map<string, ModelSourceProviderGroup<TModel>>()

  models.forEach((model) => {
    const source = resolveModelSource(model.provider_scope)
    const key = `${source}:${model.provider}`
    const group = groups.get(key)
    if (group) {
      group.models.push(model)
      return
    }
    groups.set(key, {
      key,
      source,
      provider: model.provider,
      providerDisplayName: model.provider_display_name,
      models: [model],
    })
  })

  return Array.from(groups.values()).sort(
    (left, right) => SOURCE_ORDER[left.source] - SOURCE_ORDER[right.source],
  )
}
