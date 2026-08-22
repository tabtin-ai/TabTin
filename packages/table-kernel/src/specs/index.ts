export type { ISpecification, ISpecVisitor } from './base.js'
export {
  AbstractSpec,
  AndSpec,
  OrSpec,
  NotSpec,
  TrueSpec,
  FalseSpec,
} from './base.js'

export type { IRecordSpecVisitor } from './record/record-specs.js'
export {
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
} from './record/record-specs.js'

export { buildRecordSpec } from './record/builder.js'

export { memoryFilter } from './visitors/memory-filter.js'
export type { WhereNode } from './visitors/kysely-where.js'
export { KyselyWhereVisitor, specToWhereNode } from './visitors/kysely-where.js'
export type { DjangoQNode } from './visitors/django-q.js'
export { DjangoQVisitor, specToDjangoQ } from './visitors/django-q.js'
