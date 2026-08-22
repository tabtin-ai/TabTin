import { getApiClient } from '@/api/tabtin-client'

// ─── Types ──────────────────────────────────────────────────────────────

export interface EmbeddingSceneModel {
  id: string
  model_name: string
  display_name: string
  dimensions: number
}

export interface EmbeddingSceneItem {
  scene_key: string
  display_name: string
  description: string
  primary_model: EmbeddingSceneModel | null
  /** null = 该 scene 没有对应物理表（如 rag_search_query 是查询类） */
  indexed_documents: number | null
  last_rebuild_at: string | null
  rebuild_in_progress: boolean
  has_physical_table: boolean
}

export interface EmbeddingTableItem {
  table_name: string
  display_name: string
  dimensions: number
  indexed_documents: number
  last_rebuild_at: string | null
  rebuild_in_progress: boolean
}

export interface EmbeddingOverview {
  scenes: EmbeddingSceneItem[]
  tables: EmbeddingTableItem[]
  generated_at: string
}

export interface RebuildIndexRequest {
  new_model_id: string
  confirm_scene_key: string
  /** 必填（写入 audit log）— 后端 strip 后非空校验，空白也会被 400 REASON_REQUIRED 拒绝 */
  reason: string
}

// 注：rebuild() v0.1 永远抛 ApiError(code='FEATURE_NOT_IMPLEMENTED', status=422)，
// 调用方应 catch ApiError 用 .code / .message。错误形态由 envelope 决定，
// 不再单独定义本地 RebuildIndexErrorResponse 类型避免与 envelope 字段名漂移。

// ─── Endpoints ──────────────────────────────────────────────────────────

export const embeddingApi = {
  async overview(): Promise<EmbeddingOverview> {
    return getApiClient().raw<EmbeddingOverview>(
      'GET',
      '/services/llm/admin/embedding/overview'
    )
  },

  /**
   * v0.1 stub — 后端永远返回 422 + error_code='FEATURE_NOT_IMPLEMENTED'。
   * 此函数仅在前端提交时把请求发给后端验证 confirm_scene_key 等参数，
   * 业务侧 catch 后展示 toast "重建索引功能未在 v0.1 启用，请等待 v0.2"。
   */
  async rebuild(
    sceneKey: string,
    payload: RebuildIndexRequest
  ): Promise<unknown> {
    return getApiClient().raw(
      'POST',
      `/services/llm/admin/embedding/scenes/${sceneKey}/rebuild`,
      { body: payload }
    )
  },
}
