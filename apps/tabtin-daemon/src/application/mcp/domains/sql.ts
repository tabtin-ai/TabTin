import { McpDomainSupport } from './domain-support.js'

export class SqlMcpDomain extends McpDomainSupport {
  async toolSqlQuery(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requireArgs(args, 'sql')
    const kernel = this.requireTable()
    const sql = (args.sql as string).trim()

    if (!/^\s*SELECT\b/i.test(sql) && !/^\s*WITH\b/i.test(sql)) {
      throw new Error('Only SELECT queries (including WITH/CTE) are allowed for safety. Use dedicated tools for mutations.')
    }

    if (/\bWITH\b[\s\S]+?\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(sql)) {
      throw new Error('CTE (WITH ... AS) containing write operations is not allowed. Only SELECT queries are permitted.')
    }

    const stripped = sql
      .replace(/--[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/'(?:[^'\\]|\\.)*'/g, "'_STR_'")
      .trim()
      .replace(/;$/, '')
    if (stripped.includes(';')) {
      throw new Error('Multiple statements are not allowed. Submit a single SELECT query.')
    }

    const params = Array.isArray(args.params) ? args.params : undefined
    const rows = await kernel.query(sql, params)
    return {
      content: [{ type: 'text', text: JSON.stringify({ rows, row_count: rows.length }, null, 2) }],
    }
  }

  // ── TabSite tool implementations ──

}
