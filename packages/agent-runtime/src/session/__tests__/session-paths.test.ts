import { describe, it, expect } from 'vitest';
import {
  resolveSpaceWorkspaceRoot,
  resolveSpacePlatformDataRoot,
  resolveSpaceConversationsRoot,
  resolveSpaceSessionArchiveDir,
  resolveSpaceToolLogsDir,
  resolveUserSkillDir,
  resolveOrganizationSkillDir,
  resolveOrganizationPluginsDir,
  resolveWorkspaceMetadataRoot,
  resolveWorkspaceDownloadsDir,
  resolveWorkspaceConversationsRoot,
  resolveWorkspaceSessionArchiveDir,
  resolveWorkspaceToolLogsDir,
  resolveWorkspaceSiteDir,
} from '../session-paths.js';

describe('session-paths (2026-05-04 platform-data layout — deprecated)', () => {
  describe('resolveSpaceWorkspaceRoot', () => {
    it('joins spacesRoot + organizationId + spaces/spaceId', () => {
      const result = resolveSpaceWorkspaceRoot('/tmp/spaces', 'wt-789', 'space-abc');
      expect(result).toBe('/tmp/spaces/wt-789/spaces/space-abc');
    });

    it('falls back to _unscoped when either id missing', () => {
      expect(resolveSpaceWorkspaceRoot('/tmp/spaces', undefined, 'space-abc')).toBe(
        '/tmp/spaces/_unscoped/spaces/space-abc',
      );
      expect(resolveSpaceWorkspaceRoot('/tmp/spaces', 'wt', undefined)).toBe(
        '/tmp/spaces/wt/spaces/_unscoped',
      );
    });
  });

  describe('resolveSpacePlatformDataRoot', () => {
    it('joins platformDataRoot + organizationId + spaces/spaceId', () => {
      const result = resolveSpacePlatformDataRoot('/tmp/platform-data', 'wt-789', 'space-abc');
      expect(result).toBe('/tmp/platform-data/wt-789/spaces/space-abc');
    });

    it('falls back to _unscoped on missing ids', () => {
      expect(
        resolveSpacePlatformDataRoot('/tmp/platform-data', undefined, undefined),
      ).toBe('/tmp/platform-data/_unscoped/spaces/_unscoped');
    });
  });

  describe('resolveSpaceConversationsRoot (platform-data subtree)', () => {
    it('appends conversations/ under per-Space platform-data root', () => {
      const result = resolveSpaceConversationsRoot(
        '/tmp/platform-data',
        'wt-789',
        'space-abc',
      );
      expect(result).toBe('/tmp/platform-data/wt-789/spaces/space-abc/conversations');
    });
  });

  describe('resolveSpaceSessionArchiveDir / resolveSpaceToolLogsDir', () => {
    it('both sit under the same per-Space conversations root', () => {
      const archive = resolveSpaceSessionArchiveDir('/c', 'wt', 'sp');
      const toolLogs = resolveSpaceToolLogsDir('/c', 'wt', 'sp');
      expect(archive).toBe('/c/wt/spaces/sp/conversations/sessions');
      expect(toolLogs).toBe('/c/wt/spaces/sp/conversations/tool-logs');

      // Critical invariant: messages.jsonl references tool-logs/{tool_call_id}.md
      // by relative path from the same per-Space tree. If the two roots ever
      // diverge, the agent's "see tool-logs/foo.md" recovery hint breaks.
      const archiveParent = archive.replace(/\/sessions$/, '');
      const toolLogsParent = toolLogs.replace(/\/tool-logs$/, '');
      expect(archiveParent).toBe(toolLogsParent);
    });
  });
});

// ──  新布局回归 ─────────────────────────────────────
describe('workspace-paths ( new SSoT)', () => {
  it('skills 双层：user personal 与 organization', () => {
    expect(resolveUserSkillDir('/data', 'u1', 'my-skill')).toBe(
      '/data/users/u1/skills/my-skill',
    );
    expect(resolveOrganizationSkillDir('/data', 'u1', 'org-a', 'my-skill')).toBe(
      '/data/users/u1/organizations/org-a/skills/my-skill',
    );
  });

  it('plugins 挂 organization（不在 workspace 下）', () => {
    expect(resolveOrganizationPluginsDir('/data', 'u1', 'org-a')).toBe(
      '/data/users/u1/organizations/org-a/plugins',
    );
  });

  it('workspace 只装元数据（downloads / conversations / sites）', () => {
    expect(resolveWorkspaceMetadataRoot('/data', 'u1', 'org-a', 'w1')).toBe(
      '/data/users/u1/organizations/org-a/workspaces/w1',
    );
    expect(resolveWorkspaceDownloadsDir('/data', 'u1', 'org-a', 'w1')).toBe(
      '/data/users/u1/organizations/org-a/workspaces/w1/downloads',
    );
    expect(resolveWorkspaceConversationsRoot('/data', 'u1', 'org-a', 'w1')).toBe(
      '/data/users/u1/organizations/org-a/workspaces/w1/conversations',
    );
    expect(resolveWorkspaceSiteDir('/data', 'u1', 'org-a', 'w1', 'foo')).toBe(
      '/data/users/u1/organizations/org-a/workspaces/w1/sites/foo',
    );
  });

  it('sessions + tool-logs 共享 conversations 父目录（跨系统不变量）', () => {
    const sessions = resolveWorkspaceSessionArchiveDir('/d', 'u', 'o', 'w');
    const toolLogs = resolveWorkspaceToolLogsDir('/d', 'u', 'o', 'w');
    expect(sessions.replace(/\/sessions$/, '')).toBe(
      toolLogs.replace(/\/tool-logs$/, ''),
    );
  });

  it('workspace 元数据路径缺 orgId/workspaceId 抛错（ 禁 _unscoped）', () => {
    expect(() =>
      resolveWorkspaceMetadataRoot(
        '/data',
        'u1',
        undefined as unknown as string,
        'w1',
      ),
    ).toThrow(/orgId is required/);
    expect(() =>
      resolveWorkspaceSessionArchiveDir(
        '/data',
        'u1',
        'org-a',
        undefined as unknown as string,
      ),
    ).toThrow(/workspaceId is required/);
  });
});
