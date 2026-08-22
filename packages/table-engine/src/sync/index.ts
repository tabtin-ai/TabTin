export type {
  WsGatewayLike,
  TableStreamEvent,
  StreamStatus,
} from './types'

export {
  buildTableEventSubscribeOptions,
  useTableEventStream,
  type UseTableEventStreamOptions,
} from './useTableEventStream'

export {
  useIncrementalSync,
  type UseIncrementalSyncOptions,
} from './useIncrementalSync'

export {
  useDataGridSyncRuntime,
  type UseDataGridSyncRuntimeInput,
  type FieldChangeInfo,
} from './useDataGridSyncRuntime'

export {
  shouldConsumeTableRecordDelta,
} from './legacyDeltaPolicy'

export {
  useIncrementalViewMerge,
  type ViewStoreApiLike,
} from './useIncrementalViewMerge'
