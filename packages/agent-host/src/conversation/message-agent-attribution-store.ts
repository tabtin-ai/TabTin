/**
 * @deprecated 实现已迁至 `state/attribution/AttributionStore`。
 * 本文件仅再导出；调用方应改用实例（经 StateRoot.attribution + bindAttributionStore）。
 */

export {
  rememberMessageAgentAttribution,
  resolveMessageAgentAttribution,
  hydrateMessageAgentAttributions,
  rememberMessageSenderAttribution,
  resolveMessageSenderAttribution,
  hydrateMessageSenderAttributions,
  rememberAttributionFromPersistEvent,
  clearMessageAgentAttributionsForTests,
} from '../state/attribution/attribution-store.js'
