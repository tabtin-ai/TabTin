import { describe, it, expect, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import {
  getHomeTabtinPath,
  getDaemonHomePath,
  setDaemonHomeOverride,
  getPlatformBaseRoot,
  getDataRoot,
  getSpacesRoot,
  getPlatformDataRoot,
  getCheckpointsRoot,
  getCommandSandboxRoot,
  getTabtinTempDir,
  getKnownStorageRoots,
  isSafeStoragePathSegment,
  resolveUserRoot,
  resolveUserSkillsDir,
  resolveUserSkillDir,
  resolveOrganizationRoot,
  resolveOrganizationCheckpointsDir,
  resolveOrganizationSkillsDir,
  resolveOrganizationSkillDir,
  resolveOrganizationPluginsDir,
  resolveOrganizationPluginRegistryFile,
  resolveOrganizationPluginDir,
  resolveWorkspaceMetadataRoot,
  resolveWorkspaceDownloadsDir,
  resolveWorkspaceConversationsRoot,
  resolveWorkspaceFileHistoryRoot,
  resolveWorkspaceSessionArchiveDir,
  resolveWorkspaceToolLogsDir,
  resolveWorkspaceSiteDir,
} from '../storage-paths.js'

describe('storage-paths (2026-05-04 platform-data layout)', () => {
  const home = os.homedir()

  afterEach(() => {
    setDaemonHomeOverride(undefined)
    delete process.env.TABTIN_PLATFORM_BASE_ROOT
    delete process.env.TABTIN_COMMAND_SANDBOX_ROOT
    delete process.env.TABTIN_DATA_ROOT
    delete process.env.TABTIN_RUNTIME_ROOT
  })

  // ── getHomeTabtinPath ────────────────────────────────────────

  describe('getHomeTabtinPath', () => {
    it('returns ~/.tabtin with no segments', () => {
      expect(getHomeTabtinPath()).toBe(path.join(home, '.tabtin'))
    })

    it('joins sub-segments correctly', () => {
      expect(getHomeTabtinPath('screenshots')).toBe(
        path.join(home, '.tabtin', 'screenshots'),
      )
    })

    it('respects the profile-scoped runtime root', () => {
      process.env.TABTIN_RUNTIME_ROOT = '/tmp/tabtin-preprod-runtime'
      expect(getHomeTabtinPath('server.json')).toBe(
        path.join(path.resolve('/tmp/tabtin-preprod-runtime'), 'server.json'),
      )
    })
  })

  // ── getDaemonHomePath ────────────────────────────────────────

  describe('getDaemonHomePath', () => {
    it('defaults to ~/.tabtin-daemon', () => {
      expect(getDaemonHomePath()).toBe(path.join(home, '.tabtin-daemon'))
    })

    it('respects setDaemonHomeOverride', () => {
      setDaemonHomeOverride('/custom/daemon-dir')
      expect(getDaemonHomePath()).toBe(path.join('/custom/daemon-dir'))
      expect(getDaemonHomePath('config.json')).toBe(path.join('/custom/daemon-dir', 'config.json'))
    })
  })

  // ── getPlatformBaseRoot ──────────────────────────────────────

  describe('getPlatformBaseRoot', () => {
    it('returns platform-specific default', () => {
      const result = getPlatformBaseRoot()
      if (process.platform === 'darwin') {
        expect(result).toBe(
          path.join(home, 'Library', 'Application Support', 'TabTin'),
        )
      } else if (process.platform === 'linux') {
        expect(result).toBe(path.join(home, '.tabtin'))
      }
    })

    it('respects TABTIN_PLATFORM_BASE_ROOT env', () => {
      process.env.TABTIN_PLATFORM_BASE_ROOT = '/tmp/test-base'
      expect(getPlatformBaseRoot()).toBe(path.resolve('/tmp/test-base'))
    })
  })

  // ── getSpacesRoot / getPlatformDataRoot ──────────────────────

  describe('getSpacesRoot', () => {
    it('returns {platformBase}/organizations', () => {
      process.env.TABTIN_PLATFORM_BASE_ROOT = '/tmp/test-base'
      expect(getSpacesRoot()).toBe(path.join(path.resolve('/tmp/test-base'), 'organizations'))
    })
  })

  describe('getPlatformDataRoot', () => {
    it('returns {platformBase}/platform-data/organizations', () => {
      process.env.TABTIN_PLATFORM_BASE_ROOT = '/tmp/test-base'
      expect(getPlatformDataRoot()).toBe(
        path.join(path.resolve('/tmp/test-base'), 'platform-data', 'organizations'),
      )
    })

    it('spaces root and platform-data root are siblings under platform base', () => {
      // 关键不变量：user 文件区 (spaces/) 与平台数据区 (platform-data/) 物理隔离，
      // 共享同一平台前缀。
      const base = getPlatformBaseRoot()
      expect(getSpacesRoot()).toBe(path.join(base, 'organizations'))
      expect(getPlatformDataRoot()).toBe(path.join(base, 'platform-data', 'organizations'))
      expect(getSpacesRoot().startsWith(base)).toBe(true)
      expect(getPlatformDataRoot().startsWith(base)).toBe(true)
    })
  })

  // ── getCheckpointsRoot ───────────────────────────────────────

  describe('getCheckpointsRoot', () => {
    it('returns ~/.tabtin/checkpoints', () => {
      expect(getCheckpointsRoot()).toBe(path.join(home, '.tabtin', 'checkpoints'))
    })
  })

  // ── getCommandSandboxRoot ────────────────────────────────────

  describe('getCommandSandboxRoot', () => {
    it('defaults to ~/.tabtin/command-sandboxes', () => {
      expect(getCommandSandboxRoot()).toBe(
        path.join(home, '.tabtin', 'command-sandboxes'),
      )
    })

    it('respects TABTIN_COMMAND_SANDBOX_ROOT env', () => {
      process.env.TABTIN_COMMAND_SANDBOX_ROOT = '/tmp/cmd-sandbox'
      expect(getCommandSandboxRoot()).toBe(path.resolve('/tmp/cmd-sandbox'))
    })
  })

  // ── getTabtinTempDir ─────────────────────────────────────────

  describe('getTabtinTempDir', () => {
    it('creates a temp dir with the given prefix', async () => {
      const dir = await getTabtinTempDir('test')
      expect(dir).toContain('tabtin-test-')
      expect(dir.startsWith(os.tmpdir())).toBe(true)

      const fs = await import('node:fs/promises')
      await fs.rm(dir, { recursive: true, force: true })
    })
  })

  // ── getKnownStorageRoots ─────────────────────────────────────

  describe('getKnownStorageRoots', () => {
    it('returns 7 root descriptors (adds data-root)', () => {
      const roots = getKnownStorageRoots()
      expect(roots.length).toBe(7)
    })

    it('each descriptor has id / label / pathFn / scope', () => {
      for (const root of getKnownStorageRoots()) {
        expect(root.id).toBeTruthy()
        expect(root.label).toBeTruthy()
        expect(typeof root.pathFn).toBe('function')
        expect(['shared', 'daemon-only', 'platform-dependent']).toContain(root.scope)
      }
    })

    it('pathFn returns valid absolute paths', () => {
      for (const root of getKnownStorageRoots()) {
        const p = root.pathFn()
        expect(path.isAbsolute(p)).toBe(true)
      }
    })

    it('contains expected ids', () => {
      const ids = getKnownStorageRoots().map((r) => r.id)
      expect(ids).toContain('home-tabtin')
      expect(ids).toContain('daemon-home')
      expect(ids).toContain('platform-base')
      expect(ids).toContain('data-root')
      expect(ids).toContain('spaces-root')
      expect(ids).toContain('platform-data-root')
      expect(ids).toContain('checkpoints-root')
    })

    it('daemon-home reflects override', () => {
      setDaemonHomeOverride('/alt/daemon')
      const daemonRoot = getKnownStorageRoots().find((r) => r.id === 'daemon-home')!
      expect(daemonRoot.pathFn()).toBe(path.join('/alt/daemon'))
    })
  })

  // ──  新 API ──────────────────────────────────────

  describe('getDataRoot', () => {
    it('defaults to getPlatformBaseRoot', () => {
      expect(getDataRoot()).toBe(getPlatformBaseRoot())
    })

    it('respects TABTIN_DATA_ROOT env', () => {
      process.env.TABTIN_DATA_ROOT = '/tmp/data-root'
      expect(getDataRoot()).toBe(path.resolve('/tmp/data-root'))
    })
  })

  describe('resolveUserRoot / resolveUserSkills*', () => {
    it('joins dataRoot + users + userId', () => {
      expect(resolveUserRoot('/data', 'u1')).toBe(path.join('/data', 'users', 'u1'))
      expect(resolveUserSkillsDir('/data', 'u1')).toBe(path.join('/data', 'users', 'u1', 'skills'))
      expect(resolveUserSkillDir('/data', 'u1', 'my-skill')).toBe(
        path.join('/data', 'users', 'u1', 'skills', 'my-skill'),
      )
    })

    it('throws when userId missing ( hard-cut — no _unscoped)', () => {
      expect(() => resolveUserRoot('/data', undefined as unknown as string)).toThrow(
        /userId is required/,
      )
    })
  })

  describe('resolveOrganizationRoot / resolveOrganization*', () => {
    it('routes through user → organizations', () => {
      expect(resolveOrganizationRoot('/data', 'u1', 'org-a')).toBe(
        path.join('/data', 'users', 'u1', 'organizations', 'org-a'),
      )
      expect(resolveOrganizationCheckpointsDir('/data', 'u1', 'org-a')).toBe(
        path.join('/data', 'users', 'u1', 'organizations', 'org-a', 'checkpoints'),
      )
      expect(resolveOrganizationSkillsDir('/data', 'u1', 'org-a')).toBe(
        path.join('/data', 'users', 'u1', 'organizations', 'org-a', 'skills'),
      )
      expect(resolveOrganizationSkillDir('/data', 'u1', 'org-a', 's1')).toBe(
        path.join('/data', 'users', 'u1', 'organizations', 'org-a', 'skills', 's1'),
      )
    })

    it('throws when orgId missing ( hard-cut — no _unscoped)', () => {
      expect(() =>
        resolveOrganizationRoot('/data', 'u1', undefined as unknown as string),
      ).toThrow(/orgId is required/)
    })

    it('plugins sit under organization root (not workspace)', () => {
      expect(resolveOrganizationPluginsDir('/data', 'u1', 'org-a')).toBe(
        path.join('/data', 'users', 'u1', 'organizations', 'org-a', 'plugins'),
      )
      expect(resolveOrganizationPluginRegistryFile('/data', 'u1', 'org-a')).toBe(
        path.join('/data', 'users', 'u1', 'organizations', 'org-a', 'plugins', 'registry.json'),
      )
      expect(resolveOrganizationPluginDir('/data', 'u1', 'org-a', 'p1')).toBe(
        path.join('/data', 'users', 'u1', 'organizations', 'org-a', 'plugins', 'installed', 'p1'),
      )
    })
  })

  describe('resolveWorkspaceMetadataRoot and subdirs', () => {
    it('throws when workspaceId missing ( hard-cut — no _unscoped)', () => {
      expect(() =>
        resolveWorkspaceMetadataRoot(
          '/data',
          'u1',
          'org-a',
          undefined as unknown as string,
        ),
      ).toThrow(/workspaceId is required/)
    })

    it('is under organization/workspaces (metadata-only)', () => {
      expect(resolveWorkspaceMetadataRoot('/data', 'u1', 'org-a', 'w1')).toBe(
        path.join('/data', 'users', 'u1', 'organizations', 'org-a', 'workspaces', 'w1'),
      )
      expect(resolveWorkspaceDownloadsDir('/data', 'u1', 'org-a', 'w1')).toBe(
        path.join('/data', 'users', 'u1', 'organizations', 'org-a', 'workspaces', 'w1', 'downloads'),
      )
      expect(resolveWorkspaceConversationsRoot('/data', 'u1', 'org-a', 'w1')).toBe(
        path.join('/data', 'users', 'u1', 'organizations', 'org-a', 'workspaces', 'w1', 'conversations'),
      )
      expect(resolveWorkspaceFileHistoryRoot('/data', 'u1', 'org-a', 'w1')).toBe(
        path.join('/data', 'users', 'u1', 'organizations', 'org-a', 'workspaces', 'w1', 'file-history'),
      )
      expect(resolveWorkspaceSessionArchiveDir('/data', 'u1', 'org-a', 'w1')).toBe(
        path.join('/data', 'users', 'u1', 'organizations', 'org-a', 'workspaces', 'w1', 'conversations', 'sessions'),
      )
      expect(resolveWorkspaceToolLogsDir('/data', 'u1', 'org-a', 'w1')).toBe(
        path.join('/data', 'users', 'u1', 'organizations', 'org-a', 'workspaces', 'w1', 'conversations', 'tool-logs'),
      )
      expect(resolveWorkspaceSiteDir('/data', 'u1', 'org-a', 'w1', 'site-slug')).toBe(
        path.join('/data', 'users', 'u1', 'organizations', 'org-a', 'workspaces', 'w1', 'sites', 'site-slug'),
      )
    })

    it('sessions + tool-logs share the same conversations parent (path invariant)', () => {
      const sessions = resolveWorkspaceSessionArchiveDir('/data', 'u1', 'o1', 'w1')
      const toolLogs = resolveWorkspaceToolLogsDir('/data', 'u1', 'o1', 'w1')
      const sessionsParent = path.dirname(sessions)
      const toolLogsParent = path.dirname(toolLogs)
      expect(sessionsParent).toBe(toolLogsParent)
    })

    it('no `spaces/` segment anywhere in new layout', () => {
      const paths = [
        resolveUserRoot('/data', 'u1'),
        resolveUserSkillDir('/data', 'u1', 's1'),
        resolveOrganizationRoot('/data', 'u1', 'o1'),
        resolveOrganizationPluginsDir('/data', 'u1', 'o1'),
        resolveWorkspaceMetadataRoot('/data', 'u1', 'o1', 'w1'),
        resolveWorkspaceDownloadsDir('/data', 'u1', 'o1', 'w1'),
        resolveWorkspaceConversationsRoot('/data', 'u1', 'o1', 'w1'),
      ]
      for (const p of paths) {
        expect(p.split(path.sep)).not.toContain('spaces')
      }
    })
  })

  describe('isSafeStoragePathSegment', () => {
    it('accepts safe single-segment ids', () => {
      expect(isSafeStoragePathSegment('abc')).toBe(true)
      expect(isSafeStoragePathSegment('user_1')).toBe(true)
      expect(isSafeStoragePathSegment('a.b-c')).toBe(true)
    })
    it('rejects traversal / separator / empty', () => {
      expect(isSafeStoragePathSegment('..')).toBe(false)
      expect(isSafeStoragePathSegment('a/b')).toBe(false)
      expect(isSafeStoragePathSegment('a\\b')).toBe(false)
      expect(isSafeStoragePathSegment('')).toBe(false)
      expect(isSafeStoragePathSegment(' a')).toBe(false)
      expect(isSafeStoragePathSegment('/abs')).toBe(false)
    })
  })
})
