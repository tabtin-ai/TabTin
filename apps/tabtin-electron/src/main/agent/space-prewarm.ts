/**
 * Space / Agent 激活预热调度（，承接 ）。
 *
 * 调度状态在 {@link PrewarmScheduler}（StateRoot.prewarm）；本模块为 IPC 薄入口。
 * 未 bind 时禁止静默 fallback（避免双实例）。
 */

import { createLogger } from '../logger.js'
import {
  PrewarmScheduler,
  type AgentEnablementPrewarmHandler,
  type SpacePrewarmHandler,
} from '@tabtin/agent-host/state'

const log = createLogger('space-prewarm')

export type { SpacePrewarmHandler, AgentEnablementPrewarmHandler }

let boundSchedulerResolver: (() => PrewarmScheduler) | null = null

export function bindPrewarmScheduler(resolver: () => PrewarmScheduler): void {
  boundSchedulerResolver = resolver
}

export function unbindPrewarmSchedulerForTests(): void {
  boundSchedulerResolver = null
}

function resolveScheduler(): PrewarmScheduler {
  if (!boundSchedulerResolver) {
    throw new Error('PrewarmScheduler not bound; call bindPrewarmScheduler from ElectronAgentHost')
  }
  return boundSchedulerResolver()
}

export function setSpacePrewarmHandler(next: SpacePrewarmHandler | null): void {
  resolveScheduler().setSpaceHandler(next)
}

export function setAgentEnablementPrewarmHandler(
  next: AgentEnablementPrewarmHandler | null,
): void {
  resolveScheduler().setAgentHandler(next)
}

export function requestSpacePrewarm(
  organizationId: string | null | undefined,
  spaceId: string | null | undefined,
): void {
  resolveScheduler().requestSpace(
    organizationId,
    spaceId,
    (err, orgId, spId) => {
      log.warn(
        `space prewarm failed (ignored) org=${orgId} space=${spId}:`,
        err,
      )
    },
  )
}

export function requestAgentEnablementPrewarm(
  agentId: string | null | undefined,
): void {
  resolveScheduler().requestAgentEnablement(agentId, (err, id) => {
    log.warn(`agent enablement prewarm failed (ignored) agent=${id}:`, err)
  })
}

/** 测试钩子：重置调度状态。 */
export function resetSpacePrewarmForTest(): void {
  if (boundSchedulerResolver) {
    resolveScheduler().reset()
  }
}
