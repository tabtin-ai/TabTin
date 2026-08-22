export interface IconOptimisticPatch {
  patch: { icon: string }
  rollback: { icon: string }
}

export function getIconOptimisticPatch(
  updates: Record<string, unknown>,
  currentIcon: string | null | undefined,
): IconOptimisticPatch | null {
  if (!Object.prototype.hasOwnProperty.call(updates, 'icon')) {
    return null
  }
  const nextIcon = typeof updates.icon === 'string' ? updates.icon : ''
  return {
    patch: { icon: nextIcon },
    rollback: { icon: currentIcon ?? '' },
  }
}
