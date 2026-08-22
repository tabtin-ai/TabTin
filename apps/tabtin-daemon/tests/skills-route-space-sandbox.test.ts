import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  djangoRequest: vi.fn(),
  installSkillFromBundle: vi.fn(),
  uninstallSkillLocal: vi.fn(),
  stat: vi.fn(),
  resolveDataRoot: vi.fn(() => '/data-root'),
  resolveOrganizationSkillDir: vi.fn(
    (dataRoot: string, userId: string, organizationId: string, skillKey: string) =>
      `${dataRoot}/users/${userId}/organizations/${organizationId}/skills/${skillKey}`,
  ),
  resolveUserSkillDir: vi.fn(
    (dataRoot: string, userId: string, skillKey: string) =>
      `${dataRoot}/users/${userId}/skills/${skillKey}`,
  ),
  getCLIOrganizationId: vi.fn(() => 'wt-1'),
  requireCLIUserId: vi.fn(() => 'user-1'),
  getCLISkillsMaterializer: vi.fn(),
  parseAppSkillCanonicalKey: vi.fn((key: string) => {
    if (!key.startsWith('app:')) return null;
    const rest = key.slice(4);
    const slash = rest.indexOf('/');
    if (slash <= 0) return null;
    return { appId: rest.slice(0, slash), slug: rest.slice(slash + 1) };
  }),
}));

vi.mock('node:fs/promises', () => ({
  default: {
    stat: mocks.stat,
  },
}));

vi.mock('@tabtin/agent-host/skills', () => ({
  installSkillFromBundle: mocks.installSkillFromBundle,
  uninstallSkillLocal: mocks.uninstallSkillLocal,
  isValidSkillKey: (skillKey: string) => /^[\w][\w.\-@]*$/.test(skillKey) && !skillKey.includes('..'),
}));

vi.mock('@tabtin/agent-runtime/skills', () => ({
  parseAppSkillCanonicalKey: mocks.parseAppSkillCanonicalKey,
}));

vi.mock('@tabtin/terminal-core', () => ({
  resolveDataRoot: mocks.resolveDataRoot,
  resolveOrganizationSkillDir: mocks.resolveOrganizationSkillDir,
  resolveUserSkillDir: mocks.resolveUserSkillDir,
}));

vi.mock('../src/transport/cli/cli-context.js', () => ({
  getCLIOrganizationId: mocks.getCLIOrganizationId,
  requireCLIUserId: mocks.requireCLIUserId,
  getCLISkillsMaterializer: mocks.getCLISkillsMaterializer,
}));

vi.mock('../src/transport/cli/routes/shared/error-handler.js', () => ({
  djangoRequest: mocks.djangoRequest,
  errorResponse: (code: string, message: string, extra?: unknown) => ({ ok: false, code, message, ...extra }),
  sendDjangoResult: (res: unknown, sendJSON: Function, result: { status: number; data: unknown }) => {
    sendJSON(res, result.status, result.data);
  },
}));

const bundleFile = {
  path: 'SKILL.md',
  sha256: 'sha256',
  size: 10,
  download_url: 'https://example.test/SKILL.md',
  content_type: 'text/markdown',
};

function enableUserResponse(overrides: Record<string, unknown> = {}) {
  return {
    status: 200,
    data: {
      data: {
        skill_canonical_key: 'user:demo-skill',
        enabled: true,
        source: 'user',
        package_id: 'pkg-demo',
        installed_version_seq: 1,
        install_content_hash: 'hash',
        ...overrides,
      },
    },
  };
}

function enableAppResponse(key = 'app:tabtin-office-skills-pack/meeting-notes-to-actions') {
  return {
    status: 200,
    data: {
      data: {
        skill_canonical_key: key,
        enabled: true,
        source: 'app',
        package_id: null,
        installed_version_seq: null,
      },
    },
  };
}

describe('Daemon skills route Wave 1 enable+materialize ( /  硬切)', () => {
  let handleSkillsRoute: typeof import('../src/transport/cli/routes/skills/index.js').handleSkillsRoute;
  const res = {} as any;
  const sendJSON = vi.fn();
  const cliContext = {
    getOrganizationId: () => mocks.getCLIOrganizationId(),
    requireUserId: () => mocks.requireCLIUserId(),
    getSkillsMaterializer: () => mocks.getCLISkillsMaterializer(),
    getSkillsInteropAdder: () => null,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.resolveDataRoot.mockReturnValue('/data-root');
    mocks.installSkillFromBundle.mockResolvedValue({ ok: true, filesWritten: 1 });
    mocks.uninstallSkillLocal.mockResolvedValue(true);
    mocks.stat.mockResolvedValue({ isDirectory: () => true });
    mocks.getCLIOrganizationId.mockReturnValue('wt-1');
    mocks.requireCLIUserId.mockReturnValue('user-1');
    mocks.getCLISkillsMaterializer.mockReturnValue(
      vi.fn().mockResolvedValue({ installed: 1, skipped: 0, errors: [] }),
    );
    const mod = await import('../src/transport/cli/routes/skills/index.js');
    handleSkillsRoute = mod.handleSkillsRoute;
  });

  it('enables user skill and downloads package registry bundle into org skills dir', async () => {
    mocks.djangoRequest
      .mockResolvedValueOnce(enableUserResponse())
      .mockResolvedValueOnce({
        status: 200,
        data: {
          data: {
            version_seq: 1,
            version_label: '1.0.0',
            bundle_sha256: 'bundle-sha',
            files: [bundleFile],
          },
        },
      });

    await handleSkillsRoute(
      '/skills/user%3Ademo-skill/enable',
      'POST',
      { space_id: 'space-1' },
      res,
      sendJSON,
      cliContext as any,
    );

    // ：enable/disable 锚点从 space_id 迁到 organization_id——转发给 Django
    // 的 body 只带 organization_id（space_id 被 withCanonicalOrganizationId 剥离，
    // 本地物化另经 materializeBody 单独携带）。
    expect(mocks.djangoRequest).toHaveBeenNthCalledWith(
      1,
      'POST',
      '/api/skills/user:demo-skill/enable',
      { organization_id: 'wt-1' },
      expect.anything(),
    );
    expect(mocks.djangoRequest).toHaveBeenNthCalledWith(
      2,
      'GET',
      '/api/services/package-registry/packages/pkg-demo/versions/1/files',
      undefined,
      expect.anything(),
    );
    // （硬切）：本地落盘走 dataRoot + userId 组织 skills 目录，
    // 不再是 legacy `{platformDataRoot}/{org}/spaces/{sp}/skills/`。
    expect(mocks.resolveOrganizationSkillDir).toHaveBeenCalledWith('/data-root', 'user-1', 'wt-1', 'demo-skill');
    expect(mocks.installSkillFromBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        skillKey: 'demo-skill',
        targetDir: '/data-root/users/user-1/organizations/wt-1/skills/demo-skill',
      }),
    );
    expect(sendJSON).toHaveBeenCalledWith(res, 200, expect.anything());
  });

  it('enables app skill via materializeAppSkill with real userId (no _unscoped)', async () => {
    const materializer = vi.fn().mockResolvedValue({ installed: 1, skipped: 0, errors: [] });
    mocks.getCLISkillsMaterializer.mockReturnValue(materializer);
    mocks.djangoRequest.mockResolvedValue(enableAppResponse());

    await handleSkillsRoute(
      '/skills/app%3Atabtin-office-skills-pack%2Fmeeting-notes-to-actions/enable',
      'POST',
      { space_id: 'space-1' },
      res,
      sendJSON,
      cliContext as any,
    );

    expect(materializer).toHaveBeenCalledWith({
      organizationId: 'wt-1',
      spaceId: 'space-1',
      userId: 'user-1',
      appId: 'tabtin-office-skills-pack',
      slug: 'meeting-notes-to-actions',
    });
    expect(mocks.installSkillFromBundle).not.toHaveBeenCalled();
    expect(sendJSON).toHaveBeenCalledWith(res, 200, expect.anything());
  });

  it('rejects enable before proxying when organization_id is missing ( anchor)', async () => {
    mocks.getCLIOrganizationId.mockReturnValue(null);

    await handleSkillsRoute(
      '/skills/user%3Ademo-skill/enable',
      'POST',
      {},
      res,
      sendJSON,
      cliContext as any,
    );

    expect(mocks.djangoRequest).not.toHaveBeenCalled();
    expect(sendJSON).toHaveBeenCalledWith(
      res,
      400,
      expect.objectContaining({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('organization_id'),
      }),
    );
  });

  it('keeps backend enable success but surfaces a warning when local materialize fails (: 不回滚总闸)', async () => {
    mocks.djangoRequest
      .mockResolvedValueOnce(enableUserResponse())
      .mockResolvedValueOnce({
        status: 200,
        data: { data: { version_seq: 1, files: [bundleFile] } },
      });
    mocks.installSkillFromBundle.mockResolvedValue({ ok: false, filesWritten: 0, error: 'download failed' });

    await handleSkillsRoute(
      '/skills/user%3Ademo-skill/enable',
      'POST',
      { space_id: 'space-1' },
      res,
      sendJSON,
      cliContext as any,
    );

    // 本机装包失败不回滚后端总闸：不应再发 disable 请求。
    expect(mocks.djangoRequest).toHaveBeenCalledTimes(2);
    expect(sendJSON).toHaveBeenCalledWith(
      res,
      200,
      expect.objectContaining({
        warning: expect.stringContaining('download failed'),
      }),
    );
  });

  it('fails materialize when CLI userId is unresolved (no silent _unscoped fallback)', async () => {
    mocks.requireCLIUserId.mockImplementation(() => {
      throw new Error('未登录：无法解析 userId，拒绝写入本地 skills 目录');
    });
    mocks.djangoRequest
      .mockResolvedValueOnce(enableUserResponse())
      .mockResolvedValueOnce({
        status: 200,
        data: { data: { version_seq: 1, files: [bundleFile] } },
      });

    await handleSkillsRoute(
      '/skills/user%3Ademo-skill/enable',
      'POST',
      { space_id: 'space-1' },
      res,
      sendJSON,
      cliContext as any,
    );

    expect(mocks.installSkillFromBundle).not.toHaveBeenCalled();
    expect(sendJSON).toHaveBeenCalledWith(
      res,
      200,
      expect.objectContaining({
        warning: expect.stringContaining('未登录'),
      }),
    );
  });

  it('removes local files on disable with remove=true', async () => {
    mocks.djangoRequest.mockResolvedValue({
      status: 200,
      data: { data: { skill_canonical_key: 'user:demo-skill', enabled: false, found: true } },
    });

    await handleSkillsRoute(
      '/skills/user%3Ademo-skill/disable',
      'POST',
      { space_id: 'space-2', remove: true },
      res,
      sendJSON,
      cliContext as any,
    );

    expect(mocks.resolveOrganizationSkillDir).toHaveBeenCalledWith('/data-root', 'user-1', 'wt-1', 'demo-skill');
    expect(mocks.uninstallSkillLocal).toHaveBeenCalledWith('/data-root/users/user-1/organizations/wt-1/skills/demo-skill');
  });

  it('keeps local files on plain disable (remove=false)', async () => {
    mocks.djangoRequest.mockResolvedValue({
      status: 200,
      data: { data: { skill_canonical_key: 'user:demo-skill', enabled: false, found: true } },
    });

    await handleSkillsRoute(
      '/skills/user%3Ademo-skill/disable',
      'POST',
      { space_id: 'space-2' },
      res,
      sendJSON,
      cliContext as any,
    );

    expect(mocks.uninstallSkillLocal).not.toHaveBeenCalled();
    expect(sendJSON).toHaveBeenCalledWith(res, 200, expect.anything());
  });

  it('no longer treats managed/install as install path', async () => {
    mocks.djangoRequest.mockResolvedValue({ status: 404, data: { message: 'not found' } });

    await handleSkillsRoute(
      '/skills/managed/install',
      'POST',
      { skill_key: 'demo-skill', space_id: 'space-1' },
      res,
      sendJSON,
      cliContext as any,
    );

    expect(mocks.djangoRequest).toHaveBeenCalledWith(
      'POST',
      '/api/skills/managed/install',
      expect.anything(),
      expect.anything(),
    );
    expect(mocks.installSkillFromBundle).not.toHaveBeenCalled();
  });
});
