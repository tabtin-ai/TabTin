export interface ViewSortRuleDraft {
  field_id: string
  direction: 'asc' | 'desc'
}

export const normalizeSortRulesFromView = (
  sorts: Array<{ field_id?: string | null; direction?: string | null }> | undefined,
): ViewSortRuleDraft[] =>
  (sorts ?? [])
    .map(rule => {
      if (!rule?.field_id) return null
      return {
        field_id: rule.field_id,
        direction: rule.direction === 'desc' ? 'desc' : 'asc',
      } as ViewSortRuleDraft
    })
    .filter((rule): rule is ViewSortRuleDraft => Boolean(rule))

export const normalizeSortRulesForCompare = (rules: ViewSortRuleDraft[]): ViewSortRuleDraft[] =>
  rules
    .filter(rule => Boolean(rule.field_id))
    .map(rule => ({
      field_id: rule.field_id,
      direction: rule.direction === 'desc' ? 'desc' : 'asc',
    }))
