import { HttpClient } from '../core/http-client'
import {
  Model,
  FundingPreviewResponse,
  ModelsResponse,
  SwitchModelRequest,
  SwitchModelResponse,
  SwitchContextTierRequest,
  SwitchContextTierResponse,
  UpdateModelParamsRequest,
  UpdateModelParamsResponse,
  ModelParamOverrides,
} from '../types'

/**
 * 模型管理器
 * 负责模型的获取、切换操作
 */
export class ModelManager {
  constructor(
    private http: HttpClient,
    private catalogHttp: HttpClient
  ) {}

  /**
   * 获取可用模型列表
   * @returns 模型列表响应
   */
  async list(organizationId?: string): Promise<ModelsResponse> {
    const query: Record<string, any> = { use_case: 'chat' }
    if (organizationId) {
      query.organization_id = organizationId
    }
    return this.catalogHttp.get<ModelsResponse>('/services/llm/catalog', query)
  }

  /**
   * 获取发送前只读资金预览。该结果仅用于解释，真正放行和扣费仍由服务端决定。
   */
  async previewFunding(
    organizationId: string,
    modelId: string,
    estimatedTokens: number,
  ): Promise<FundingPreviewResponse> {
    return this.catalogHttp.post<FundingPreviewResponse>(
      '/services/llm/billing-precheck',
      {
        organization_id: organizationId,
        model_id: modelId,
        estimated_tokens: Math.max(0, Math.trunc(estimatedTokens)),
      },
    )
  }

  /**
   * 切换会话的模型
   * @param sessionId - 会话ID
   * @param modelId - 目标模型ID（UUID）
   * @param contextTierId - 同时切换的上下文档位 ID（可选）
   * @returns 切换结果
   */
  async switchModel(
    sessionId: string,
    modelId: string,
    contextTierId?: string,
  ): Promise<SwitchModelResponse> {
    const request: SwitchModelRequest = {
      model_id: modelId,
      ...(contextTierId ? { context_tier_id: contextTierId } : {}),
    }
    return this.http.put<SwitchModelResponse>(`/sessions/${sessionId}/model`, request)
  }

  /**
   * 切换会话当前使用的上下文档位（不切换模型）。
   *
   * @param sessionId 会话 ID
   * @param tierId 目标档位 ID；传 null 或空字符串重置为默认档
   */
  async switchContextTier(
    sessionId: string,
    tierId: string | null,
  ): Promise<SwitchContextTierResponse> {
    const request: SwitchContextTierRequest = {
      context_tier_id: tierId,
    }
    return this.http.put<SwitchContextTierResponse>(
      `/sessions/${sessionId}/context-tier`,
      request,
    )
  }

  async updateModelParams(
    sessionId: string,
    overrides: ModelParamOverrides,
  ): Promise<UpdateModelParamsResponse> {
    const request: UpdateModelParamsRequest = {
      model_param_overrides: overrides,
    }
    return this.http.put<UpdateModelParamsResponse>(
      `/sessions/${sessionId}/model-params`,
      request,
    )
  }

  /**
   * 获取单个模型信息
   * @param modelName - 模型名称
   * @returns 模型信息
   */
  async get(modelName: string): Promise<Model> {
    const response = await this.catalogHttp.get<ModelsResponse>(
      '/services/llm/catalog',
      { use_case: 'chat' }
    )
    const model = response.models.find(
      (item) => item.name === modelName || item.model_name === modelName
    )
    if (!model) {
      throw new Error(`model not found: ${modelName}`)
    }
    return model
  }
}
