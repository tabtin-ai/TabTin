/**
 * Access Barrier 领域模块门面。
 */
export type {
  AccessBarrier,
  AccessBarrierKind,
  AccessBarrierActionId,
  AccessBarrierResolution,
} from './types.js'
export {
  buildAccessBarrierFromObserveRaw,
  defaultActionsForKind,
  type BuildAccessBarrierContext,
} from './build.js'
export { buildUnattendedResolution } from './unattended.js'
export {
  mergeBarrierIntoPayload,
  ACCESS_BARRIER_HITL_ENDED_HINT,
  ACCESS_BARRIER_RESUME_CLEARED_HINT,
  ACCESS_BARRIER_RESUME_STILL_BLOCKED_HINT,
} from './merge-resolution.js'
export type { MergeBarrierOptions } from './merge-resolution.js'
