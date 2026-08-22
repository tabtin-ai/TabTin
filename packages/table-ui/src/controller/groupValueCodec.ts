import { resolveCanonicalGroupValue } from '@tabtin/table-engine'

export interface GroupValuePresentation {
  key: string
  label: string
}

/** Resolve the render identity and label through the shared grouping contract. */
export const resolveGroupValuePresentation = (
  value: unknown,
  fieldType: string | undefined,
  emptyLabel: string,
  userDisplayNameById?: ReadonlyMap<string, string>,
): GroupValuePresentation => {
  const resolved = resolveCanonicalGroupValue(
    value,
    { fieldType, userDisplayNameById },
    emptyLabel,
  )
  return { key: resolved.key, label: resolved.label }
}
