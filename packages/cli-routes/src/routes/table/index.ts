/**
 * Table route handler for CLI Server.
 *
 * All record inputs accept human-readable field names (display names).
 * The Django backend handles name → internal_name resolution automatically.
 *
 * Routes are organized into four sub-modules:
 *   - table-query.ts        → SQL query, search, record listing
 *   - table-crud.ts         → Table/Record CRUD, undo/redo, history, sub-records
 *   - table-schema.ts       → Fields, views, type conversion, webhooks, tokens, attachments
 *   - table-import-export.ts → Import / export operations
 *
 * See each sub-module for the full route list.
 */

import type { ServerResponse } from 'node:http'
import { errorResponse, type SendJSON } from '@tabtin/cli-server-core'
import { handleTableQueryRoute } from './query.js'
import { handleTableCrudRoute } from './crud.js'
import { handleTableSchemaRoute } from './schema.js'
import { handleTableLinkOpsRoute } from './link-ops.js'
import { handleTableImportExportRoute } from './import-export.js'
import { handleTableFormRoute } from './form.js'
import { handleTablePolicyRoute } from './policy.js'
import { handleTableCollaboratorRoute } from './collaborator.js'

// ── Route handler ────────────────────────────────────────

export async function handleTableRoute(
  url: string,
  method: string,
  body: any,
  res: ServerResponse,
  sendJSON: SendJSON,
): Promise<void> {
  const route = url.replace(/^\/table/, '')

  if (await handleTableQueryRoute(route, method, body, res, sendJSON)) return
  if (await handleTableCrudRoute(route, method, body, res, sendJSON)) return
  if (await handleTableLinkOpsRoute(route, method, body, res, sendJSON)) return
  if (await handleTableSchemaRoute(route, method, body, res, sendJSON)) return
  if (await handleTableImportExportRoute(route, method, body, res, sendJSON)) return
  if (await handleTableFormRoute(route, method, body, res, sendJSON)) return
  if (await handleTablePolicyRoute(route, method, body, res, sendJSON)) return
  if (await handleTableCollaboratorRoute(route, method, body, res, sendJSON)) return

  // ── Fallback ─────────────────────────────────────────
  sendJSON(res, 404, errorResponse('NOT_FOUND', `Unknown table route: ${url}`))
}
