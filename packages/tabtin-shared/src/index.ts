export { activatePreset, isPresetAvailable, getPresetCount } from './composer-presets.js'
export { identityAvatarColor, identityAvatarHue, identityAvatarInitial } from './identity-avatar.js'
export { DUPLICATE_NAME_ERROR_TITLE, isDuplicateNameErrorMessage } from './duplicate-name-error.js'
export { withPersistSafety } from './persist-safety.js'
export type { PersistSafetyEvent, PersistSafetyOptions } from './persist-safety.js'
export { createMigratingStorage } from './persist-key-migration.js'
export type { MigratingStorageOptions } from './persist-key-migration.js'
// 注意：useCountdown 是 React hook（依赖 react），不再从顶层 index 导出。
// main 进程 import '@tabtin/shared' 时会顺带触发 ESM eager re-export 解析，
// 加载 use-countdown.js → import 'react' → 在 packaged app 里 react 不在 main
// 的依赖图中导致 ERR_MODULE_NOT_FOUND，main 启动直接崩。
// renderer 端请用：import { useCountdown } from '@tabtin/shared/use-countdown'
export {
  createErrorExtractor,
  KNOWN_ERROR_CODES,
  type TranslateFn,
  type ErrorExtractorOptions,
} from './extract-error.js'
export {
  resolveStrengthKey,
  resolveSuggestionKey,
  passwordHasWhitespace,
  stripPasswordWhitespace,
  passwordHasSpecialChar,
  passwordContainsCjk,
  sanitizeNewPasswordInput,
  countPasswordCharClasses,
  passwordMeetsCharClassRule,
  PASSWORD_SPECIAL_CHARS,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MIN_CHAR_CLASSES,
  type NewPasswordInputNotice,
} from './password-strength.js'
export {
  getHomeTabtinPath,
  getDaemonHomePath,
  setDaemonHomeOverride,
  getUserDataPath,
  setUserDataOverride,
  getPlatformBaseRoot,
  getDataRoot,
  getSpacesRoot,
  getPlatformDataRoot,
  getCheckpointsRoot,
  getFileHistoryRoot,
  getCommandSandboxRoot,
  getTabtinTempDir,
  getKnownStorageRoots,
  isSafeStoragePathSegment,
  resolveUserRoot,
  resolveUserSkillsDir,
  resolveUserSkillDir,
  resolveUserCommonDir,
  resolveOrganizationRoot,
  resolveOrganizationCheckpointsDir,
  resolveOrganizationSkillsDir,
  resolveOrganizationSkillDir,
  resolveOrganizationPluginsDir,
  resolveOrganizationPluginRegistryFile,
  resolveOrganizationPluginDir,
  resolveOrganizationSharedDir,
  resolveWorkspaceMetadataRoot,
  resolveWorkspaceDownloadsDir,
  resolveWorkspaceConversationsRoot,
  resolveWorkspaceFileHistoryRoot,
  resolveWorkspaceSessionArchiveDir,
  resolveWorkspaceToolLogsDir,
  resolveWorkspaceSiteDir,
} from './storage-paths.js'
export type { StorageRootDescriptor } from './storage-paths.js'
export {
  migrateLegacyPlatformDataToDataRoot,
  type StorageMigrationOptions,
  type StorageMigrationReport,
} from './storage-migration.js'
export {
  TABTIN_USER_DATA_DIR_NAMES,
  CREDENTIALS_FILE_NAME,
  TABTIN_PROTECTED_DIR_NAMES,
  TABTIN_CONFIG_FILE_RELATIVE_PATHS,
  TABTIN_CONFIG_DIR_RELATIVE_PATHS,
  TABTIN_HOME_CONFIG_FILE_RELATIVE_PATHS,
  TABTIN_UPDATER_CACHE_DIR_NAMES,
  TABTIN_MAC_APP_BUNDLE_NAMES,
  getElectronAppDataRoot,
  getLocalCacheRoot,
  resolveCredentialFilePaths,
  resolveUpdaterCachePaths,
  resolveConfigAndCacheWipePaths,
  resolveFullWipeDirectoryPaths,
  isProtectedWorkspacePath,
  resolveMacAppBundlePaths,
} from './uninstall-cleanup-paths.js'
export type {
  TabTinUserDataDirName,
  UninstallPathResolveOptions,
} from './uninstall-cleanup-paths.js'
export {
  CAPABILITY_DISCOVERY_CONTRACT,
  CAPABILITY_DISCOVERY_SNAPSHOT_VERSION,
  CAPABILITY_LEAF_NAMESPACES,
  CAPABILITY_CONTAINER_NAMESPACES,
  CAPABILITY_DISCOVERY_SOURCES,
  CAPABILITY_RUNTIME_SOURCES,
  CAPABILITY_MOUNT_STATES,
  CAPABILITY_AVAILABILITY_STATES,
  CAPABILITY_FRESHNESS_STATES,
  CAPABILITY_POLICY_STATES,
  CAPABILITY_REASON_CODES,
  capabilityIdBuilders,
  buildCapabilityId,
  createRuntimeToolItems,
  createMcpToolItems,
  isCapabilityId,
  isLeafCapabilityNamespace,
  isContainerCapabilityNamespace,
  normalizeHostRuntimeSnapshot,
  parseCapabilityId,
} from './capability-discovery.js'
export type {
  CapabilityAvailabilityState,
  CapabilityContainerNamespace,
  CapabilityDiscoveryItem,
  CapabilityDiscoveryReasonCode,
  CapabilityDiscoverySource,
  CapabilityDiscoverySummary,
  CapabilityFreshnessState,
  CapabilityId,
  CapabilityLeafNamespace,
  CapabilityMountState,
  CapabilityNamespace,
  CapabilityPolicyState,
  CreativeEngineStatus,
  CreativeEnginesSnapshot,
  HostRuntimeSnapshot,
  RuntimeSnapshotMcpStatus,
  RuntimeSnapshotMcpToolItem,
  RuntimeSnapshotSource,
  RuntimeSnapshotToolItem,
} from './capability-discovery.js'
export type {
  UserInfo,
  LoginRequest,
  VerificationCodeLoginRequest,
  RegisterRequest,
  RegisterResponse,
  LoginResponse,
  RefreshTokenResponse,
  SendVerificationCodeRequest,
  ForgotPasswordRequest,
  ResetPasswordRequest,
  PasswordStrength,
  ApiResponse,
  VerificationCodeType,
  LoginMethod,
} from './auth-types.js'
export * from './client-observability-context.js'
