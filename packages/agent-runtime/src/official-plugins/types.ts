import type { Manifest } from '../capability/manifest.js';

export type OfficialPluginReleaseSourceKind = 'bundled' | 'official_remote';
export type OfficialPluginAcceptanceStatus = 'accepted' | 'provisional' | 'blocked';

export interface OfficialPluginIdentity {
  id: string;
  displayName: string;
  description?: string;
}

export interface UpstreamPluginIdentity {
  packageName: string;
  version: string;
  repository?: string;
  commit?: string;
  sourcePath?: string;
}

export interface OfficialPluginAcceptanceMetadata {
  status: OfficialPluginAcceptanceStatus;
  checklistId: string;
  verifiedAt?: string;
  notes?: string;
}

export interface OfficialPluginLocalService {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface OfficialPluginPreparedRuntime {
  manifestEntries?: Manifest['entries'];
  environment?: Record<string, string>;
  warnings?: string[];
}

export interface OfficialPluginCapabilityOverrides {
  skills?: string[];
  mcpServers?: Record<string, unknown>;
  scripts?: Record<string, unknown>;
  hooks?: OfficialPluginHookDeclaration[];
  assets?: string[];
  warnings?: string[];
}

export interface OfficialPluginAdapterMetadata {
  id: string;
  version: string;
  capabilityOverrides?: OfficialPluginCapabilityOverrides;
  localServices?: OfficialPluginLocalService[];
  preparedRuntime?: OfficialPluginPreparedRuntime;
  acceptance: OfficialPluginAcceptanceMetadata;
}

export interface OfficialPluginRelease {
  id: string;
  plugin: OfficialPluginIdentity;
  officialVersion: string;
  channel: 'stable' | 'preview';
  source: {
    kind: OfficialPluginReleaseSourceKind;
    path?: string;
    url?: string;
  };
  upstream: UpstreamPluginIdentity;
  adapter: OfficialPluginAdapterMetadata;
}

export interface OfficialPluginCatalog {
  catalogVersion: string;
  releases: OfficialPluginRelease[];
}

export interface OfficialPluginHookDeclaration {
  name: string;
  event: string;
  command?: string;
  args?: string[];
  displayOnly: true;
}

export interface OfficialPluginCapabilityManifest {
  manifestVersion: 1;
  skills: string[];
  mcpServers: Record<string, unknown>;
  scripts: Record<string, unknown>;
  hooks: OfficialPluginHookDeclaration[];
  assets: string[];
  localServices: OfficialPluginLocalService[];
  warnings: string[];
  acceptance: OfficialPluginAcceptanceMetadata;
  preparedRuntime?: OfficialPluginPreparedRuntime;
}

export interface InstalledOfficialPluginRecord {
  schemaVersion: 1;
  pluginId: string;
  installedAt: string;
  installSource: OfficialPluginReleaseSourceKind;
  packagePath: string;
  upstream: UpstreamPluginIdentity;
  officialRelease: {
    id: string;
    version: string;
    channel: OfficialPluginRelease['channel'];
    catalogVersion: string;
  };
  adapter: {
    id: string;
    version: string;
  };
  capabilityManifest: OfficialPluginCapabilityManifest;
}
