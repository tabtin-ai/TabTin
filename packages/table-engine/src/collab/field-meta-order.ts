export interface FieldMetaOrderLike {
  id: string
  order?: number | string | null
}

function normalizeFieldId(value: string): string {
  return value.replaceAll('-', '').toLowerCase()
}

/** Keep collaboration metadata in persisted field order before positional edits. */
export function orderFieldsMeta<T extends FieldMetaOrderLike>(fields: readonly T[]): T[] {
  return fields
    .map((field, index) => ({ field, index }))
    .sort((left, right) => {
      const leftOrder = left.field.order == null ? Number.NaN : Number(left.field.order)
      const rightOrder = right.field.order == null ? Number.NaN : Number(right.field.order)
      const leftRank = Number.isFinite(leftOrder) ? leftOrder : Number.POSITIVE_INFINITY
      const rightRank = Number.isFinite(rightOrder) ? rightOrder : Number.POSITIVE_INFINITY
      return leftRank - rightRank || left.index - right.index
    })
    .map(({ field }) => field)
}

export function findFieldMetaIndex<T extends FieldMetaOrderLike>(
  fields: readonly T[],
  referenceFieldId: string,
): number {
  const normalizedReferenceId = normalizeFieldId(referenceFieldId)
  return orderFieldsMeta(fields).findIndex(
    field => normalizeFieldId(String(field.id)) === normalizedReferenceId,
  )
}
