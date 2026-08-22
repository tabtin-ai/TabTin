export type CellMutation = SetCellMutation | UnsetCellMutation | BatchSetCellMutation

export interface SetCellMutation {
  kind: 'set'
  fieldId: string
  value: unknown
}

export interface UnsetCellMutation {
  kind: 'unset'
  fieldId: string
}

export interface BatchSetCellMutation {
  kind: 'batchSet'
  values: Record<string, unknown>
}

export interface RecordMutationSpec {
  tableId: string
  recordId: string
  mutations: CellMutation[]
}

export function buildSetMutation(fieldId: string, value: unknown): SetCellMutation {
  return { kind: 'set', fieldId, value }
}

export function buildUnsetMutation(fieldId: string): UnsetCellMutation {
  return { kind: 'unset', fieldId }
}

export function buildBatchSetMutation(values: Record<string, unknown>): BatchSetCellMutation {
  return { kind: 'batchSet', values }
}

export function buildRecordMutationSpec(
  tableId: string,
  recordId: string,
  values: Record<string, unknown>,
): RecordMutationSpec {
  return {
    tableId,
    recordId,
    mutations: [buildBatchSetMutation(values)],
  }
}

export function buildRecordMutationSpecFromChanges(
  tableId: string,
  recordId: string,
  changes: Record<string, { old: unknown; new: unknown }>,
): RecordMutationSpec {
  const setValues: Record<string, unknown> = {}
  const mutations: CellMutation[] = []

  for (const [fieldId, change] of Object.entries(changes)) {
    if (change.new === undefined) {
      mutations.push(buildUnsetMutation(fieldId))
      continue
    }
    setValues[fieldId] = change.new
  }

  const setEntries = Object.entries(setValues)
  if (setEntries.length === 1) {
    const [fieldId, value] = setEntries[0]
    mutations.unshift(buildSetMutation(fieldId, value))
  } else if (setEntries.length > 1) {
    mutations.unshift(buildBatchSetMutation(setValues))
  }

  return {
    tableId,
    recordId,
    mutations,
  }
}

export function buildEmptyRecordMutationSpec(
  tableId: string,
  recordId: string,
): RecordMutationSpec {
  return {
    tableId,
    recordId,
    mutations: [],
  }
}

export function recordMutationToData(spec: RecordMutationSpec): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const mutation of spec.mutations) {
    switch (mutation.kind) {
      case 'set':
        result[mutation.fieldId] = mutation.value
        break
      case 'unset':
        result[mutation.fieldId] = null
        break
      case 'batchSet':
        Object.assign(result, mutation.values)
        break
    }
  }
  return result
}
