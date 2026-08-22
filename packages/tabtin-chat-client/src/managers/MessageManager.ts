import { HttpClient } from '../core/http-client'
import type {
  CompactionCheckpointRequest,
  CompactionCheckpointResponse,
  MessageListResponse,
  MessageQueryParams,
  SessionReadAccess,
} from '../types'

/**
 * 消息管理器
 *
 * M5.Y 后仅保留消息历史查询。消息发送、编排请求（invoke/review/answer）
 * 与 sync 已全部迁移：
 * - 发送：Electron/Daemon 本地 Runtime 直接驱动 (IPC / prompt.forward)
 * - Review / AskUser 回执：`window.tabtin.agentEngine.submitAskUserResponse`
 * - 持久化：由 relay ACK 事件驱动（不再走 HTTP sync）
 */
export class MessageManager {
  constructor(private http: HttpClient) {}

  /**
   * 查询消息历史——默认展开所有产物气泡（widget 画布 / search_results / cli_output 等）。
   *
   * 后端 Django 加了 `?expand_artifacts=false` 懒加载策略防止历史响应体积失控
   * 等真有大量用户 + 长对话产生时再考虑。当前桌面端用户（开发者本人）的核心
   * 体验是"刷新页面后能看到 Agent 画的画布"，所以前端默认展开。
   *
   * 未来若性能成为问题再切回懒加载 + 加"展开产物"按钮 UX。
   */
  async list(
    sessionId: string,
    params?: MessageQueryParams,
    access?: SessionReadAccess,
  ): Promise<MessageListResponse> {
    const merged: MessageQueryParams = {
      expand_artifacts: true,
      // ：本客户端版本认识 hitl_interaction（面板派生 / 重载恢复），显式 opt-in。
      // 服务端默认 exclude，保护不认识该 kind 的旧客户端与移动端不渲染幽灵行。
      include_hitl_facts: true,
      ...(params ?? {}),
      ...(access ? { share_id: access.shareId } : {}),
    }
    return this.http.get<MessageListResponse>(
      `/sessions/${sessionId}/messages`,
      merged
    )
  }

  async createCompactionCheckpoint(
    sessionId: string,
    payload: CompactionCheckpointRequest,
  ): Promise<CompactionCheckpointResponse> {
    return this.http.post<CompactionCheckpointResponse>(
      `/sessions/${sessionId}/compaction-checkpoint`,
      payload,
    )
  }
}
