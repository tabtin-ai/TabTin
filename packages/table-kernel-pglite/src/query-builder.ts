/**
 * Spec → SQL 查询构建 — 将 WhereNode 转为 Kysely 兼容的 SQL 片段
 *
 * 消费 KyselyWhereVisitor 产出的 WhereNode 中间表示，
 * 转换为可在 PGlite 中执行的 SQL WHERE 子句。
 */

import type { WhereNode } from '@tabtin/table-kernel'

export interface SqlFragment {
  sql: string
  params: unknown[]
}

interface ParamContext {
  counter: number
}

function nextParam(ctx: ParamContext): string {
  return `$${++ctx.counter}`
}

function nodeToSql(node: WhereNode, ctx: ParamContext): SqlFragment {
  switch (node.type) {
    case 'and': {
      const parts = node.children.map((c) => nodeToSql(c, ctx))
      const sql = parts.map((p) => `(${p.sql})`).join(' AND ')
      const params = parts.flatMap((p) => p.params)
      return { sql, params }
    }
    case 'or': {
      const parts = node.children.map((c) => nodeToSql(c, ctx))
      const sql = parts.map((p) => `(${p.sql})`).join(' OR ')
      const params = parts.flatMap((p) => p.params)
      return { sql, params }
    }
    case 'not': {
      const inner = nodeToSql(node.child, ctx)
      return { sql: `NOT (${inner.sql})`, params: inner.params }
    }
    case 'comparison': {
      const p = nextParam(ctx)
      return { sql: `"${node.field}" ${node.op} ${p}`, params: [node.value] }
    }
    case 'is_null': {
      const op = node.negated ? 'IS NOT NULL' : 'IS NULL'
      return { sql: `"${node.field}" ${op}`, params: [] }
    }
    case 'is_empty': {
      const emptySql = `("${node.field}" IS NULL OR TRIM("${node.field}"::text) = '' OR "${node.field}"::text = '[]')`
      return {
        sql: node.negated ? `NOT ${emptySql}` : emptySql,
        params: [],
      }
    }
    case 'in': {
      const values = node.values as unknown[]
      const placeholders = values.map(() => nextParam(ctx))
      const op = node.negated ? 'NOT IN' : 'IN'
      return {
        sql: `"${node.field}" ${op} (${placeholders.join(', ')})`,
        params: values,
      }
    }
    case 'like': {
      const p = nextParam(ctx)
      const op = node.negated ? 'NOT ILIKE' : 'ILIKE'
      return { sql: `"${node.field}" ${op} ${p}`, params: [node.pattern] }
    }
    case 'json_contains': {
      const values = node.values
      switch (node.mode) {
        case 'any': {
          const p = nextParam(ctx)
          return {
            sql: `"${node.field}" ?| ${p}::text[]`,
            params: [values.map(String)],
          }
        }
        case 'all': {
          const p = nextParam(ctx)
          return {
            sql: `"${node.field}" ?& ${p}::text[]`,
            params: [values.map(String)],
          }
        }
        case 'none': {
          const p = nextParam(ctx)
          return {
            sql: `NOT ("${node.field}" ?| ${p}::text[])`,
            params: [values.map(String)],
          }
        }
        case 'exact': {
          const sorted = [...values].sort()
          const p = nextParam(ctx)
          return {
            sql: `"${node.field}"::jsonb = ${p}::jsonb`,
            params: [JSON.stringify(sorted)],
          }
        }
        default: {
          const _exhaustive: never = node.mode
          throw new Error(`Unsupported json_contains mode: ${_exhaustive}`)
        }
      }
    }
    default: {
      const _exhaustive: never = node
      throw new Error(`Unsupported WhereNode type: ${(_exhaustive as any).type}`)
    }
  }
}

/**
 * 将 WhereNode 树转为带参数化的 SQL WHERE 子句
 */
export function whereNodeToSql(node: WhereNode): SqlFragment {
  const ctx: ParamContext = { counter: 0 }
  return nodeToSql(node, ctx)
}
