export {
  TabDocHostActionsProvider,
  useTabDocHostActions,
  useTabDocHostActionsOptional,
} from './TabDocHostActionsContext'

export {
  TabDocTableEmbedRuntimeProvider,
  useTabDocTableEmbedRuntime,
} from './TabDocTableEmbedRuntimeContext'

export type {
  TabDocTableEmbedRuntime,
  TabDocTableEmbedStores,
} from './TabDocTableEmbedRuntimeContext'

export { TabDocSurfaceProvider, useTabDocSurface } from './TabDocSurfaceContext'
export type { TabDocSurfaceState } from './TabDocSurfaceContext'

export * from './api-client'
export * from './rehypeSanitizeSchema'
export * from './useDocEditor'
export * from './documentContentBudget'
export * from './useDocList'
export * from './ports'

export {
  TabDocEditorConfigProvider,
  useTabDocEditorConfig,
  useTabDocEditorConfigOptional,
} from './TabDocEditorConfigContext'

export type { TabDocEditorConfig } from './ports'

export { tabdocLocales, tabdocLocaleZhCN, tabdocLocaleEnUS } from './locales'
export type { TabdocLocale } from './locales'

// 数据流探针：从 doc-editor 透传给宿主（web/electron 用于 DEV 启用 + 注入 sink）
export {
  enableDataflowProbe,
  isDataflowProbeEnabled,
  setProbeSink,
  recordProbeEvent,
  registerProbeIntent,
  unregisterProbeIntent,
  listProbeIntents,
  fireProbeIntent,
  dumpProbeEvents,
  clearProbeEvents,
  flushProbe,
  getProbeSessionId,
  resetDataflowProbe,
  markdownToPlaintext,
} from '@tabtin/doc-editor'
export type {
  ProbeOrigin,
  ProbeComponent,
  ProbeHost,
  ProbeEvent,
  ProbeIntentDescriptor,
  ProbeSink,
  ProbeDumpFilter,
} from '@tabtin/doc-editor'
