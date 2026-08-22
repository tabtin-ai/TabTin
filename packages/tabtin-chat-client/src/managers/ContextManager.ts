import { HttpClient } from '../core/http-client'
import { ContextResponse, UpdateContextRequest } from '../types'

/**
 * 上下文管理器
 * 负责会话上下文的获取、更新、清除操作
 */
export class ContextManager {
  constructor(private http: HttpClient) {}

  /**
   * 获取会话上下文
   * @param sessionId - 会话ID
   * @returns 上下文响应
   */
  async get(sessionId: string): Promise<ContextResponse> {
    return this.http.get<ContextResponse>(`/sessions/${sessionId}/context`)
  }

  /**
   * 更新会话上下文
   * @param sessionId - 会话ID
   * @param updates - 更新的上下文字段
   * @returns 更新后的上下文响应
   */
  async update(
    sessionId: string,
    updates: UpdateContextRequest
  ): Promise<ContextResponse> {
    return this.http.put<ContextResponse>(`/sessions/${sessionId}/context`, updates)
  }

  /**
   * 清除当前上下文
   * @param sessionId - 会话ID
   * @returns 删除成功消息
   */
  async clear(sessionId: string): Promise<{ message: string }> {
    return this.http.delete<{ message: string }>(`/sessions/${sessionId}/context`)
  }

  /**
   * 设置当前 Space
   * @param sessionId - 会话ID
   * @param spaceId - Space ID，传入 null 可清空
   */
  async setCurrentSpace(sessionId: string, spaceId: string | null): Promise<ContextResponse> {
    return this.update(sessionId, { current_space_id: spaceId })
  }

  /**
   * 设置当前协作 Project；资源宿主请使用 setCurrentSpace。
   */
  async setCurrentProject(sessionId: string, projectId: string | null): Promise<ContextResponse> {
    return this.update(sessionId, { current_project_id: projectId })
  }

  /**
   * 设置当前表格
   * @param sessionId - 会话ID
   * @param tableId - 表格ID，传入 null 可清空
   */
  async setCurrentTable(sessionId: string, tableId: string | null): Promise<ContextResponse> {
    return this.update(sessionId, { current_table_id: tableId })
  }

  /**
   * 设置当前视图
   * @param sessionId - 会话ID
   * @param viewId - 视图ID，传入 null 可清空
   */
  async setCurrentView(sessionId: string, viewId: string | null): Promise<ContextResponse> {
    return this.update(sessionId, { current_view_id: viewId })
  }
}
