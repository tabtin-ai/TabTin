/**
 * MemoryFilterVisitor — 在内存中评估 Spec 树
 *
 * 直接使用 isSatisfiedBy，但 Visitor 模式允许添加额外逻辑
 * （如性能监测、过滤条件统计等）。
 */

import type { ISpecification } from '../base.js'

type RecordData = Record<string, unknown>

export function memoryFilter(
  records: RecordData[],
  spec: ISpecification<RecordData>,
): RecordData[] {
  return records.filter((record) => spec.isSatisfiedBy(record))
}
