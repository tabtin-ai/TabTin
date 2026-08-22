import type { SceneItem } from '../../api/scenes'

export interface SceneBulkBindingGroup {
  capabilityDomain: string
  scenes: SceneItem[]
}

export function toggleSceneSelection(selected: Set<string>, scene: SceneItem): Set<string> {
  const next = new Set(selected)
  if (scene.is_system) return next

  if (next.has(scene.scene_key)) {
    next.delete(scene.scene_key)
  } else {
    next.add(scene.scene_key)
  }
  return next
}

export function toggleVisibleSceneSelection(
  selected: Set<string>,
  visibleScenes: SceneItem[],
  checked: boolean
): Set<string> {
  const next = new Set(selected)
  for (const scene of visibleScenes) {
    if (scene.is_system) continue
    if (checked) {
      next.add(scene.scene_key)
    } else {
      next.delete(scene.scene_key)
    }
  }
  return next
}

export function groupSelectedScenes(
  scenes: SceneItem[],
  selected: Set<string>
): SceneBulkBindingGroup[] {
  const groups = new Map<string, SceneItem[]>()
  for (const scene of scenes) {
    if (scene.is_system || !selected.has(scene.scene_key)) continue
    const groupScenes = groups.get(scene.capability_domain) ?? []
    groupScenes.push(scene)
    groups.set(scene.capability_domain, groupScenes)
  }
  return [...groups].map(([capabilityDomain, groupScenes]) => ({
    capabilityDomain,
    scenes: groupScenes,
  }))
}

export function buildBulkBindingUpdates(
  groups: SceneBulkBindingGroup[],
  modelByDomain: Record<string, string>
): Array<{ scene_key: string; primary_model_id: string }> {
  return groups.flatMap((group) => {
    const primaryModelId = modelByDomain[group.capabilityDomain]
    if (!primaryModelId) {
      throw new Error(`能力类型 ${group.capabilityDomain} 尚未选择模型`)
    }
    return group.scenes.map((scene) => ({
      scene_key: scene.scene_key,
      primary_model_id: primaryModelId,
    }))
  })
}

export function buildBulkCandidateSceneKeys(groups: SceneBulkBindingGroup[]): string[] {
  return groups.flatMap((group) => group.scenes.map((scene) => scene.scene_key))
}

export function getInitialModelByDomain(groups: SceneBulkBindingGroup[]): Record<string, string> {
  return Object.fromEntries(
    groups.map((group) => {
      const modelIds = new Set(group.scenes.map((scene) => scene.binding?.primary_model?.id ?? ''))
      return [group.capabilityDomain, modelIds.size === 1 ? ([...modelIds][0] ?? '') : '']
    })
  )
}

export function areAllGroupsConfigured(
  groups: SceneBulkBindingGroup[],
  modelByDomain: Record<string, string>
): boolean {
  return (
    groups.length > 0 && groups.every((group) => Boolean(modelByDomain[group.capabilityDomain]))
  )
}
