interface KanbanConfigField {
  id: string
  field_type?: string
  is_primary?: boolean
}

interface CommitKanbanInitialConfigInput<T> {
  viewId: string
  groupFieldId: string
  currentConfig: Record<string, unknown>
  fields: KanbanConfigField[]
  updateView: (
    viewId: string,
    payload: { config: Record<string, unknown> },
  ) => Promise<T | null>
}

export async function commitKanbanInitialConfig<T>({
  viewId,
  groupFieldId,
  currentConfig,
  fields,
  updateView,
}: CommitKanbanInitialConfigInput<T>): Promise<T> {
  const configuredTitleField = currentConfig.card_title_field
  const titleField = typeof configuredTitleField === 'string' && configuredTitleField.length > 0
    ? configuredTitleField
    : fields.find(field => field.is_primary)?.id
      ?? fields.find(field => field.field_type === 'text')?.id
      ?? fields[0]?.id

  const updated = await updateView(viewId, {
    config: {
      ...currentConfig,
      group_by_field: groupFieldId,
      card_title_field: titleField,
    },
  })

  if (!updated) {
    throw new Error('Kanban view configuration update returned no result')
  }

  return updated
}
