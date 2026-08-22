/**
 * Session path SSoT（2026-05-04 重构后）.
 *
 * agent-runtime 的 session 持久化（messages.jsonl / snapshots.jsonl /
 * events.jsonl / tool-logs/*.md）都写到 **platform-data 下**，与用户
 * workspace 物理隔离。
 *
 *  Stage 6a：路径计算改为本地 `../paths`（原 re-export
 * `@tabtin/terminal-core`）。
 */

export {
  // 旧 API（deprecated；见 paths/space-paths.ts）
  resolveSpaceConversationsRoot,
  resolveSpaceSessionArchiveDir,
  resolveSpaceToolLogsDir,
  resolveSpaceWorkspaceRoot,
  resolveSpacePlatformDataRoot,
  resolveSpaceSkillsDir,
  resolveSpaceSkillDir,
  resolveSpaceDownloadsDir,
  resolveSpaceSiteDir,
  // 新 API（ SSoT）
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
} from '../paths/index.js';
