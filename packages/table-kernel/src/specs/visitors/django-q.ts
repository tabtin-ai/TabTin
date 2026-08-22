/**
 * DjangoQVisitor — 将 Spec 树转换为 Django Q 表达式描述（JSON 格式）
 *
 * Python 侧接收此 JSON 后，用 django.db.models.Q 构建查询。
 * 不依赖 Django，输出纯 JSON 可序列化结构。
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

export type DjangoQNode =
  | { type: 'AND'; children: DjangoQNode[] }
  | { type: 'OR'; children: DjangoQNode[] }
  | { type: 'NOT'; child: DjangoQNode }
  | { type: 'Q'; lookup: string; value: unknown }

type RecordData = Record<string, unknown>

export class DjangoQVisitor implements IRecordSpecVisitor {
  private nodeStack: DjangoQNode[] = []

  getQNode(): DjangoQNode | null {
    return this.nodeStack.length > 0 ? this.nodeStack[this.nodeStack.length - 1] : null
  }

  private push(node: DjangoQNode): void {
    this.nodeStack.push(node)
  }

  private pushQ(field: string, djangoLookup: string, value: unknown): void {
    this.push({ type: 'Q', lookup: `${field}__${djangoLookup}`, value })
  }

  visitAnd(spec: AndSpec<RecordData>): void {
    spec.left.accept(this)
    const left = this.nodeStack.pop()!
    spec.right.accept(this)
    const right = this.nodeStack.pop()!
    this.push({ type: 'AND', children: [left, right] })
  }

  visitOr(spec: OrSpec<RecordData>): void {
    spec.left.accept(this)
    const left = this.nodeStack.pop()!
    spec.right.accept(this)
    const right = this.nodeStack.pop()!
    this.push({ type: 'OR', children: [left, right] })
  }

  visitNot(spec: NotSpec<RecordData>): void {
    spec.inner.accept(this)
    const child = this.nodeStack.pop()!
    this.push({ type: 'NOT', child })
  }

  visitFieldEquals(spec: FieldEqualsSpec): void {
    this.pushQ(spec.fieldId, 'iexact', spec.value)
  }
  visitFieldNotEquals(spec: FieldNotEqualsSpec): void {
    this.push({
      type: 'NOT',
      child: { type: 'Q', lookup: `${spec.fieldId}__iexact`, value: spec.value },
    })
  }
  visitFieldContains(spec: FieldContainsSpec): void {
    this.pushQ(spec.fieldId, 'icontains', spec.value)
  }
  visitFieldNotContains(spec: FieldNotContainsSpec): void {
    this.push({
      type: 'NOT',
      child: { type: 'Q', lookup: `${spec.fieldId}__icontains`, value: spec.value },
    })
  }
  visitFieldStartsWith(spec: FieldStartsWithSpec): void {
    this.pushQ(spec.fieldId, 'istartswith', spec.value)
  }
  visitFieldEndsWith(spec: FieldEndsWithSpec): void {
    this.pushQ(spec.fieldId, 'iendswith', spec.value)
  }
  visitFieldIsEmpty(spec: FieldIsEmptySpec): void {
    this.pushQ(spec.fieldId, 'isnull', true)
  }
  visitFieldIsNotEmpty(spec: FieldIsNotEmptySpec): void {
    this.pushQ(spec.fieldId, 'isnull', false)
  }
  visitFieldGreaterThan(spec: FieldGreaterThanSpec): void {
    this.pushQ(spec.fieldId, 'gt', spec.value)
  }
  visitFieldLessThan(spec: FieldLessThanSpec): void {
    this.pushQ(spec.fieldId, 'lt', spec.value)
  }
  visitFieldGte(spec: FieldGteSpec): void {
    this.pushQ(spec.fieldId, 'gte', spec.value)
  }
  visitFieldLte(spec: FieldLteSpec): void {
    this.pushQ(spec.fieldId, 'lte', spec.value)
  }
  visitFieldIn(spec: FieldInSpec): void {
    this.pushQ(spec.fieldId, 'in', spec.values)
  }
  visitFieldNotIn(spec: FieldNotInSpec): void {
    this.push({
      type: 'NOT',
      child: { type: 'Q', lookup: `${spec.fieldId}__in`, value: spec.values },
    })
  }
  visitFieldHasAnyOf(spec: FieldHasAnyOfSpec): void {
    this.pushQ(spec.fieldId, 'has_any_of', spec.values)
  }
  visitFieldHasAllOf(spec: FieldHasAllOfSpec): void {
    this.pushQ(spec.fieldId, 'has_all_of', spec.values)
  }
  visitFieldHasNoneOf(spec: FieldHasNoneOfSpec): void {
    this.pushQ(spec.fieldId, 'has_none_of', spec.values)
  }
  visitFieldIsExactly(spec: FieldIsExactlySpec): void {
    this.pushQ(spec.fieldId, 'is_exactly', spec.values)
  }
}

export function specToDjangoQ(spec: ISpecification<RecordData>): DjangoQNode | null {
  const visitor = new DjangoQVisitor()
  spec.accept(visitor)
  return visitor.getQNode()
}
