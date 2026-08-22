import { spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  installPersonalPluginFromCodexDirectory,
  parseCodexPluginCapabilityManifest,
  type InstalledPersonalPlugin,
  type PersonalPluginCapabilityManifest,
} from './personal-plugin-registry.js';

export interface PersonalPluginAgentSpaceContext {
  dataRoot?: string;
  /** （硬切）：组织级 Personal Plugin 存储必填。 */
  userId: string;
  organizationId: string;
}

export interface GitHubPluginCheckoutRequest {
  repoUrl: string;
  ref?: string;
  targetDir: string;
}

export interface GitHubPluginCheckoutResult {
  checkoutDir: string;
  sourceDir?: string;
  resolvedCommit: string;
  resolvedRef?: string;
}

export interface PersonalPluginGitHubDownloadAdapter {
  checkout(request: GitHubPluginCheckoutRequest): Promise<GitHubPluginCheckoutResult>;
}

export interface PersonalPluginPermissionSummary {
  source: {
    repoUrl: string;
    requestedRef?: string;
    resolvedRef?: string;
    commit: string;
  };
  installWrites: {
    managedPluginDirectory: true;
    personalPluginRegistry: true;
  };
  capabilities: {
    skills: string[];
    mcpServers: number;
    scripts: string[];
    assets: string[];
    localServices: number;
    apps: number;
    declaredHooks: {
      count: number;
      executedDuringInstall: false;
      commands: string[];
    };
  };
  warnings: string[];
}

export interface PersonalPluginGitHubInstallPreview {
  sourceDir: string;
  checkoutDir: string;
  tempDir: string;
  context: PersonalPluginAgentSpaceContext;
  repoUrl: string;
  requestedRef?: string;
  resolvedRef?: string;
  commit: string;
  manifest: PersonalPluginCapabilityManifest;
  permissionSummary: PersonalPluginPermissionSummary;
}

export interface PreviewPersonalPluginGithubInstallOptions {
  repoUrl: string;
  ref?: string;
  context: PersonalPluginAgentSpaceContext;
  downloadAdapter?: PersonalPluginGitHubDownloadAdapter;
  tempRoot?: string;
}

export interface ApprovePersonalPluginGithubInstallOptions {
  cleanupTempDir?: boolean;
}

export interface PersonalPluginGitHubUpdateCheckOptions {
  installedPlugin: InstalledPersonalPlugin;
  context: PersonalPluginAgentSpaceContext;
  downloadAdapter?: PersonalPluginGitHubDownloadAdapter;
  tempRoot?: string;
}

export interface PersonalPluginGitHubUpdateCurrentRef {
  repoUrl?: string;
  ref?: string;
  commit?: string;
  versionPin?: string;
}

export interface PersonalPluginGitHubUpdateCandidate {
  repoUrl: string;
  requestedRef?: string;
  resolvedRef?: string;
  commit: string;
  versionPin: string;
  manifest: PersonalPluginCapabilityManifest;
  permissionSummary: PersonalPluginPermissionSummary;
}

export interface PersonalPluginGitHubUpdateCheckResult {
  status: 'not-github' | 'up-to-date' | 'update-available';
  pluginId: string;
  current: PersonalPluginGitHubUpdateCurrentRef;
  candidate?: PersonalPluginGitHubUpdateCandidate;
}

function normalizeGitHubRepoUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error('Invalid GitHub repo URL: value is empty');
  }

  if (trimmed.startsWith('git@github.com:')) {
    const repoPath = trimmed.slice('git@github.com:'.length).replace(/\.git$/, '');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoPath)) {
      throw new Error(`Invalid GitHub repo URL: ${rawUrl}`);
    }
    return `git@github.com:${repoPath}.git`;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid GitHub repo URL: ${rawUrl}`);
  }

  if (!['https:', 'git+https:'].includes(parsed.protocol) || parsed.hostname !== 'github.com') {
    throw new Error(`Invalid GitHub repo URL: expected github.com HTTPS URL, got ${rawUrl}`);
  }

  const repoPath = parsed.pathname.replace(/^\/+/, '').replace(/\.git$/, '');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoPath)) {
    throw new Error(`Invalid GitHub repo URL: ${rawUrl}`);
  }
  return `https://github.com/${repoPath}.git`;
}

function isSubpath(root: string, candidate: string): boolean {
  const normalRoot = path.resolve(root);
  const normalCandidate = path.resolve(candidate);
  const relative = path.relative(normalRoot, normalCandidate);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function runGit(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf-8').trim());
        return;
      }
      const detail = Buffer.concat(stderr).toString('utf-8').trim();
      reject(new Error(detail || `git exited with code ${code ?? 'unknown'}`));
    });
  });
}

export const defaultGitHubPluginDownloadAdapter: PersonalPluginGitHubDownloadAdapter = {
  async checkout(request) {
    const repoUrl = normalizeGitHubRepoUrl(request.repoUrl);
    const checkoutDir = path.join(request.targetDir, 'repo');
    await fsp.mkdir(request.targetDir, { recursive: true });
    await runGit(['clone', repoUrl, checkoutDir]);
    if (request.ref) {
      await runGit(['checkout', request.ref], checkoutDir);
    }
    const resolvedCommit = await runGit(['rev-parse', 'HEAD'], checkoutDir);
    const resolvedRef = request.ref ?? await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], checkoutDir);
    return { checkoutDir, resolvedCommit, resolvedRef };
  },
};

function buildPermissionSummary(
  manifest: PersonalPluginCapabilityManifest,
  source: {
    repoUrl: string;
    requestedRef?: string;
    resolvedRef?: string;
    commit: string;
  },
): PersonalPluginPermissionSummary {
  return {
    source,
    installWrites: {
      managedPluginDirectory: true,
      personalPluginRegistry: true,
    },
    capabilities: {
      skills: manifest.skills.map((skill) => skill.id),
      mcpServers: manifest.mcp?.serverCount ?? 0,
      scripts: manifest.scripts,
      assets: manifest.assets,
      localServices: manifest.localServices.length,
      apps: manifest.apps.length,
      declaredHooks: {
        count: manifest.declaredHooks.length,
        executedDuringInstall: false,
        commands: manifest.declaredHooks
          .map((hook) => hook.command)
          .filter((command): command is string => Boolean(command)),
      },
    },
    warnings: manifest.warnings,
  };
}

export async function previewPersonalPluginGithubInstall(
  options: PreviewPersonalPluginGithubInstallOptions,
): Promise<PersonalPluginGitHubInstallPreview> {
  const repoUrl = normalizeGitHubRepoUrl(options.repoUrl);
  const tempRoot = options.tempRoot ?? os.tmpdir();
  await fsp.mkdir(tempRoot, { recursive: true });
  const tempDir = await fsp.mkdtemp(path.join(tempRoot, 'tabtin-github-plugin-'));
  const adapter = options.downloadAdapter ?? defaultGitHubPluginDownloadAdapter;

  let checkout: GitHubPluginCheckoutResult;
  try {
    checkout = await adapter.checkout({
      repoUrl,
      ref: options.ref,
      targetDir: tempDir,
    });
  } catch (err) {
    await fsp.rm(tempDir, { recursive: true, force: true });
    throw new Error(`GitHub plugin clone failed for ${repoUrl}: ${(err as Error).message}`);
  }

  const checkoutDir = path.resolve(checkout.checkoutDir);
  const sourceDir = path.resolve(checkout.sourceDir ?? checkout.checkoutDir);
  if (!isSubpath(tempDir, checkoutDir) || !isSubpath(checkoutDir, sourceDir)) {
    await fsp.rm(tempDir, { recursive: true, force: true });
    throw new Error(`GitHub plugin package path outside checkout safe root: ${sourceDir}`);
  }

  const commit = checkout.resolvedCommit.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) {
    await fsp.rm(tempDir, { recursive: true, force: true });
    throw new Error(`GitHub plugin checkout did not return a valid commit: ${commit || '<empty>'}`);
  }

  try {
    const manifest = await parseCodexPluginCapabilityManifest({
      sourceDir,
      sourceKind: 'github',
      sourceUri: repoUrl,
      repoUrl,
      ref: options.ref,
      versionPin: options.ref ?? commit,
      commit,
    });
    const source = {
      repoUrl,
      requestedRef: options.ref,
      resolvedRef: checkout.resolvedRef,
      commit,
    };
    return {
      sourceDir,
      checkoutDir,
      tempDir,
      context: options.context,
      repoUrl,
      requestedRef: options.ref,
      resolvedRef: checkout.resolvedRef,
      commit,
      manifest,
      permissionSummary: buildPermissionSummary(manifest, source),
    };
  } catch (err) {
    await fsp.rm(tempDir, { recursive: true, force: true });
    throw err;
  }
}

export async function approvePersonalPluginGithubInstall(
  preview: PersonalPluginGitHubInstallPreview,
  options: ApprovePersonalPluginGithubInstallOptions = {},
): Promise<InstalledPersonalPlugin> {
  try {
    return await installPersonalPluginFromCodexDirectory({
      sourceDir: preview.sourceDir,
      sourceKind: 'github',
      sourceUri: preview.repoUrl,
      repoUrl: preview.repoUrl,
      ref: preview.requestedRef,
      versionPin: preview.requestedRef ?? preview.commit,
      commit: preview.commit,
      dataRoot: preview.context.dataRoot,
      userId: preview.context.userId,
      organizationId: preview.context.organizationId,
    });
  } finally {
    if (options.cleanupTempDir !== false) {
      await fsp.rm(preview.tempDir, { recursive: true, force: true });
    }
  }
}

function updateCurrentRef(plugin: InstalledPersonalPlugin): PersonalPluginGitHubUpdateCurrentRef {
  return {
    repoUrl: plugin.source.repoUrl,
    ref: plugin.source.ref,
    commit: plugin.commit ?? plugin.source.commit,
    versionPin: plugin.versionPin ?? plugin.source.versionPin,
  };
}

function updateRef(plugin: InstalledPersonalPlugin): string | undefined {
  return plugin.source.ref ?? (
    plugin.source.versionPin && plugin.source.versionPin !== plugin.source.commit
      ? plugin.source.versionPin
      : undefined
  );
}

function updateCandidate(preview: PersonalPluginGitHubInstallPreview): PersonalPluginGitHubUpdateCandidate {
  return {
    repoUrl: preview.repoUrl,
    requestedRef: preview.requestedRef,
    resolvedRef: preview.resolvedRef,
    commit: preview.commit,
    versionPin: preview.requestedRef ?? preview.commit,
    manifest: preview.manifest,
    permissionSummary: preview.permissionSummary,
  };
}

export async function checkPersonalPluginGithubUpdate(
  options: PersonalPluginGitHubUpdateCheckOptions,
): Promise<PersonalPluginGitHubUpdateCheckResult> {
  const { installedPlugin } = options;
  const current = updateCurrentRef(installedPlugin);
  if (installedPlugin.source.kind !== 'github' || !installedPlugin.source.repoUrl) {
    return { status: 'not-github', pluginId: installedPlugin.pluginId, current };
  }

  const preview = await previewPersonalPluginGithubInstall({
    repoUrl: installedPlugin.source.repoUrl,
    ref: updateRef(installedPlugin),
    context: options.context,
    downloadAdapter: options.downloadAdapter,
    tempRoot: options.tempRoot,
  });
  try {
    if (preview.commit === current.commit) {
      return { status: 'up-to-date', pluginId: installedPlugin.pluginId, current };
    }
    return {
      status: 'update-available',
      pluginId: installedPlugin.pluginId,
      current,
      candidate: updateCandidate(preview),
    };
  } finally {
    await fsp.rm(preview.tempDir, { recursive: true, force: true });
  }
}

export async function approvePersonalPluginGithubUpdate(
  options: PersonalPluginGitHubUpdateCheckOptions,
): Promise<InstalledPersonalPlugin> {
  const { installedPlugin } = options;
  if (installedPlugin.source.kind !== 'github' || !installedPlugin.source.repoUrl) {
    throw new Error(`Personal Plugin is not GitHub-sourced: ${installedPlugin.pluginId}`);
  }

  const preview = await previewPersonalPluginGithubInstall({
    repoUrl: installedPlugin.source.repoUrl,
    ref: updateRef(installedPlugin),
    context: options.context,
    downloadAdapter: options.downloadAdapter,
    tempRoot: options.tempRoot,
  });
  return approvePersonalPluginGithubInstall(preview);
}
