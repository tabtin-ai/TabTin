/**
 * TabTin MCP Server — 暴露 tabdata/tabdoc + action-tools 能力给外部 Agent。
 *
 * 工具来源两路合并：
 *   1. ActionExecutorAdapter（文件/代码/Git 等 headless 工具，动态获取）
 *      — 按 manifest `llm_facing: false` 字段过滤：4 件套（execute_in_terminal /
 *      read_terminal_output / list_terminal_sessions / write_to_terminal）**不**通过
 *      MCP 对外暴露（D8 决策：TabTin 不做 MCP 输出；4 件套保留作
 *      TerminalRuntimeBridge 适配层供 daemon executor/action-bridge.ts +
 *      Electron FrontendActionBridge.ts + 枚举 API `get_all_action_tools()` 等
 *      人控路径消费）。
 *   2. 本地 TabData/TabDoc 专有工具（Django API + TableKernelService）
 *
 * 安全策略：所有路径类访问（read_file / write_file / edit_file / delete_file /
 * glob_search / grep_search / read_lints）走 `checkDaemonPathAccess`
 * 闸门 —— 消费 v3 `WorkspaceSnapshot.allowedPaths` SSoT，与 LLM 主路径同源。
 * 终端类策略检查仅在 daemon `executor/action-bridge.ts` 内做（远端 WS
 * frontend_action 路径，4 件套唯一人控入口）；MCP server 不暴露 4 件套，
 * 因此不在此重复 hardline 拦截，避免双源策略漂移。
 * 认证：Bearer Token（随机生成，写入 ~/.tabtin/mcp-server.json）。
 */

import { ALL_FIELD_TYPES, type FieldType, type ViewType } from '@tabtin/table-kernel'
// WP5（2026-05-14，D8）：以下 4 个 import 随 4 件套 MCP 退役一同删除——
//   - `evaluateLocalTerminalPolicy` / `isAutoApprovedTerminalWrite` /
//     `containsCommandSubstitution` （from @tabtin/terminal-core）
//   - `checkHardlineCommand` （from @tabtin/security-policy）
// remote frontend_action 路径仍然用它们（daemon `executor/action-bridge.ts`
// + Electron `services/FrontendActionBridge.ts`），仅 MCP server 侧不再需要
// 因为 4 件套已不通过 MCP 暴露。`evaluateLocalFilePolicy` /
// `TerminalExecutionPolicyPayload` 一并清掉——MCP file action 路径已迁到
// `checkDaemonPathAccess`，这两个 symbol 在 mcp-server.ts 内部已无消费者。
import { matchDisabledToolDomain } from '@tabtin/agent-wire'
import type { McpServerConfig, McpToolDefinition, McpRequestContext } from './contracts.js'
import { McpSecurityPolicy } from './security.js'
import { McpAdapterTools } from './adapter-tools.js'
import { MemoMcpDomain } from './domains/memo.js'
import { SqlMcpDomain } from './domains/sql.js'
import { SiteMcpDomain } from './domains/site.js'
import { TableMcpDomain } from './domains/table.js'
import { DocumentMcpDomain } from './domains/document.js'
import { McpDomainRegistry } from './registry.js'

export type { McpServerConfig, McpToolDefinition, McpRequestContext } from './contracts.js'

// ── Enum constants for MCP schema ──

// 直接派生自 SSoT（packages/table-kernel/src/types/field.ts），避免手工维护两份
// 列表导致的同步漂移：
//   - 旧手写列表多了 `button` / `skill`（已被 tabdata 0031/0032 迁移下架，
//     SSoT 已删除，手写列表却没跟上 → TS2322 编译期错）；
//   - 旧手写列表又少了 `percent` / `currency`（SSoT 后续新增，手写列表也没补
//     → MCP 客户端拿不到完整字段类型枚举）。
// 派生策略消除了这一类"两份列表手工漂移"的债。
const FIELD_TYPE_ENUM: FieldType[] = Array.from(ALL_FIELD_TYPES)

const VIEW_TYPE_ENUM: ViewType[] = ['grid', 'kanban', 'calendar', 'gallery', 'list', 'flashcard']

const READ_TOOLS: McpToolDefinition[] = [
  {
    name: 'tabtin_table_list',
    description: 'List all tables in the current TabTin workspace. Returns table IDs, names, and field schemas.',
    inputSchema: {
      type: 'object',
      properties: {
        space_id: { type: 'string', description: 'Space ID used for table visibility filtering' },
        organization_id: { type: 'string', description: 'Legacy field; table list filtering actually uses space_id' },
      },
    },
  },
  {
    name: 'tabtin_table_query',
    description: 'Query records from a TabTin table. Supports filtering, sorting, and pagination.',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'string', description: 'Table ID to query' },
        filters: {
          type: 'object',
          description: 'Filter conditions. Format: { conjunction: "and"|"or", filterSet: [{ field_id, operator, value }] }',
        },
        sorts: {
          type: 'array',
          description: 'Sort configuration. First item is used: { field_id, order: "asc"|"desc" }. Only single-field sorting is supported via GET.',
          items: { type: 'object' },
        },
        page: { type: 'number', description: 'Page number (default 1)' },
        page_size: { type: 'number', description: 'Records per page (default 100, max 1000)' },
        field_key_type: { type: 'string', enum: ['id', 'name'], description: 'Field key format (default name)' },
      },
      required: ['table_id'],
    },
  },
  {
    name: 'tabtin_doc_list',
    description: 'List all documents in the current TabTin workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        organization_id: { type: 'string', description: 'Organization ID' },
        space_id: { type: 'string', description: 'Space ID' },
        page: { type: 'number', description: 'Page number (default 1)' },
        page_size: { type: 'number', description: 'Documents per page (default 200, max 500)' },
        include_archived: { type: 'boolean', description: 'Include archived documents (default false)' },
      },
      required: ['organization_id', 'space_id'],
    },
  },
  {
    name: 'tabtin_doc_read',
    description: 'Read the content of a TabTin document. Returns content and version info.',
    inputSchema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', description: 'Document ID to read' },
        format: { type: 'string', enum: ['markdown', 'html', 'txt'], description: 'Export format (default markdown)' },
      },
      required: ['doc_id'],
    },
  },
  {
    name: 'tabtin_doc_search',
    description: 'Search documents by keyword in the current workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        organization_id: { type: 'string', description: 'Organization ID' },
        space_id: { type: 'string', description: 'Space ID' },
        page: { type: 'number', description: 'Page number (default 1)' },
        limit: { type: 'number', description: 'Max results per page (default 20)' },
      },
      required: ['query', 'organization_id', 'space_id'],
    },
  },
]

const WRITE_TOOLS: McpToolDefinition[] = [
  {
    name: 'tabtin_table_create',
    description: 'Create a new table in the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        space_id: { type: 'string', description: 'Space ID' },
        name: { type: 'string', description: 'Table name' },
        description: { type: 'string', description: 'Table description (optional)' },
      },
      required: ['space_id', 'name'],
    },
  },
  {
    name: 'tabtin_table_update',
    description: 'Update table properties (name, description, icon).',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'string', description: 'Table ID' },
        name: { type: 'string', description: 'New table name (optional)' },
        description: { type: 'string', description: 'New description (optional)' },
        icon: { type: 'string', description: 'New icon (optional)' },
      },
      required: ['table_id'],
    },
  },
  {
    name: 'tabtin_table_delete',
    description: 'Delete a table and all its fields, views, and records.',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'string', description: 'Table ID to delete' },
      },
      required: ['table_id'],
    },
  },
  {
    name: 'tabtin_table_archive',
    description: 'Archive a table (soft delete, can be restored later).',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'string', description: 'Table ID to archive' },
      },
      required: ['table_id'],
    },
  },
  {
    name: 'tabtin_table_restore',
    description: 'Restore a previously archived table.',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'string', description: 'Table ID to restore' },
      },
      required: ['table_id'],
    },
  },
  {
    name: 'tabtin_field_create',
    description: 'Create a new field (column) in a table.',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'string', description: 'Table ID' },
        name: { type: 'string', description: 'Field name' },
        field_type: { type: 'string', enum: FIELD_TYPE_ENUM, description: 'Field type' },
        options: { type: 'object', description: 'Field-type-specific options (optional)' },
      },
      required: ['table_id', 'name', 'field_type'],
    },
  },
  {
    name: 'tabtin_field_update',
    description: 'Update field properties (name, options).',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'string', description: 'Table ID' },
        field_id: { type: 'string', description: 'Field ID' },
        name: { type: 'string', description: 'New field name (optional)' },
        options: { type: 'object', description: 'New field options (optional)' },
      },
      required: ['table_id', 'field_id'],
    },
  },
  {
    name: 'tabtin_field_delete',
    description: 'Delete a field (column) from a table.',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'string', description: 'Table ID' },
        field_id: { type: 'string', description: 'Field ID to delete' },
      },
      required: ['table_id', 'field_id'],
    },
  },
  {
    name: 'tabtin_view_create',
    description: 'Create a new view for a table.',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'string', description: 'Table ID' },
        name: { type: 'string', description: 'View name' },
        view_type: { type: 'string', enum: VIEW_TYPE_ENUM, description: 'View type' },
      },
      required: ['table_id', 'name', 'view_type'],
    },
  },
  {
    name: 'tabtin_view_update',
    description: 'Update view properties (name, configuration).',
    inputSchema: {
      type: 'object',
      properties: {
        view_id: { type: 'string', description: 'View ID' },
        name: { type: 'string', description: 'New view name (optional)' },
        config: { type: 'object', description: 'View configuration changes (optional)' },
      },
      required: ['view_id'],
    },
  },
  {
    name: 'tabtin_view_delete',
    description: 'Delete a view from a table.',
    inputSchema: {
      type: 'object',
      properties: {
        view_id: { type: 'string', description: 'View ID to delete' },
      },
      required: ['view_id'],
    },
  },
  {
    name: 'tabtin_record_create',
    description: 'Create a single record in a table.',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'string', description: 'Table ID' },
        data: { type: 'object', description: 'Field values as key-value pairs (field name/id → value)' },
      },
      required: ['table_id', 'data'],
    },
  },
  {
    name: 'tabtin_record_update',
    description: 'Update a single record in a table.',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'string', description: 'Table ID' },
        record_id: { type: 'string', description: 'Record ID to update' },
        data: { type: 'object', description: 'Field values to update as key-value pairs' },
      },
      required: ['table_id', 'record_id', 'data'],
    },
  },
  {
    name: 'tabtin_record_delete',
    description: 'Delete a single record from a table.',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'string', description: 'Table ID' },
        record_id: { type: 'string', description: 'Record ID to delete' },
      },
      required: ['table_id', 'record_id'],
    },
  },
  {
    name: 'tabtin_record_batch',
    description: 'Batch create, update, or delete records in a table.',
    inputSchema: {
      type: 'object',
      properties: {
        table_id: { type: 'string', description: 'Table ID' },
        action: { type: 'string', enum: ['create', 'update', 'delete'], description: 'Batch action type' },
        records: {
          type: 'array',
          description: 'Array of record objects for create (each is a field-value map) or update (each has id + data). Required for create/update.',
          items: { type: 'object' },
        },
        record_ids: {
          type: 'array',
          description: 'Array of record IDs for batch delete. Required when action is delete.',
          items: { type: 'string' },
        },
      },
      required: ['table_id', 'action'],
    },
  },
]

const DOC_WRITE_TOOLS: McpToolDefinition[] = [
  {
    name: 'tabtin_doc_create',
    description: 'Create a new document in the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        organization_id: { type: 'string', description: 'Organization ID' },
        space_id: { type: 'string', description: 'Space ID' },
        title: { type: 'string', description: 'Document title' },
        markdown: { type: 'string', description: 'Initial document body in Markdown (optional). CLI equivalent: tabtin doc create --markdown.' },
        folder_id: { type: 'string', description: 'Parent folder/document ID (optional)' },
      },
      required: ['organization_id', 'space_id', 'title'],
    },
  },
  {
    name: 'tabtin_doc_update',
    description: 'Update document metadata or content. content and status/parent_id are mutually exclusive — use separate calls.',
    inputSchema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', description: 'Document ID' },
        title: { type: 'string', description: 'New title (optional)' },
        content: { type: 'string', description: 'New content in Markdown (optional, uses agent-write endpoint). Mutually exclusive with status/parent_id.' },
        status: { type: 'string', description: 'New document status (optional). Mutually exclusive with content.' },
        parent_id: { type: 'string', description: 'New parent document/folder ID (optional). Mutually exclusive with content.' },
        base_version: { type: 'number', description: 'CAS version for optimistic locking (optional)' },
        base_updated_at: { type: 'string', description: 'CAS timestamp for optimistic locking (ISO 8601, optional)' },
      },
      required: ['doc_id'],
    },
  },
  {
    name: 'tabtin_doc_delete',
    description: 'Archive (soft-delete) a document.',
    inputSchema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', description: 'Document ID to archive' },
      },
      required: ['doc_id'],
    },
  },
]

const DOC_BLOCK_TOOLS: McpToolDefinition[] = [
  {
    name: 'tabtin_doc_list_blocks',
    description: 'List all top-level blocks (nodes) in a document. Returns block index, type, and text preview for each block.',
    inputSchema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', description: 'Document ID' },
      },
      required: ['doc_id'],
    },
  },
  {
    name: 'tabtin_doc_read_block',
    description: 'Read a single block from a document by its index.',
    inputSchema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', description: 'Document ID' },
        block_index: { type: 'number', description: 'Zero-based index of the block to read' },
      },
      required: ['doc_id', 'block_index'],
    },
  },
  {
    name: 'tabtin_doc_update_block',
    description: 'Replace a single block in a document at the given index. Provide the full replacement block as ProseMirror JSON.',
    inputSchema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', description: 'Document ID' },
        block_index: { type: 'number', description: 'Zero-based index of the block to replace' },
        block: { type: 'object', description: 'Replacement block in ProseMirror JSON format (e.g. {"type":"paragraph","content":[{"type":"text","text":"Hello"}]})' },
        base_version: { type: 'number', description: 'CAS version for optimistic locking (optional)' },
        base_updated_at: { type: 'string', description: 'CAS timestamp for optimistic locking (ISO 8601, optional)' },
      },
      required: ['doc_id', 'block_index', 'block'],
    },
  },
  {
    name: 'tabtin_doc_insert_block',
    description: 'Insert a new block into a document at the given index. Existing blocks at and after the index are shifted down.',
    inputSchema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', description: 'Document ID' },
        block_index: { type: 'number', description: 'Zero-based index at which to insert the block' },
        block: { type: 'object', description: 'Block to insert in ProseMirror JSON format' },
        base_version: { type: 'number', description: 'CAS version for optimistic locking (optional)' },
        base_updated_at: { type: 'string', description: 'CAS timestamp for optimistic locking (ISO 8601, optional)' },
      },
      required: ['doc_id', 'block_index', 'block'],
    },
  },
  {
    name: 'tabtin_doc_delete_block',
    description: 'Delete a block from a document at the given index. Subsequent blocks are shifted up.',
    inputSchema: {
      type: 'object',
      properties: {
        doc_id: { type: 'string', description: 'Document ID' },
        block_index: { type: 'number', description: 'Zero-based index of the block to delete' },
        base_version: { type: 'number', description: 'CAS version for optimistic locking (optional)' },
        base_updated_at: { type: 'string', description: 'CAS timestamp for optimistic locking (ISO 8601, optional)' },
      },
      required: ['doc_id', 'block_index'],
    },
  },
]

const MEMO_TOOLS: McpToolDefinition[] = [
  {
    name: 'tabtin_memo_list',
    description: 'List memos in a workspace. Supports search and filtering.',
    inputSchema: {
      type: 'object',
      properties: {
        organization_id: { type: 'string', description: 'Organization ID' },
        space_id: { type: 'string', description: 'Space ID (optional)' },
        search: { type: 'string', description: 'Full-text search query (optional)' },
        tags: { type: 'string', description: 'Comma-separated tag filter (optional)' },
        status: { type: 'string', enum: ['active', 'archived', 'trashed'], description: 'Status filter (default active)' },
        sort: { type: 'string', description: 'Sort field, e.g. -created_at (default)' },
        cursor: { type: 'string', description: 'Pagination cursor (optional)' },
        limit: { type: 'number', description: 'Results per page (default 30)' },
      },
      required: ['organization_id'],
    },
  },
  {
    name: 'tabtin_memo_get',
    description: 'Get memo detail including full content and attachments.',
    inputSchema: {
      type: 'object',
      properties: {
        memo_id: { type: 'string', description: 'Memo ID' },
      },
      required: ['memo_id'],
    },
  },
  {
    name: 'tabtin_memo_create',
    description: 'Create a new memo.',
    inputSchema: {
      type: 'object',
      properties: {
        organization_id: { type: 'string', description: 'Organization ID' },
        space_id: { type: 'string', description: 'Space ID' },
        content_markdown: { type: 'string', description: 'Memo content in Markdown' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags (optional)' },
        color: { type: 'string', description: 'Color label (optional)' },
        memo_type: { type: 'string', enum: ['note', 'bookmark', 'idea', 'task'], description: 'Memo type (default note)' },
        importance: { type: 'number', description: 'Importance 1-5 (optional)' },
        bookmark_url: { type: 'string', description: 'URL for bookmark memos (optional)' },
      },
      required: ['organization_id', 'space_id', 'content_markdown'],
    },
  },
  {
    name: 'tabtin_memo_search',
    description: 'Search memos by keyword. Alias for tabtin_memo_list with search param.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        organization_id: { type: 'string', description: 'Organization ID' },
        space_id: { type: 'string', description: 'Space ID (optional)' },
        limit: { type: 'number', description: 'Max results (default 30)' },
      },
      required: ['query', 'organization_id'],
    },
  },
  {
    name: 'tabtin_memo_update',
    description: 'Update memo content, tags, color, or importance.',
    inputSchema: {
      type: 'object',
      properties: {
        memo_id: { type: 'string', description: 'Memo ID to update' },
        content_markdown: { type: 'string', description: 'New content in Markdown (optional)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'New tags (optional)' },
        color: { type: 'string', description: 'New color label (optional)' },
        importance: { type: 'number', description: 'New importance 1-5 (optional)' },
      },
      required: ['memo_id'],
    },
  },
  {
    name: 'tabtin_memo_delete',
    description: 'Delete (archive) a memo.',
    inputSchema: {
      type: 'object',
      properties: {
        memo_id: { type: 'string', description: 'Memo ID to delete' },
      },
      required: ['memo_id'],
    },
  },
]

const SQL_TOOLS: McpToolDefinition[] = [
  {
    name: 'tabtin_sql_query',
    description: 'Execute raw SQL against the local PGlite database for a table. Useful for complex aggregations and joins.',
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'SQL query to execute (SELECT only for safety)' },
        params: { type: 'array', items: {}, description: 'Parameterized query values (optional)' },
      },
      required: ['sql'],
    },
  },
]

// ── TabSite tools ──

const SITE_TOOLS: McpToolDefinition[] = [
  {
    name: 'tabtin_site_list',
    description: 'List all sites in the current space. Uses TABTIN_SPACE_ID and TABTIN_ORGANIZATION_ID env vars if not provided.',
    inputSchema: {
      type: 'object',
      properties: {
        space_id: { type: 'string', description: 'Space ID (optional, uses TABTIN_SPACE_ID env var if omitted)' },
        organization_id: { type: 'string', description: 'Organization ID (optional, uses TABTIN_ORGANIZATION_ID env var if omitted)' },
        status: { type: 'string', description: 'Filter by status: draft, published, archived' },
      },
      required: [],
    },
  },
  {
    name: 'tabtin_site_info',
    description: 'Get detailed information about a specific site including versions.',
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'The site ID' },
      },
      required: ['site_id'],
    },
  },
  {
    name: 'tabtin_site_create',
    description: 'Create a new site with a template (blank or dashboard).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Site name' },
        template: { type: 'string', description: 'Template to use', enum: ['blank', 'landing-page', 'dashboard', 'blog', 'portfolio', 'docs'] },
        framework: { type: 'string', description: 'Framework (default: react)', enum: ['react'] },
      },
      required: ['name'],
    },
  },
  {
    name: 'tabtin_site_update',
    description: 'Update site properties (name, visibility, custom domain, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'The site ID' },
        name: { type: 'string', description: 'New site name' },
        is_public: { type: 'boolean', description: 'Whether the site is publicly accessible' },
        custom_domain: { type: 'string', description: 'Custom domain for the site' },
        status: { type: 'string', description: 'Site status: draft, published, archived' },
      },
      required: ['site_id'],
    },
  },
  {
    name: 'tabtin_site_publish',
    description: 'Publish a site version with the given dist URL.',
    inputSchema: {
      type: 'object',
      properties: {
        site_id: { type: 'string', description: 'The site ID' },
        dist_url: { type: 'string', description: 'CDN URL of the built dist' },
        message: { type: 'string', description: 'Version message describing the changes' },
      },
      required: ['site_id', 'dist_url'],
    },
  },
]

// ── Names of local-only handlers (served by this file, not adapter) ──

const LOCAL_TOOL_NAMES = new Set([
  ...READ_TOOLS.map(t => t.name),
  ...WRITE_TOOLS.map(t => t.name),
  ...DOC_WRITE_TOOLS.map(t => t.name),
  ...DOC_BLOCK_TOOLS.map(t => t.name),
  ...MEMO_TOOLS.map(t => t.name),
  ...SQL_TOOLS.map(t => t.name),
  ...SITE_TOOLS.map(t => t.name),
])

// ── Non-LLM-facing adapter tools — from manifest SSoT, filtered out of MCP exposure ──
//
// **SSoT**：`packages/action-tools/manifest.json` 中各工具的 `llm_facing` 字段
// （由 `packages/action-tools/src/tools/<domain>/_meta.ts` 中 group / domain 的
// `llmFacing` 字段透传，详见 `packages/action-tools/src/types/manifest.ts`
// 的 `ToolManifest.llm_facing` JSDoc）。
//
// **当前命中**：terminal 4 件套（execute_in_terminal / read_terminal_output /
// list_terminal_sessions / write_to_terminal）。本地 LLM 主路径走 ShellCap 单
// 工具 `run_terminal_command`（D2 决策），4 件套保留作 PtyManagerBridge 适配层
// 给远端 frontend_action / IPC 路径 / 枚举 API 用，但**不**对外通过 MCP 暴露
// （D8 决策：TabTin 不做 MCP 输出）。
//
// 用 manifest SSoT 而非硬编码 4 个工具名：未来若有新 `llm_facing: false` 工具
// 自动会被过滤，无需修改本文件。
// ── Kernel-dependent tool names (require TableKernelService) ──

const KERNEL_DEPENDENT_TOOL_NAMES = new Set([
  ...WRITE_TOOLS.map(t => t.name),
  ...SQL_TOOLS.map(t => t.name),
])

// ── TabData write tools — controlled by operation_switches.db_write ──

const TABDATA_WRITE_TOOLS = new Set([
  'tabtin_table_create', 'tabtin_table_update', 'tabtin_table_delete', 'tabtin_table_archive', 'tabtin_table_restore',
  'tabtin_field_create', 'tabtin_field_update', 'tabtin_field_delete',
  'tabtin_view_create', 'tabtin_view_update', 'tabtin_view_delete',
  'tabtin_record_create', 'tabtin_record_update', 'tabtin_record_delete', 'tabtin_record_batch',
])

// ── Content write tools (doc/memo) — require HITL, MCP hard-rejects ──

const CONTENT_WRITE_TOOLS = new Set([
  'tabtin_doc_create', 'tabtin_doc_update', 'tabtin_doc_delete',
  'tabtin_doc_update_block', 'tabtin_doc_insert_block', 'tabtin_doc_delete_block',
  'tabtin_memo_create', 'tabtin_memo_update', 'tabtin_memo_delete',
])

// ── Actions requiring security policy enforcement ──
//
// **WP5（本地 LLM 终端 PTY 化 总控，2026-05-14，D8 决策）**：原 `TERMINAL_ACTIONS`
// 常量（execute_in_terminal / write_to_terminal）已退役。4 件套不再通过 MCP
// 暴露给外部 client —— manifest.json 中标 `llm_facing: false`，
// `getAdapterTools()` 按此过滤；既然 MCP 层看不到这些工具，自然也不需要
// 在 `enforceSecurityPolicy` 内做 4 件套专用 hardline 拦截。如果未来 4 件套
// 真的有重新对外暴露的需求（D9 解锁后），需要把拦截逻辑一并恢复。
// P0-1 修复后 PATH_SANDBOX_ACTIONS 已删 —— 旧 boundary 检查整段抹掉，统一走
// `checkDaemonPathAccess`；read_file 在 collectPaths 内单独识别（不再依赖
// PATH_SANDBOX_ACTIONS 集合）。

// ── MCP standard error code for service unavailable ──
export class McpToolApplication {
  private readonly config: McpServerConfig
  private readonly adapterTools: McpAdapterTools
  private readonly security: McpSecurityPolicy
  readonly memo: MemoMcpDomain
  readonly sql: SqlMcpDomain
  readonly site: SiteMcpDomain
  readonly table: TableMcpDomain
  readonly document: DocumentMcpDomain
  private readonly registry: McpDomainRegistry

  constructor(config: McpServerConfig) {
    this.config = config
    this.adapterTools = new McpAdapterTools(config.adapter ?? null, LOCAL_TOOL_NAMES, config.workspaceRoot)
    this.security = new McpSecurityPolicy(config)
    this.memo = new MemoMcpDomain(config.contentApi, config.table)
    this.sql = new SqlMcpDomain(config.contentApi, config.table)
    this.site = new SiteMcpDomain(config.contentApi, config.table)
    this.table = new TableMcpDomain(config.contentApi, config.table)
    this.document = new DocumentMcpDomain(config.contentApi, config.table)
    this.registry = new McpDomainRegistry(this, LOCAL_TOOL_NAMES)
  }

  // ── Tool listing: adapter + local ──

  private getAdapterTools(): McpToolDefinition[] { return this.adapterTools.list() }

  getAllTools(): McpToolDefinition[] {
    const apiTools = [...DOC_WRITE_TOOLS, ...DOC_BLOCK_TOOLS, ...MEMO_TOOLS, ...SITE_TOOLS]
    const kernelAvailable = this.config.table != null
    const kernelTools = kernelAvailable ? [...WRITE_TOOLS, ...SQL_TOOLS] : []
    const localTools = [...READ_TOOLS, ...kernelTools, ...apiTools]
    return [...this.getAdapterTools(), ...localTools]
  }

  getLocalToolNames(): string[] {
    return this.getAllTools()
      .filter(t => LOCAL_TOOL_NAMES.has(t.name))
      .map(t => t.name)
  }

  /**
   * 返回 manifest 中标记为 `llm_facing: false` 的 adapter 工具名清单
   * （`getAdapterTools` / `executeTool` 都按此过滤掉）。
   *
   * **当前命中**：terminal 4 件套（execute_in_terminal / read_terminal_output /
   * list_terminal_sessions / write_to_terminal）。
   *
   * **用途**：daemon 启动时打 log 显式通告"MCP 不暴露的工具有哪些"，便于
   * 运维 / dogfood 排查"为啥 Claude Desktop 看不到 execute_in_terminal"
   * （D8 决策的实质体现）。SSoT 见 `NON_LLM_FACING_ADAPTER_TOOLS` 的 JSDoc。
   */
  getNonLlmFacingAdapterToolNames(): string[] {
    return this.adapterTools.hiddenNames()
  }

  filterDisabledTools(
    tools: McpToolDefinition[],
    context: McpRequestContext,
  ): McpToolDefinition[] {
    if (context.disabledToolPrefixes.length === 0) return tools
    return tools.filter(tool => !this.matchDisabledTool(tool.name, context.disabledToolPrefixes))
  }

  matchDisabledTool(toolName: string, disabledToolPrefixes: string[]): string | null {
    return matchDisabledToolDomain(toolName, disabledToolPrefixes)
  }

  // ── Tool execution: adapter-first, then local ──

  async executeTool(
    name: string,
    args: Record<string, unknown>,
    context: McpRequestContext,
  ): Promise<Record<string, unknown>> {
    try {
      // WP5 D8：manifest 中 `llm_facing: false` 的工具（如 terminal 4 件套）
      // 不通过 MCP 暴露 —— 即便 client 绕过 `tools/list` 直接 `tools/call`
      // 也立即 reject，避免 adapter pipeline 把命令真的跑下去。
      if (this.adapterTools.isHidden(name)) {
        return {
          content: [{
            type: 'text',
            text:
              `Tool '${name}' was removed from TabTin's MCP surface as of 2026-05. ` +
              `TabTin's terminal control is exclusive to its in-app local LLM and is not ` +
              `available to external MCP clients (TabTin does not provide MCP terminal output). ` +
              `If your workflow depends on this, run commands directly via your environment ` +
              `or open the issue at the TabTin repository to discuss alternatives.`,
          }],
          isError: true,
        }
      }

      const disabledPrefix = this.matchDisabledTool(name, context.disabledToolPrefixes)
      if (disabledPrefix) {
        return {
          content: [{ type: 'text', text: `Blocked by disabled-app policy: ${disabledPrefix}` }],
          isError: true,
        }
      }

      const policyBlock = this.security.enforce(name, args)
      if (policyBlock) return policyBlock

      if (this.adapterTools.canExecute(name)) {
        return await this.adapterTools.execute(name, args)
      }

      return await this.registry.execute(name, args)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const mcpCode = (err as any)?.mcpErrorCode
      if (typeof mcpCode === 'number') {
        return {
          content: [{ type: 'text', text: `Service Unavailable: ${msg}` }],
          isError: true,
          _meta: { mcp_error_code: mcpCode },
        }
      }
      return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true }
    }
  }


}
