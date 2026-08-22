/**
 * RecordConditionSpecBuilder — 将 FilterSet 转换为 Spec 树
 */

import type { ISpecification } from '../base.js'
import { AndSpec, OrSpec, TrueSpec } from '../base.js'
import type { FilterItem, FilterSet } from '../../filter/index.js'
import { isFilterSet } from '../../filter/index.js'
import {
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
} from './record-specs.js'

type RecordData = Record<string, unknown>

const OPERATOR_ALIASES: Record<string, string> = {
  is: 'equals',
  is_not: 'not_equals',
  '=': 'equals',
  '!=': 'not_equals',
  '>': 'greater_than',
  '<': 'less_than',
  '>=': 'greater_than_or_equal',
  '<=': 'less_than_or_equal',
  is_any_of: 'in',
  is_none_of: 'not_in',
  does_not_contain: 'not_contains',
}

function resolveOp(op: string): string {
  return OPERATOR_ALIASES[op] ?? op
}

function buildSingleFilterSpec(item: FilterItem): ISpecification<RecordData> {
  const { fieldId, value } = item
  const op = resolveOp(item.operator)

  switch (op) {
    case 'equals': return new FieldEqualsSpec(fieldId, value)
    case 'not_equals': return new FieldNotEqualsSpec(fieldId, value)
    case 'contains': return new FieldContainsSpec(fieldId, value)
    case 'not_contains': return new FieldNotContainsSpec(fieldId, value)
    case 'starts_with': return new FieldStartsWithSpec(fieldId, value)
    case 'ends_with': return new FieldEndsWithSpec(fieldId, value)
    case 'is_empty': return new FieldIsEmptySpec(fieldId)
    case 'is_not_empty': return new FieldIsNotEmptySpec(fieldId)
    case 'greater_than': return new FieldGreaterThanSpec(fieldId, value)
    case 'less_than': return new FieldLessThanSpec(fieldId, value)
    case 'greater_than_or_equal': return new FieldGteSpec(fieldId, value)
    case 'less_than_or_equal': return new FieldLteSpec(fieldId, value)
    case 'in': return new FieldInSpec(fieldId, value as unknown[])
    case 'not_in': return new FieldNotInSpec(fieldId, value as unknown[])
    case 'has_any_of': return new FieldHasAnyOfSpec(fieldId, value as unknown[])
    case 'has_all_of': return new FieldHasAllOfSpec(fieldId, value as unknown[])
    case 'has_none_of': return new FieldHasNoneOfSpec(fieldId, value as unknown[])
    case 'is_exactly': return new FieldIsExactlySpec(fieldId, value as unknown[])
    default:
      throw new Error(`Unknown filter operator: "${item.operator}" (resolved as "${op}")`)
  }
}

function combineSpecs(
  specs: ISpecification<RecordData>[],
  conjunction: 'and' | 'or',
): ISpecification<RecordData> {
  if (specs.length === 0) return new TrueSpec()
  if (specs.length === 1) return specs[0]

  if (conjunction === 'and') {
    return specs.reduce((acc, spec) => new AndSpec(acc, spec))
  } else {
    return specs.reduce((acc, spec) => new OrSpec(acc, spec))
  }
}

/**
 * 将 FilterSet（TabTin 的嵌套过滤结构）转换为 Spec 树
 */
export function buildRecordSpec(filter: FilterItem | FilterSet): ISpecification<RecordData> {
  if (!isFilterSet(filter)) {
    return buildSingleFilterSpec(filter as FilterItem)
  }

  const { conjunction, filterSet } = filter as FilterSet
  if (filterSet.length === 0) return new TrueSpec()

  const childSpecs = filterSet.map((child) => buildRecordSpec(child))
  return combineSpecs(childSpecs, conjunction)
}
