/**
 * Runtime-local path / content-hash helpers（ Stage 6a →  更新）。
 *
 * 保留旧 `space-paths` 段（`@deprecated`）供未迁移调用方过渡；新代码走
 * `workspace-paths`（user / organization / workspace 单根布局）。
 */

// 旧 API（deprecated；migration harness 尚需过渡期编译）
export {
  isSafeStorageSegment,
  assertSafeStorageSegment,
  warnIfSessionUnscoped,
  resolveOrganizationSpacesRoot,
  resolveSpaceWorkspaceRoot,
  resolveSpacePlatformDataRoot,
  resolveSpaceSkillsDir,
  resolveSpaceSkillDir,
  resolveSpacePluginsDir,
  resolveSpacePluginRegistryFile,
  resolveSpacePluginDir,
  resolveSpaceDownloadsDir,
  resolveSpaceSiteDir,
  resolveSpaceConversationsRoot,
  resolveSpaceSessionArchiveDir,
  resolveSpaceToolLogsDir,
} from './space-paths.js';

// 新 API（ SSoT）
export {
  resolveUserRoot,
  resolveUserSkillsDir,
  resolveUserSkillDir,
  resolveUserCommonDir,
  resolveOrganizationRoot,
  resolveOrganizationSkillsDir,
  resolveOrganizationSkillDir,
  resolveOrganizationPluginsDir,
  resolveOrganizationPluginRegistryFile,
  resolveOrganizationPluginDir,
  resolveOrganizationSharedDir,
  resolveWorkspaceMetadataRoot,
  resolveWorkspaceDownloadsDir,
  resolveWorkspaceConversationsRoot,
  resolveWorkspaceSessionArchiveDir,
  resolveWorkspaceToolLogsDir,
  resolveWorkspaceSiteDir,
} from './workspace-paths.js';

export {
  getHomeTabtinPath,
  getPlatformBaseRoot,
  getDataRoot,
  resolveDataRoot,
  getPlatformDataRoot,
  resolvePlatformDataRoot,
} from './storage-paths.js';

export {
  computeSkillContentHash,
  computeSkillContentHashSync,
} from './skill-content-hash.js';
