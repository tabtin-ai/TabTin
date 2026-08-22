/**
 * KyselyWhereVisitor — 将 Spec 树转换为 Kysely WHERE 条件描述
 *
 * 不依赖 Kysely 运行时，输出一个可序列化的中间表示（WhereNode 树），
 * 由实际的 Kysely 适配器消费。
 */

import { AndSpec, OrSpec, NotSpec, type ISpecification } from '../base.js'
import type {
  IRecordSpecVisitor,
  FieldEqualsSpec,
  FieldNotEqualsSpec,
  FieldContainsSpec,
  FieldNotContainsSpec,
  FieldStartsWithSpec,
  FieldEndsWithSpec,
  FieldIsEmptySpec,
  FieldIsNotEmptySpec,
  FieldGreaterThanSpec,
  FieldLessThanSpec,
  FieldGteSpec,
  FieldLteSpec,
  FieldInSpec,
  FieldNotInSpec,
  FieldHasAnyOfSpec,
  FieldHasAllOfSpec,
  FieldHasNoneOfSpec,
  FieldIsExactlySpec,
} from '../record/record-specs.js'

export type WhereNode =
  | { type: 'and'; children: WhereNode[] }
  | { type: 'or'; children: WhereNode[] }
  | { type: 'not'; child: WhereNode }
  | { type: 'comparison'; field: string; op: string; value: unknown }
  | { type: 'is_null'; field: string; negated: boolean }
  | { type: 'is_empty'; field: string; negated: boolean }
  | { type: 'in'; field: string; values: unknown[]; negated: boolean }
  | { type: 'like'; field: string; pattern: string; negated: boolean }
  | { type: 'json_contains'; field: string; values: unknown[]; mode: 'any' | 'all' | 'none' | 'exact' }

type RecordData = Record<string, unknown>

export class KyselyWhereVisitor implements IRecordSpecVisitor {
  private nodeStack: WhereNode[] = []

  getWhereNode(): WhereNode | null {
    return this.nodeStack.length > 0 ? this.nodeStack[this.nodeStack.length - 1] : null
  }

  private push(node: WhereNode): void {
    this.nodeStack.push(node)
  }

  visitAnd(spec: AndSpec<RecordData>): void {
    spec.left.accept(this)
    const left = this.nodeStack.pop()!
    spec.right.accept(this)
    const right = this.nodeStack.pop()!
    this.push({ type: 'and', children: [left, right] })
  }

  visitOr(spec: OrSpec<RecordData>): void {
    spec.left.accept(this)
    const left = this.nodeStack.pop()!
    spec.right.accept(this)
    const right = this.nodeStack.pop()!
    this.push({ type: 'or', children: [left, right] })
  }

  visitNot(spec: NotSpec<RecordData>): void {
    spec.inner.accept(this)
    const child = this.nodeStack.pop()!
    this.push({ type: 'not', child })
  }

  visitFieldEquals(spec: FieldEqualsSpec): void {
    this.push({ type: 'comparison', field: spec.fieldId, op: '=', value: spec.value })
  }
  visitFieldNotEquals(spec: FieldNotEqualsSpec): void {
    this.push({ type: 'comparison', field: spec.fieldId, op: '!=', value: spec.value })
  }
  visitFieldContains(spec: FieldContainsSpec): void {
    this.push({ type: 'like', field: spec.fieldId, pattern: `%${spec.value}%`, negated: false })
  }
  visitFieldNotContains(spec: FieldNotContainsSpec): void {
    this.push({ type: 'like', field: spec.fieldId, pattern: `%${spec.value}%`, negated: true })
  }
  visitFieldStartsWith(spec: FieldStartsWithSpec): void {
    this.push({ type: 'like', field: spec.fieldId, pattern: `${spec.value}%`, negated: false })
  }
  visitFieldEndsWith(spec: FieldEndsWithSpec): void {
    this.push({ type: 'like', field: spec.fieldId, pattern: `%${spec.value}`, negated: false })
  }
  visitFieldIsEmpty(spec: FieldIsEmptySpec): void {
    this.push({ type: 'is_empty', field: spec.fieldId, negated: false })
  }
  visitFieldIsNotEmpty(spec: FieldIsNotEmptySpec): void {
    this.push({ type: 'is_empty', field: spec.fieldId, negated: true })
  }
  visitFieldGreaterThan(spec: FieldGreaterThanSpec): void {
    this.push({ type: 'comparison', field: spec.fieldId, op: '>', value: spec.value })
  }
  visitFieldLessThan(spec: FieldLessThanSpec): void {
    this.push({ type: 'comparison', field: spec.fieldId, op: '<', value: spec.value })
  }
  visitFieldGte(spec: FieldGteSpec): void {
    this.push({ type: 'comparison', field: spec.fieldId, op: '>=', value: spec.value })
  }
  visitFieldLte(spec: FieldLteSpec): void {
    this.push({ type: 'comparison', field: spec.fieldId, op: '<=', value: spec.value })
  }
  visitFieldIn(spec: FieldInSpec): void {
    this.push({ type: 'in', field: spec.fieldId, values: spec.values, negated: false })
  }
  visitFieldNotIn(spec: FieldNotInSpec): void {
    this.push({ type: 'in', field: spec.fieldId, values: spec.values, negated: true })
  }
  visitFieldHasAnyOf(spec: FieldHasAnyOfSpec): void {
    this.push({ type: 'json_contains', field: spec.fieldId, values: spec.values, mode: 'any' })
  }
  visitFieldHasAllOf(spec: FieldHasAllOfSpec): void {
    this.push({ type: 'json_contains', field: spec.fieldId, values: spec.values, mode: 'all' })
  }
  visitFieldHasNoneOf(spec: FieldHasNoneOfSpec): void {
    this.push({ type: 'json_contains', field: spec.fieldId, values: spec.values, mode: 'none' })
  }
  visitFieldIsExactly(spec: FieldIsExactlySpec): void {
    this.push({ type: 'json_contains', field: spec.fieldId, values: spec.values, mode: 'exact' })
  }
}

export function specToWhereNode(spec: ISpecification<RecordData>): WhereNode | null {
  const visitor = new KyselyWhereVisitor()
  spec.accept(visitor)
  return visitor.getWhereNode()
}
