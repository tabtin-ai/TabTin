import { joinApiPath } from '@tabtin/config'
import type { RunHostLeaseResponse } from './run-host-lease-coordinator.js'

export class SessionRunRegistrationHttpError extends Error {
  constructor(readonly status: number) {
    super(`session run registration: HTTP ${status}`)
    this.name = 'SessionRunRegistrationHttpError'
  }
}

export type SessionRunRegistrationApi = {
  accept(input: {
    threadId: string
    runId: string
    taskId: string
    organizationId?: string
    hostId: string
  }): Promise<RunHostLeaseResponse>
}

export function createSessionRunRegistrationHttpApi(input: {
  apiBaseUrl: string
  getAccessToken: () => Promise<string | null>
}): SessionRunRegistrationApi {
  return {
    accept: async request => {
      const token = await input.getAccessToken()
      if (!token) throw new Error('session run registration: not authenticated')
      const send = async (): Promise<RunHostLeaseResponse> => {
        const response = await fetch(
          joinApiPath(input.apiBaseUrl, '/services/agent-engine/session-runs/accept-local/'),
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              thread_id: request.threadId,
              run_id: request.runId,
              task_id: request.taskId,
              organization_id: request.organizationId,
              host_id: request.hostId,
              lease_seconds: 90,
            }),
            signal: AbortSignal.timeout(10_000),
          },
        )
        if (!response.ok) {
          throw new SessionRunRegistrationHttpError(response.status)
        }
        return await response.json() as RunHostLeaseResponse
      }
      try {
        return await send()
      } catch (error) {
        // 相同 run_id 的控制面操作是幂等的；响应丢失时重试可重新取得最新
        // fencing token，避免服务端已有 lease、Host 却无 token 的 90 秒误判。
        if (
          error instanceof SessionRunRegistrationHttpError
          && (error.status < 500 || error.status === 501)
        ) {
          throw error
        }
        return await send()
      }
    },
  }
}
