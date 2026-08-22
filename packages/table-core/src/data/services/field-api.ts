import {
  isSchemaVersionConflictError,
  requestJsonApi,
  translate,
} from '../http'
import { getTableDataClientConfig } from '../config'
import { normalizeFieldType } from '@tabtin/table-kernel'
import type {
  Field,
  FieldListResponse,
  CreateFieldRequest,
  UpdateFieldRequest,
  FieldReorderRequest,
  FieldConversionRequest,
  FieldConversionResponse,
  FieldConversionCheckRequest,
  FieldConversionCheckResponse,
  FieldConversionPreviewRequest,
  FieldConversionPreviewResponse,
  BulkCreateFieldsRequest,
  BulkCreateFieldsResponse,
  DeleteReferences,
  FieldExplainResponse,
} from '../types/field'

const fieldMessage = (key: string, fallback: string) => translate(key, fallback)

/** 识别创建字段请求超时（table-core 30s / Electron api-proxy Request timeout）。 */
export function isCreateFieldTimeoutError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? '')
  return /请求超时|Request timeout|timeout/i.test(msg)
}

/**
 * 超时后按同名同类型对账：服务端可能已落库，客户端先断连。
 * 找到则返回已有字段；找不到返回 null。
 */
export function findMatchingCreatedField(
  fields: Field[],
  data: Pick<CreateFieldRequest, 'name' | 'field_type'>,
): Field | null {
  const wantedType = normalizeFieldType(data.field_type)
  const match = fields.find(
    (field) => field.name === data.name && normalizeFieldType(field.field_type) === wantedType,
  )
  return match ?? null
}

export class FieldApiService {
  static async getFields(tableId: string): Promise<FieldListResponse> {
    const { endpoints } = getTableDataClientConfig()
    return requestJsonApi<FieldListResponse>({
      method: 'GET',
      endpoint: endpoints.FIELD.LIST(tableId),
      fallbackError: fieldMessage('field:apiErrors.fetchListFailed', '获取字段列表失败'),
    })
  }

  static async getField(fieldId: string): Promise<Field> {
    const { endpoints } = getTableDataClientConfig()
    const field = await requestJsonApi<Field>({
      method: 'GET',
      endpoint: endpoints.FIELD.DETAIL(fieldId),
      fallbackError: fieldMessage('field:apiErrors.fetchDetailFailed', '获取字段详情失败'),
    })
    return { ...field, field_type: normalizeFieldType(field.field_type) }
  }

  static async createField(data: CreateFieldRequest): Promise<Field> {
    const { endpoints } = getTableDataClientConfig()
    try {
      const field = await requestJsonApi<Field>({
        method: 'POST',
        endpoint: endpoints.FIELD.CREATE,
        body: data,
        expectedStatus: [200, 201],
        fallbackError: fieldMessage('field:apiErrors.createFailed', '创建字段失败'),
      })
      return { ...field, field_type: normalizeFieldType(field.field_type) }
    } catch (error) {
      // 超时后对账：服务端可能已成功，避免用户再点一次只看到「字段已存在」
      if (!isCreateFieldTimeoutError(error)) {
        throw error
      }
      try {
        const list = await FieldApiService.getFields(data.table_id)
        const existing = findMatchingCreatedField(list.fields ?? [], data)
        if (existing) {
          return { ...existing, field_type: normalizeFieldType(existing.field_type) }
        }
      } catch {
        // 对账失败时保留原始超时错误
      }
      throw error
    }
  }

  static async bulkCreateFields(
    tableId: string,
    data: BulkCreateFieldsRequest
  ): Promise<BulkCreateFieldsResponse> {
    const { endpoints } = getTableDataClientConfig()
    const result = await requestJsonApi<BulkCreateFieldsResponse>({
      method: 'POST',
      endpoint: endpoints.FIELD.BULK_CREATE(tableId),
      body: data,
      expectedStatus: [200, 201],
      fallbackError: fieldMessage('field:apiErrors.bulkCreateFailed', '批量创建字段失败'),
    })
    return {
      ...result,
      fields: result.fields.map(f => ({ ...f, field_type: normalizeFieldType(f.field_type) })),
    }
  }

  static async updateField(fieldId: string, data: UpdateFieldRequest): Promise<Field> {
    const { endpoints } = getTableDataClientConfig()
    const field = await requestJsonApi<Field>({
      method: 'PUT',
      endpoint: endpoints.FIELD.UPDATE(fieldId),
      body: data,
      fallbackError: fieldMessage('field:apiErrors.updateFailed', '更新字段失败'),
    })
    return { ...field, field_type: normalizeFieldType(field.field_type) }
  }

  /**
   * 设为主字段：带 expected_schema_version；若版本过期则刷新后重试一次。
   * getExpectedSchemaVersion 应在刷新后可读到最新值（勿闭包旧数字）。
   */
  static async setPrimaryField(
    fieldId: string,
    options: {
      getExpectedSchemaVersion: () => number | undefined
      refreshSchemaVersion?: () => Promise<void>
    },
  ): Promise<Field> {
    const attempt = () => {
      const version = options.getExpectedSchemaVersion()
      return FieldApiService.updateField(fieldId, {
        is_primary: true,
        ...(typeof version === 'number' ? { expected_schema_version: version } : {}),
      })
    }

    try {
      return await attempt()
    } catch (error) {
      if (!isSchemaVersionConflictError(error) || !options.refreshSchemaVersion) {
        throw error
      }
      await options.refreshSchemaVersion()
      return await attempt()
    }
  }

  static async getDeleteReferences(fieldId: string): Promise<DeleteReferences> {
    const { endpoints } = getTableDataClientConfig()
    return requestJsonApi<DeleteReferences>({
      method: 'GET',
      endpoint: endpoints.FIELD.DELETE_REFERENCES(fieldId),
      fallbackError: fieldMessage('field:apiErrors.fetchReferencesFailed', '获取字段依赖分析失败'),
    })
  }

  /**
   * W1.4 / C1:字段操作前的统一 explain 端点。
   *
   * 比 `getDeleteReferences` 多返回:
   * - `undo_capability`:能否走 Ctrl+Z 撤销 + 不能时引导文案
   * - `warning_level`:风险等级(low/medium/high),前端按等级渲染样式
   *
   * 后端契约 → apps/tabtin_django/apps/tabdata/api_field.py::explain_field_action
   */
  static async explainFieldAction(
    fieldId: string,
    action: 'delete' | 'convert' = 'delete',
  ): Promise<FieldExplainResponse> {
    const { endpoints } = getTableDataClientConfig()
    const queryParams = new URLSearchParams()
    queryParams.append('action', action)
    return requestJsonApi<FieldExplainResponse>({
      method: 'GET',
      endpoint: `${endpoints.FIELD.EXPLAIN(fieldId)}?${queryParams.toString()}`,
      fallbackError: fieldMessage('field:apiErrors.fetchExplainFailed', '获取字段操作分析失败'),
    })
  }

  static async deleteField(fieldId: string): Promise<void> {
    const { endpoints } = getTableDataClientConfig()
    await requestJsonApi<Record<string, never>>({
      method: 'DELETE',
      endpoint: endpoints.FIELD.DELETE(fieldId),
      fallbackError: fieldMessage('field:apiErrors.deleteFailed', '删除字段失败'),
    })
  }

  static async reorderFields(tableId: string, data: FieldReorderRequest): Promise<void> {
    const { endpoints } = getTableDataClientConfig()
    await requestJsonApi<Record<string, never>>({
      method: 'POST',
      endpoint: endpoints.FIELD.REORDER(tableId),
      body: data,
      fallbackError: fieldMessage('field:apiErrors.reorderFailed', '重排序字段失败'),
    })
  }

  static async convertField(
    fieldId: string,
    data: FieldConversionRequest
  ): Promise<FieldConversionResponse> {
    const { endpoints } = getTableDataClientConfig()
    const fallbackMsg = fieldMessage('field:apiErrors.convertFailed', '字段类型转换失败')

    const payload = await requestJsonApi<FieldConversionResponse>({
      method: 'PUT',
      endpoint: endpoints.FIELD.CONVERT(fieldId),
      body: data,
      fallbackError: fallbackMsg,
    })

    // convertField 的 data 内部可能还有嵌套的 {success: false} 结构
    const maybeResult = payload as { success?: boolean; error?: string; message?: string }
    if (maybeResult.success === false) {
      throw new Error(
        maybeResult.error || maybeResult.message || fallbackMsg
      )
    }

    return payload
  }

  static async checkConversion(
    fieldId: string,
    data: FieldConversionCheckRequest
  ): Promise<FieldConversionCheckResponse> {
    const { endpoints } = getTableDataClientConfig()
    return requestJsonApi<FieldConversionCheckResponse>({
      method: 'POST',
      endpoint: endpoints.FIELD.CHECK_CONVERSION(fieldId),
      body: data,
      fallbackError: fieldMessage('field:apiErrors.checkConversionFailed', '检查字段转换可行性失败'),
    })
  }

  static async previewConversion(
    fieldId: string,
    data: FieldConversionPreviewRequest
  ): Promise<FieldConversionPreviewResponse> {
    const { endpoints } = getTableDataClientConfig()
    return requestJsonApi<FieldConversionPreviewResponse>({
      method: 'POST',
      endpoint: endpoints.FIELD.PREVIEW_CONVERSION(fieldId),
      body: data,
      fallbackError: fieldMessage('field:apiErrors.previewConversionFailed', '预览字段转换失败'),
    })
  }
}
