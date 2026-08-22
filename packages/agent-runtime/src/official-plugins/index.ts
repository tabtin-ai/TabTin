export {
  createBundledOfficialPluginCatalog,
  getOfficialPluginRelease,
  listOfficialPluginReleases,
} from './catalog.js';
export type { BundledOfficialPluginCatalogOptions } from './catalog.js';

export { installOfficialPluginRelease } from './installer.js';
export type { InstallOfficialPluginReleaseOptions } from './installer.js';

export type {
  InstalledOfficialPluginRecord,
  OfficialPluginAcceptanceMetadata,
  OfficialPluginAcceptanceStatus,
  OfficialPluginAdapterMetadata,
  OfficialPluginCapabilityManifest,
  OfficialPluginCapabilityOverrides,
  OfficialPluginCatalog,
  OfficialPluginHookDeclaration,
  OfficialPluginIdentity,
  OfficialPluginLocalService,
  OfficialPluginPreparedRuntime,
  OfficialPluginRelease,
  OfficialPluginReleaseSourceKind,
  UpstreamPluginIdentity,
} from './types.js';
