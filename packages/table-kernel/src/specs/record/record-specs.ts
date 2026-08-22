/**
 * 记录查询 Specification — 每种操作符一个 Spec 类
 *
 * 这些 Spec 同时支持：
 * - isSatisfiedBy: 内存中判定记录是否匹配
 * - accept(visitor): 由 Visitor 转换为 SQL / Django Q
 */

import { AbstractSpec, type ISpecVisitor } from '../base.js'
import { evaluateOperator } from '../../filter/index.js'

export type RecordData = Record<string, unknown>

export interface IRecordSpecVisitor extends ISpecVisitor<RecordData> {
  visitFieldEquals(spec: FieldEqualsSpec): void
  visitFieldNotEquals(spec: FieldNotEqualsSpec): void
  visitFieldContains(spec: FieldContainsSpec): void
  visitFieldNotContains(spec: FieldNotContainsSpec): void
  visitFieldStartsWith(spec: FieldStartsWithSpec): void
  visitFieldEndsWith(spec: FieldEndsWithSpec): void
  visitFieldIsEmpty(spec: FieldIsEmptySpec): void
  visitFieldIsNotEmpty(spec: FieldIsNotEmptySpec): void
  visitFieldGreaterThan(spec: FieldGreaterThanSpec): void
  visitFieldLessThan(spec: FieldLessThanSpec): void
  visitFieldGte(spec: FieldGteSpec): void
  visitFieldLte(spec: FieldLteSpec): void
  visitFieldIn(spec: FieldInSpec): void
  visitFieldNotIn(spec: FieldNotInSpec): void
  visitFieldHasAnyOf(spec: FieldHasAnyOfSpec): void
  visitFieldHasAllOf(spec: FieldHasAllOfSpec): void
  visitFieldHasNoneOf(spec: FieldHasNoneOfSpec): void
  visitFieldIsExactly(spec: FieldIsExactlySpec): void
}

abstract class BaseFieldSpec extends AbstractSpec<RecordData> {
  constructor(
    public readonly fieldId: string,
    public readonly operator: string,
    public readonly value: unknown,
  ) {
    super()
  }

  isSatisfiedBy(record: RecordData): boolean {
    return evaluateOperator(record[this.fieldId], this.operator, this.value)
  }
}

abstract class BaseArrayFieldSpec extends AbstractSpec<RecordData> {
  constructor(
    public readonly fieldId: string,
    public readonly operator: string,
    public readonly values: unknown[],
  ) {
    super()
  }

  get value(): unknown[] { return this.values }

  isSatisfiedBy(record: RecordData): boolean {
    return evaluateOperator(record[this.fieldId], this.operator, this.values)
  }
}

export class FieldEqualsSpec extends BaseFieldSpec {
  constructor(fieldId: string, value: unknown) { super(fieldId, 'equals', value) }
  accept(v: IRecordSpecVisitor): void { v.visitFieldEquals(this) }
}

export class FieldNotEqualsSpec extends BaseFieldSpec {
  constructor(fieldId: string, value: unknown) { super(fieldId, 'not_equals', value) }
  accept(v: IRecordSpecVisitor): void { v.visitFieldNotEquals(this) }
}

export class FieldContainsSpec extends BaseFieldSpec {
  constructor(fieldId: string, value: unknown) { super(fieldId, 'contains', value) }
  accept(v: IRecordSpecVisitor): void { v.visitFieldContains(this) }
}

export class FieldNotContainsSpec extends BaseFieldSpec {
  constructor(fieldId: string, value: unknown) { super(fieldId, 'not_contains', value) }
  accept(v: IRecordSpecVisitor): void { v.visitFieldNotContains(this) }
}

export class FieldStartsWithSpec extends BaseFieldSpec {
  constructor(fieldId: string, value: unknown) { super(fieldId, 'starts_with', value) }
  accept(v: IRecordSpecVisitor): void { v.visitFieldStartsWith(this) }
}

export class FieldEndsWithSpec extends BaseFieldSpec {
  constructor(fieldId: string, value: unknown) { super(fieldId, 'ends_with', value) }
  accept(v: IRecordSpecVisitor): void { v.visitFieldEndsWith(this) }
}

export class FieldIsEmptySpec extends BaseFieldSpec {
  constructor(fieldId: string) { super(fieldId, 'is_empty', null) }
  accept(v: IRecordSpecVisitor): void { v.visitFieldIsEmpty(this) }
}

export class FieldIsNotEmptySpec extends BaseFieldSpec {
  constructor(fieldId: string) { super(fieldId, 'is_not_empty', null) }
  accept(v: IRecordSpecVisitor): void { v.visitFieldIsNotEmpty(this) }
}

export class FieldGreaterThanSpec extends BaseFieldSpec {
  constructor(fieldId: string, value: unknown) { super(fieldId, 'greater_than', value) }
  accept(v: IRecordSpecVisitor): void { v.visitFieldGreaterThan(this) }
}

export class FieldLessThanSpec extends BaseFieldSpec {
  constructor(fieldId: string, value: unknown) { super(fieldId, 'less_than', value) }
  accept(v: IRecordSpecVisitor): void { v.visitFieldLessThan(this) }
}

export class FieldGteSpec extends BaseFieldSpec {
  constructor(fieldId: string, value: unknown) { super(fieldId, 'greater_than_or_equal', value) }
  accept(v: IRecordSpecVisitor): void { v.visitFieldGte(this) }
}

export class FieldLteSpec extends BaseFieldSpec {
  constructor(fieldId: string, value: unknown) { super(fieldId, 'less_than_or_equal', value) }
  accept(v: IRecordSpecVisitor): void { v.visitFieldLte(this) }
}

export class FieldInSpec extends BaseArrayFieldSpec {
  constructor(fieldId: string, values: unknown[]) { super(fieldId, 'in', values) }
  accept(v: IRecordSpecVisitor): void { v.visitFieldIn(this) }
}

export class FieldNotInSpec extends BaseArrayFieldSpec {
  constructor(fieldId: string, values: unknown[]) { super(fieldId, 'not_in', values) }
  accept(v: IRecordSpecVisitor): void { v.visitFieldNotIn(this) }
}

export class FieldHasAnyOfSpec extends BaseArrayFieldSpec {
  constructor(fieldId: string, values: unknown[]) { super(fieldId, 'has_any_of', values) }
  accept(v: IRecordSpecVisitor): void { v.visitFieldHasAnyOf(this) }
}

export class FieldHasAllOfSpec extends BaseArrayFieldSpec {
  constructor(fieldId: string, values: unknown[]) { super(fieldId, 'has_all_of', values) }
  accept(v: IRecordSpecVisitor): void { v.visitFieldHasAllOf(this) }
}

export class FieldHasNoneOfSpec extends BaseArrayFieldSpec {
  constructor(fieldId: string, values: unknown[]) { super(fieldId, 'has_none_of', values) }
  accept(v: IRecordSpecVisitor): void { v.visitFieldHasNoneOf(this) }
}

export class FieldIsExactlySpec extends BaseArrayFieldSpec {
  constructor(fieldId: string, values: unknown[]) { super(fieldId, 'is_exactly', values) }
  accept(v: IRecordSpecVisitor): void { v.visitFieldIsExactly(this) }
}
