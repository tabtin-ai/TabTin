import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import {
  assertSafeStorageSegment,
  resolveDataRoot,
  resolveOrganizationPluginDir,
  resolveOrganizationPluginRegistryFile,
  resolveOrganizationPluginsDir,
} from '../paths/index.js';

const REGISTRY_SCHEMA_VERSION = 1;
const ENABLEMENT_SCHEMA_VERSION = 1;
const META_FILE = '.tabtin-plugin-meta.json';
const ENABLEMENT_FILE = 'enablement.json';
const PLUGIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;

type JsonRecord = Record<string, unknown>;

export interface PersonalPluginSourceRef {
  kind: 'codex-compatible-directory' | 'github';
  uri: string;
  repoUrl?: string;
  ref?: string;
  versionPin?: string;
  commit?: string;
}

export interface PersonalPluginOfficialReleaseMetadata {
  id: string;
  version: string;
  channel: 'stable' | 'preview';
  catalogVersion?: string;
}

export interface PersonalPluginUpstreamMetadata {
  packageName: string;
  version: string;
  repository?: string;
  commit?: string;
  sourcePath?: string;
}

export interface PersonalPluginOfficialAdapterMetadata {
  id: string;
  version: string;
}

export interface PersonalPluginSkillCapability {
  id: string;
  path: string;
  skillMdPath: string;
}

export interface PersonalPluginMcpCapability {
  path: string;
  serverCount: number;
  raw: unknown;
}

export interface DeclaredHookCapability {
  id: string;
  sourcePath: string;
  event?: string;
  command?: string;
  raw: unknown;
}

export interface PersonalPluginCapabilityManifest {
  plugin: {
    id: string;
    name?: string;
    description?: string;
    version?: string;
  };
  source: PersonalPluginSourceRef;
  skills: PersonalPluginSkillCapability[];
  mcp?: PersonalPluginMcpCapability;
  declaredHooks: DeclaredHookCapability[];
  scripts: string[];
  assets: string[];
  apps: unknown[];
  localServices: unknown[];
  files: {
    codexPluginJson?: string;
    mcpJson?: string;
    hooksJson?: string;
  };
  warnings: string[];
}

export interface InstalledPersonalPlugin {
  pluginId: string;
  source: PersonalPluginSourceRef;
  versionPin?: string;
  commit?: string;
  upstream?: PersonalPluginUpstreamMetadata;
  officialRelease?: PersonalPluginOfficialReleaseMetadata;
  adapter?: PersonalPluginOfficialAdapterMetadata;
  installPath: string;
  installedAt: string;
  capabilityManifest: PersonalPluginCapabilityManifest;
}

export interface PersonalPluginRegistryFile {
  schemaVersion: typeof REGISTRY_SCHEMA_VERSION;
  plugins: InstalledPersonalPlugin[];
}

export interface PersonalPluginEnablementRecord {
  pluginId: string;
  enabled: boolean;
  updatedAt: string;
}

export interface PersonalPluginEnablementFile {
  schemaVersion: typeof ENABLEMENT_SCHEMA_VERSION;
  plugins: PersonalPluginEnablementRecord[];
}

export interface PersonalPluginEnablementState extends InstalledPersonalPlugin {
  enabled: boolean;
  enablementUpdatedAt?: string;
}

export interface ParseCodexPluginOptions {
  sourceDir: string;
  sourceKind?: PersonalPluginSourceRef['kind'];
  sourceUri?: string;
  repoUrl?: string;
  ref?: string;
  versionPin?: string;
  commit?: string;
}

/**
 *  / （硬切）Personal Plugin 存储上下文。
 * 组织级布局唯一路径：`{dataRoot}/users/{userId}/organizations/{orgId}/plugins/`。
 * `userId` 必填，缺失直接抛错（不再回落 legacy per-Space 路径）。
 */
export interface PersonalPluginStorageOptions {
  dataRoot?: string;
  userId: string;
  organizationId: string;
}

export interface InstallPersonalPluginOptions extends ParseCodexPluginOptions, PersonalPluginStorageOptions {
  upstream?: PersonalPluginUpstreamMetadata;
  officialRelease?: PersonalPluginOfficialReleaseMetadata;
  adapter?: PersonalPluginOfficialAdapterMetadata;
  /**
   * Test/import escape hatch. Production callers should let the installer derive
   * this from the organization plugin path helpers.
   */
  installDir?: string;
}

interface ResolvedPluginPaths {
  pluginsDir: string;
  registryFile: string;
  installRoot: string;
  enablementFile: string;
  pluginDir: (pluginId: string) => string;
}

export function isValidPersonalPluginId(pluginId: string): boolean {
  return PLUGIN_ID_RE.test(pluginId) && !pluginId.includes('..');
}

function assertPluginStorageSegment(value: string, label: string): string {
  return assertSafeStorageSegment(value, label);
}

function resolvePluginPaths(options: PersonalPluginStorageOptions): ResolvedPluginPaths {
  const organizationId = assertPluginStorageSegment(options.organizationId, 'organizationId');
  const userId = assertPluginStorageSegment(options.userId, 'userId');
  const dataRoot = options.dataRoot ?? resolveDataRoot();
  const pluginsDir = resolveOrganizationPluginsDir(dataRoot, userId, organizationId);
  return {
    pluginsDir,
    registryFile: resolveOrganizationPluginRegistryFile(dataRoot, userId, organizationId),
    installRoot: path.join(pluginsDir, 'installed'),
    enablementFile: path.join(pluginsDir, ENABLEMENT_FILE),
    pluginDir: (pluginId) => resolveOrganizationPluginDir(dataRoot, userId, organizationId, pluginId),
  };
}

function assertInstalledPathInSafeRoot(
  paths: ResolvedPluginPaths,
  plugin: InstalledPersonalPlugin,
): InstalledPersonalPlugin {
  // 仍在当前 layout 安全根下 → 原样返回（含 installDir 逃生舱落在 installed/ 内的路径）。
  if (isSubpath(paths.installRoot, plugin.installPath)) {
    return plugin;
  }
  //  迁移会整目录搬 plugins/，但 registry.json 里常残留旧绝对 installPath
  // （platform-data/.../spaces/...）。强制归一到当前 layout 的 canonical 目录。
  const canonical = paths.pluginDir(plugin.pluginId);
  if (!isSubpath(paths.installRoot, canonical)) {
    throw new Error(
      `Personal plugin registry contains unsafe install path for ${plugin.pluginId}: ${plugin.installPath}`,
    );
  }
  return { ...plugin, installPath: canonical };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(obj: JsonRecord | undefined, ...keys: string[]): string | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function arrayField(obj: JsonRecord | undefined, ...keys: string[]): unknown[] {
  if (!obj) return [];
  for (const key of keys) {
    const value = obj[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function inferLocalServicesFromCodexScripts(scripts: string[]): unknown[] {
  if (!scripts.includes('start-canvas.sh')) return [];
  return [{
    id: 'canvas',
    command: 'bash ./scripts/start-canvas.sh',
    url: 'http://127.0.0.1:43217/',
  }];
}

function localServicesFromPluginJson(pluginJson: JsonRecord, scripts: string[]): unknown[] {
  const declared = arrayField(pluginJson, 'localServices', 'local_services', 'services');
  if (declared.length > 0) return declared;
  return inferLocalServicesFromCodexScripts(scripts);
}

function safeFallbackId(sourceDir: string): string {
  const base = path.basename(path.resolve(sourceDir)).trim();
  return base || 'plugin';
}

async function readJsonIfExists(
  filePath: string,
  warnings: string[],
  label: string,
): Promise<unknown | undefined> {
  try {
    const raw = await fsp.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return undefined;
    warnings.push(`${label} parse skipped: ${(err as Error).message}`);
    return undefined;
  }
}

async function readRequiredPluginJson(filePath: string): Promise<JsonRecord> {
  try {
    const raw = await fsp.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) {
      throw new Error('.codex-plugin/plugin.json must be a JSON object');
    }
    return parsed;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      throw new Error('Codex package parse failed: missing .codex-plugin/plugin.json');
    }
    if (err instanceof SyntaxError) {
      throw new Error(
        `Codex package parse failed: invalid .codex-plugin/plugin.json: ${err.message}`,
      );
    }
    if ((err as Error).message.startsWith('Codex package parse failed:')) {
      throw err;
    }
    throw new Error(`Codex package parse failed: ${(err as Error).message}`);
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listFilesRecursive(rootDir: string): Promise<string[]> {
  const result: string[] = [];

  async function walk(currentDir: string, relativePrefix: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(currentDir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') return;
      throw err;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
      const abs = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        result.push(rel);
      }
    }
  }

  await walk(rootDir, '');
  return result.sort();
}

async function collectSkills(skillsRoot: string): Promise<PersonalPluginSkillCapability[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(skillsRoot, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return [];
    throw err;
  }

  const skills: PersonalPluginSkillCapability[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const skillMdPath = path.join(skillsRoot, entry.name, 'SKILL.md');
    if (!(await pathExists(skillMdPath))) continue;
    skills.push({
      id: entry.name,
      path: `skills/${entry.name}`,
      skillMdPath: `skills/${entry.name}/SKILL.md`,
    });
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id));
}

function commandFromHook(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined;
  return stringField(raw, 'command', 'run', 'script');
}

function eventFromHook(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined;
  return stringField(raw, 'event', 'hook', 'type');
}

function normalizeHookEntry(
  raw: unknown,
  sourcePath: string,
  index: number,
  eventHint?: string,
): DeclaredHookCapability {
  const event = eventHint ?? eventFromHook(raw);
  return {
    id: event ? `${event}:${index}` : `hook:${index}`,
    sourcePath,
    event,
    command: commandFromHook(raw),
    raw,
  };
}

function normalizeDeclaredHooks(raw: unknown, sourcePath: string): DeclaredHookCapability[] {
  if (raw === undefined) return [];
  if (Array.isArray(raw)) {
    return raw.map((entry, index) => normalizeHookEntry(entry, sourcePath, index));
  }
  if (!isRecord(raw)) {
    return [normalizeHookEntry(raw, sourcePath, 0)];
  }

  if (Array.isArray(raw.hooks)) {
    return raw.hooks.map((entry, index) => normalizeHookEntry(entry, sourcePath, index));
  }

  const hooks: DeclaredHookCapability[] = [];
  for (const [event, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        hooks.push(normalizeHookEntry(entry, sourcePath, hooks.length + index, event));
      });
    } else {
      hooks.push(normalizeHookEntry(value, sourcePath, hooks.length, event));
    }
  }
  return hooks;
}

function mcpCapability(raw: unknown, sourcePath: string): PersonalPluginMcpCapability | undefined {
  if (raw === undefined) return undefined;
  const serverCount = isRecord(raw) && isRecord(raw.mcpServers)
    ? Object.keys(raw.mcpServers).length
    : 0;
  return { path: sourcePath, serverCount, raw };
}

function isSubpath(root: string, candidate: string): boolean {
  const normalRoot = path.resolve(root);
  const normalCandidate = path.resolve(candidate);
  const relative = path.relative(normalRoot, normalCandidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

async function copyDirSafe(sourceDir: string, targetDir: string): Promise<void> {
  const resolvedSource = path.resolve(sourceDir);
  const resolvedTarget = path.resolve(targetDir);

  async function copyEntry(sourcePath: string, targetPath: string): Promise<void> {
    if (!isSubpath(resolvedSource, sourcePath)) {
      throw new Error(`source path traversal blocked: ${sourcePath}`);
    }
    if (!isSubpath(resolvedTarget, targetPath)) {
      throw new Error(`target path traversal blocked: ${targetPath}`);
    }

    const stat = await fsp.lstat(sourcePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`symlink entries are not allowed in plugin packages: ${sourcePath}`);
    }
    if (stat.isDirectory()) {
      await fsp.mkdir(targetPath, { recursive: true });
      const entries = await fsp.readdir(sourcePath);
      for (const entry of entries) {
        await copyEntry(path.join(sourcePath, entry), path.join(targetPath, entry));
      }
      return;
    }
    if (stat.isFile()) {
      await fsp.mkdir(path.dirname(targetPath), { recursive: true });
      await fsp.copyFile(sourcePath, targetPath);
    }
  }

  await copyEntry(resolvedSource, resolvedTarget);
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmpPath, JSON.stringify(value, null, 2), 'utf-8');
  await fsp.rename(tmpPath, filePath);
}

async function readRegistry(registryFile: string): Promise<PersonalPluginRegistryFile> {
  try {
    const raw = await fsp.readFile(registryFile, 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      isRecord(parsed)
      && parsed.schemaVersion === REGISTRY_SCHEMA_VERSION
      && Array.isArray(parsed.plugins)
    ) {
      return parsed as unknown as PersonalPluginRegistryFile;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') throw err;
  }
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, plugins: [] };
}

async function readEnablement(enablementFile: string): Promise<PersonalPluginEnablementFile> {
  try {
    const raw = await fsp.readFile(enablementFile, 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      isRecord(parsed)
      && parsed.schemaVersion === ENABLEMENT_SCHEMA_VERSION
      && Array.isArray(parsed.plugins)
    ) {
      return parsed as unknown as PersonalPluginEnablementFile;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') throw err;
  }
  return { schemaVersion: ENABLEMENT_SCHEMA_VERSION, plugins: [] };
}

export async function parseCodexPluginCapabilityManifest(
  options: ParseCodexPluginOptions,
): Promise<PersonalPluginCapabilityManifest> {
  const sourceDir = path.resolve(options.sourceDir);
  const warnings: string[] = [];
  const pluginJsonPath = path.join(sourceDir, '.codex-plugin', 'plugin.json');
  const mcpJsonPath = path.join(sourceDir, '.mcp.json');
  const hooksJsonPath = path.join(sourceDir, 'hooks.json');

  const pluginJson = await readRequiredPluginJson(pluginJsonPath);
  const id = stringField(pluginJson, 'id', 'name', 'slug') ?? safeFallbackId(sourceDir);
  const version = stringField(pluginJson, 'version');
  const versionPin = options.versionPin ?? version;
  const mcpRaw = await readJsonIfExists(mcpJsonPath, warnings, '.mcp.json');
  const hooksRaw = await readJsonIfExists(hooksJsonPath, warnings, 'hooks.json');
  const scripts = await listFilesRecursive(path.join(sourceDir, 'scripts'));

  return {
    plugin: {
      id,
      name: stringField(pluginJson, 'displayName', 'title', 'name'),
      description: stringField(pluginJson, 'description'),
      version,
    },
    source: {
      kind: options.sourceKind ?? 'codex-compatible-directory',
      uri: options.sourceUri ?? sourceDir,
      repoUrl: options.repoUrl,
      ref: options.ref,
      versionPin,
      commit: options.commit,
    },
    skills: await collectSkills(path.join(sourceDir, 'skills')),
    mcp: mcpCapability(mcpRaw, '.mcp.json'),
    declaredHooks: normalizeDeclaredHooks(hooksRaw, 'hooks.json'),
    scripts,
    assets: await listFilesRecursive(path.join(sourceDir, 'assets')),
    apps: arrayField(pluginJson, 'apps'),
    localServices: localServicesFromPluginJson(pluginJson, scripts),
    files: {
      codexPluginJson: '.codex-plugin/plugin.json',
      mcpJson: mcpRaw === undefined ? undefined : '.mcp.json',
      hooksJson: hooksRaw === undefined ? undefined : 'hooks.json',
    },
    warnings,
  };
}

export async function installPersonalPluginFromCodexDirectory(
  options: InstallPersonalPluginOptions,
): Promise<InstalledPersonalPlugin> {
  const paths = resolvePluginPaths(options);
  const manifest = await parseCodexPluginCapabilityManifest(options);
  const pluginId = manifest.plugin.id;
  if (!isValidPersonalPluginId(pluginId)) {
    throw new Error(`Invalid personal plugin id: ${pluginId}`);
  }

  const installPath = options.installDir
    ? path.resolve(options.installDir)
    : paths.pluginDir(pluginId);
  if (!isSubpath(paths.installRoot, installPath)) {
    throw new Error(`Personal plugin install target outside safe root: ${installPath}`);
  }

  const installedAt = new Date().toISOString();
  const record: InstalledPersonalPlugin = {
    pluginId,
    source: manifest.source,
    versionPin: manifest.source.versionPin,
    commit: manifest.source.commit,
    upstream: options.upstream,
    officialRelease: options.officialRelease,
    adapter: options.adapter,
    installPath,
    installedAt,
    capabilityManifest: manifest,
  };

  const tmpDir = path.join(path.dirname(installPath), `.tmp-${pluginId}-${Date.now()}`);
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await copyDirSafe(options.sourceDir, tmpDir);
  await atomicWriteJson(path.join(tmpDir, META_FILE), record);
  await fsp.rm(installPath, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(installPath), { recursive: true });
  await fsp.rename(tmpDir, installPath);

  const registry = await readRegistry(paths.registryFile);
  const nextPlugins = registry.plugins.filter((plugin) => plugin.pluginId !== pluginId);
  nextPlugins.push(record);
  nextPlugins.sort((a, b) => a.pluginId.localeCompare(b.pluginId));
  await atomicWriteJson(paths.registryFile, {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    plugins: nextPlugins,
  } satisfies PersonalPluginRegistryFile);

  return record;
}

export async function listInstalledPersonalPlugins(
  options: PersonalPluginStorageOptions,
): Promise<InstalledPersonalPlugin[]> {
  const paths = resolvePluginPaths(options);
  const registry = await readRegistry(paths.registryFile);
  return registry.plugins.map((plugin) => assertInstalledPathInSafeRoot(paths, plugin));
}

export async function uninstallPersonalPlugin(
  options: PersonalPluginStorageOptions & { pluginId: string },
): Promise<{ removed: boolean; plugin?: InstalledPersonalPlugin }> {
  const pluginId = options.pluginId.trim();
  if (!isValidPersonalPluginId(pluginId)) {
    throw new Error(`Invalid personal plugin id: ${options.pluginId}`);
  }

  const paths = resolvePluginPaths(options);
  const registry = await readRegistry(paths.registryFile);
  const plugin = registry.plugins.find((record) => record.pluginId === pluginId);
  if (!plugin) return { removed: false };

  const safePlugin = assertInstalledPathInSafeRoot(paths, plugin);
  const nextPlugins = registry.plugins.filter((record) => record.pluginId !== pluginId);
  await fsp.rm(safePlugin.installPath, { recursive: true, force: true });
  await atomicWriteJson(paths.registryFile, {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    plugins: nextPlugins,
  } satisfies PersonalPluginRegistryFile);

  return { removed: true, plugin: safePlugin };
}

export async function listPersonalPluginEnablement(
  options: PersonalPluginStorageOptions,
): Promise<PersonalPluginEnablementState[]> {
  // 组织级布局：install + enablement 落同一 pluginsDir，无需再分桶查找。
  const paths = resolvePluginPaths(options);
  const [installed, enablement] = await Promise.all([
    listInstalledPersonalPlugins(options),
    readEnablement(paths.enablementFile),
  ]);

  const enablementByPluginId = new Map(
    enablement.plugins.map((record) => [record.pluginId, record] as const),
  );
  return installed.map((plugin) => {
    const state = enablementByPluginId.get(plugin.pluginId);
    return {
      ...plugin,
      enabled: state?.enabled === true,
      enablementUpdatedAt: state?.updatedAt,
    };
  });
}

export async function setPersonalPluginEnabled(
  options: PersonalPluginStorageOptions & {
    pluginId: string;
    enabled: boolean;
  },
): Promise<PersonalPluginEnablementState> {
  const pluginId = options.pluginId.trim();
  if (!isValidPersonalPluginId(pluginId)) {
    throw new Error(`Invalid personal plugin id: ${options.pluginId}`);
  }

  const writePaths = resolvePluginPaths(options);
  const installed = await listInstalledPersonalPlugins(options);
  const plugin = installed.find((record) => record.pluginId === pluginId);
  if (!plugin) {
    throw new Error(`Personal Plugin is not installed: ${pluginId}`);
  }

  const current = await readEnablement(writePaths.enablementFile);
  const updatedAt = new Date().toISOString();
  const nextPlugins = current.plugins.filter((record) => record.pluginId !== pluginId);
  nextPlugins.push({ pluginId, enabled: options.enabled, updatedAt });
  nextPlugins.sort((a, b) => a.pluginId.localeCompare(b.pluginId));
  await atomicWriteJson(writePaths.enablementFile, {
    schemaVersion: ENABLEMENT_SCHEMA_VERSION,
    plugins: nextPlugins,
  } satisfies PersonalPluginEnablementFile);

  return {
    ...plugin,
    enabled: options.enabled,
    enablementUpdatedAt: updatedAt,
  };
}
