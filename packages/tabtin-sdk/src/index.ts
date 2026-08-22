export { TabTinClient } from './client.js'
export { TableHandle } from './table.js'
export { StorageHandle } from './storage.js'
export { QueryBuilder, InsertBuilder, UpdateBuilder, UpsertBuilder, DeleteBuilder } from './query-builder.js'
export { RealtimeClient } from './realtime.js'
export type { RealtimeEvent, ChangePayload } from './realtime.js'
export { HttpClient } from './http.js'
export * from './types.js'

import { TabTinClient } from './client.js'
import type { TabTinClientOptions } from './types.js'

/**
 * Create a TabTin SDK client.
 *
 * ```ts
 * import { createClient } from '@tabtin/sdk'
 *
 * const tabtin = createClient({
 *   baseURL: 'https://api.example.com',
 *   token: 'ttn_xxx_yyy',
 * })
 *
 * // Fluent query
 * const { data } = await tabtin
 *   .from('任务')
 *   .select('标题, 状态, 负责人')
 *   .eq('状态', '进行中')
 *   .order('创建时间', { ascending: false })
 *   .limit(10)
 *
 * // Insert
 * await tabtin.from('任务').insert({ 标题: '新任务', 状态: '待处理' })
 *
 * // Upsert
 * await tabtin.from('任务').upsert(
 *   { 标题: '任务A', 状态: '完成' },
 *   { onConflict: '标题' },
 * )
 *
 * // SQL query
 * const { data } = await tabtin.sql('agent-space-uuid', 'SELECT * FROM 任务')
 * ```
 */
export function createClient(options: TabTinClientOptions): TabTinClient
export function createClient(baseURL: string, token: string): TabTinClient
export function createClient(
  optionsOrURL: TabTinClientOptions | string,
  token?: string,
): TabTinClient {
  if (typeof optionsOrURL === 'string') {
    return new TabTinClient({ baseURL: optionsOrURL, token: token! })
  }
  return new TabTinClient(optionsOrURL)
}
