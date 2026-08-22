import type {
  FilterSet,
  SortConfig,
  WhereNode,
  FieldColumnMap,
} from '@tabtin/table-kernel'
import { buildRecordSpec, specToWhereNode, translateFieldId } from '@tabtin/table-kernel'
import type { PGliteInstance } from './dialect.js'
import { whereNodeToSql } from './query-builder.js'

export interface PGliteQueryServiceConfig {
  pg: PGliteInstance
  getDbTableName: (tableId: string) => string
  getFieldColumnMap: (tableId: string) => FieldColumnMap | undefined
}

export class PGliteQueryService {
  constructor(private readonly config: PGliteQueryServiceConfig) {}

  async queryWithFilter(
    tableId: string,
    filter?: FilterSet | null,
    sorts?: SortConfig[],
    limit?: number,
    offset?: number,
  ): Promise<Record<string, unknown>[]> {
    const dbTableName = this.config.getDbTableName(tableId)
    const fieldColumnMap = this.config.getFieldColumnMap(tableId)

    let sql = `SELECT * FROM "${dbTableName}"`
    let params: unknown[] = []

    if (filter && filter.filterSet && filter.filterSet.length > 0) {
      const spec = buildRecordSpec(filter)
      const whereNode = specToWhereNode(spec)
      if (whereNode) {
        const translatedNode = translateWhereNodeFields(
          whereNode,
          fieldColumnMap,
        )
        const fragment = whereNodeToSql(translatedNode)
        sql += ` WHERE ${fragment.sql}`
        params = fragment.params
      }
    }

    if (sorts && sorts.length > 0) {
      const orderClauses = sorts.map((s) => {
        const col = fieldColumnMap
          ? translateFieldId(s.fieldId, fieldColumnMap)
          : s.fieldId
        return `"${col}" ${s.order === 'desc' ? 'DESC' : 'ASC'}`
      })
      sql += ` ORDER BY ${orderClauses.join(', ')}`
    }

    if (limit != null) {
      sql += ` LIMIT $${params.length + 1}`
      params.push(Number(limit))
    }
    if (offset != null) {
      sql += ` OFFSET $${params.length + 1}`
      params.push(Number(offset))
    }

    const result = await this.config.pg.query(sql, params)
    return result.rows as Record<string, unknown>[]
  }
}

export function translateWhereNodeFields(
  node: WhereNode,
  map: FieldColumnMap | undefined,
): WhereNode {
  if (!map) return node
  switch (node.type) {
    case 'and':
      return { ...node, children: node.children.map((c) => translateWhereNodeFields(c, map)) }
    case 'or':
      return { ...node, children: node.children.map((c) => translateWhereNodeFields(c, map)) }
    case 'not':
      return { ...node, child: translateWhereNodeFields(node.child, map) }
    case 'comparison':
    case 'is_null':
    case 'is_empty':
    case 'in':
    case 'like':
    case 'json_contains':
      return { ...node, field: translateFieldId(node.field, map) }
    default: {
      const _exhaustive: never = node
      throw new Error(`Unsupported WhereNode type: ${(_exhaustive as any).type}`)
    }
  }
}
