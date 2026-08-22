export interface UseSlideCollaborationInput {
  projectId: string | null
  enabled?: boolean
  /** collab-live WS URL（由宿主注入，包内 fallback 为 env 或 localhost:4100） */
  serverUrl?: string
  /** 获取 JWT token */
  getToken: () => Promise<string> | string
  /** 当前用户信息 */
  user?: {
    id: string
    name: string
    email?: string
  }
}
