/**
 * 外部 Agent 导入宿主编排层（Layer B）—— Electron 主进程侧 barrel。
 */
export {
  registerAgentImportSurfaces,
  IMPORT_SURFACE_CHANNELS,
  IMPORT_ARCHIVE_CHANNELS,
} from './ipc'
export { AgentImportRunnerImpl, resolveImportAttachmentDir } from './runner'
export {
  unifiedBlocksToContentBlocks,
  unifiedBlockToContentBlock,
  type DjangoContentBlock,
} from './block-conversion'
