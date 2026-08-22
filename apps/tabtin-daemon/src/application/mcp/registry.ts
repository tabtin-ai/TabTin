import type { DocumentMcpDomain } from './domains/document.js'
import type { MemoMcpDomain } from './domains/memo.js'
import type { SiteMcpDomain } from './domains/site.js'
import type { SqlMcpDomain } from './domains/sql.js'
import type { TableMcpDomain } from './domains/table.js'

export class McpDomainRegistry {
  private readonly handlers: ReadonlyMap<string, (args: Record<string, unknown>) => Promise<Record<string, unknown>>>;

  constructor(domains: {
    table: TableMcpDomain
    document: DocumentMcpDomain
    memo: MemoMcpDomain
    sql: SqlMcpDomain
    site: SiteMcpDomain
  }, declaredToolNames?: ReadonlySet<string>) {
    this.handlers = new Map([
      ['tabtin_table_list', args => domains.table.toolTableList(args)], ['tabtin_table_query', args => domains.table.toolTableQuery(args)],
      ['tabtin_doc_list', args => domains.document.toolDocList(args)], ['tabtin_doc_read', args => domains.document.toolDocRead(args)], ['tabtin_doc_search', args => domains.document.toolDocSearch(args)],
      ['tabtin_table_create', args => domains.table.toolTableCreate(args)], ['tabtin_table_update', args => domains.table.toolTableUpdate(args)], ['tabtin_table_delete', args => domains.table.toolTableDelete(args)], ['tabtin_table_archive', args => domains.table.toolTableArchive(args)], ['tabtin_table_restore', args => domains.table.toolTableRestore(args)],
      ['tabtin_field_create', args => domains.table.toolFieldCreate(args)], ['tabtin_field_update', args => domains.table.toolFieldUpdate(args)], ['tabtin_field_delete', args => domains.table.toolFieldDelete(args)],
      ['tabtin_view_create', args => domains.table.toolViewCreate(args)], ['tabtin_view_update', args => domains.table.toolViewUpdate(args)], ['tabtin_view_delete', args => domains.table.toolViewDelete(args)],
      ['tabtin_record_create', args => domains.table.toolRecordCreate(args)], ['tabtin_record_update', args => domains.table.toolRecordUpdate(args)], ['tabtin_record_delete', args => domains.table.toolRecordDelete(args)], ['tabtin_record_batch', args => domains.table.toolRecordBatch(args)],
      ['tabtin_doc_create', args => domains.document.toolDocCreate(args)], ['tabtin_doc_update', args => domains.document.toolDocUpdate(args)], ['tabtin_doc_delete', args => domains.document.toolDocDelete(args)], ['tabtin_doc_list_blocks', args => domains.document.toolDocListBlocks(args)], ['tabtin_doc_read_block', args => domains.document.toolDocReadBlock(args)], ['tabtin_doc_update_block', args => domains.document.toolDocUpdateBlock(args)], ['tabtin_doc_insert_block', args => domains.document.toolDocInsertBlock(args)], ['tabtin_doc_delete_block', args => domains.document.toolDocDeleteBlock(args)],
      ['tabtin_memo_list', args => domains.memo.toolMemoList(args)], ['tabtin_memo_get', args => domains.memo.toolMemoGet(args)], ['tabtin_memo_create', args => domains.memo.toolMemoCreate(args)], ['tabtin_memo_search', args => domains.memo.toolMemoSearch(args)], ['tabtin_memo_update', args => domains.memo.toolMemoUpdate(args)], ['tabtin_memo_delete', args => domains.memo.toolMemoDelete(args)],
      ['tabtin_sql_query', args => domains.sql.toolSqlQuery(args)], ['tabtin_site_list', args => domains.site.toolSiteList(args)], ['tabtin_site_info', args => domains.site.toolSiteInfo(args)], ['tabtin_site_create', args => domains.site.toolSiteCreate(args)], ['tabtin_site_update', args => domains.site.toolSiteUpdate(args)], ['tabtin_site_publish', args => domains.site.toolSitePublish(args)],
    ]);
    if (declaredToolNames) this.assertMatchesDeclarations(declaredToolNames)
  }

  private assertMatchesDeclarations(declaredToolNames: ReadonlySet<string>): void {
    const registered = new Set(this.handlers.keys())
    const missing = [...declaredToolNames].filter(name => !registered.has(name))
    const undeclared = [...registered].filter(name => !declaredToolNames.has(name))
    if (missing.length === 0 && undeclared.length === 0) return
    throw new Error(
      `MCP registry mismatch: missing=[${missing.join(', ')}], undeclared=[${undeclared.join(', ')}]`,
    )
  }

  execute(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.handlers.get(name)?.(args)
      ?? Promise.resolve({ content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true })
  }
}
