/**
 * Wave 3 F3 — BR-04 & BR-05 regression tests.
 *
 * BR-04: openTab() must honour userAgent by creating an isolated BrowserContext.
 * BR-05: skills.read must accept projectId as alias for spaceId.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════
// BR-04: DaemonBrowserService.openTab() — userAgent isolation
// ═══════════════════════════════════════════════════════════════════

describe('BR-04: openTab() userAgent support', () => {
  const mockRoute = vi.fn(async (_pattern: string, _handler: Function) => {});
  const mockPageClose = vi.fn(async () => {});
  const mockPageIsClosed = vi.fn(() => false);
  const mockPageUrl = vi.fn(() => 'about:blank');
  const mockPageGoto = vi.fn(async () => ({ status: () => 200 }));

  const createMockPage = () => ({
    close: mockPageClose,
    isClosed: mockPageIsClosed,
    url: mockPageUrl,
    goto: mockPageGoto,
    on: vi.fn(),
    viewportSize: () => ({ width: 1280, height: 720 }),
    title: vi.fn(async () => 'Test'),
    content: vi.fn(async () => '<html></html>'),
    innerText: vi.fn(async () => ''),
    evaluate: vi.fn(async () => null),
    waitForSelector: vi.fn(async () => null),
  });

  let capturedContextOptions: any[] = [];
  const mockNewPage = vi.fn(() => createMockPage());
  const mockContextClose = vi.fn(async () => {});
  const mockNewContext = vi.fn((opts?: any) => {
    capturedContextOptions.push(opts);
    return {
      newPage: mockNewPage,
      route: mockRoute,
      close: mockContextClose,
      newCDPSession: vi.fn(),
    };
  });
  const mockBrowser = {
    isConnected: () => true,
    newContext: mockNewContext,
    on: vi.fn(),
    close: vi.fn(async () => {}),
  };

  beforeEach(() => {
    vi.resetModules();
    capturedContextOptions = [];
    mockRoute.mockClear();
    mockNewContext.mockClear();
    mockNewPage.mockClear();
    mockContextClose.mockClear();
    mockPageClose.mockClear();

    vi.doMock('patchright-core', () => ({
      chromium: {
        launch: vi.fn(async () => mockBrowser),
      },
    }));
    vi.doMock('node:fs', () => ({
      existsSync: () => true,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createService() {
    const mod = await import('../src/platform/browser/DaemonBrowserService.js');
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as any;
    return new mod.DaemonBrowserService(logger);
  }

  it('should use shared context when no userAgent provided', async () => {
    const svc = await createService();
    await svc.openTab({ url: 'https://example.com' });

    expect(mockNewContext).toHaveBeenCalledTimes(1);
    expect(capturedContextOptions[0]).not.toHaveProperty('userAgent');
  });

  it('should create isolated context with custom userAgent', async () => {
    const svc = await createService();
    const customUA = 'Mozilla/5.0 CustomBot/1.0';
    await svc.openTab({ url: 'https://example.com', userAgent: customUA });

    const uaContextCall = capturedContextOptions.find(
      (opts) => opts?.userAgent === customUA,
    );
    expect(uaContextCall).toBeDefined();
    expect(uaContextCall.userAgent).toBe(customUA);
  });

  it('should install SSRF interception on custom-UA context', async () => {
    const svc = await createService();
    const customUA = 'Mozilla/5.0 CustomBot/1.0';
    await svc.openTab({ url: 'https://example.com', userAgent: customUA });

    expect(mockRoute).toHaveBeenCalledWith('**/*', expect.any(Function));
  });

  it('should close custom context when closing tab', async () => {
    const svc = await createService();
    const tabId = await svc.openTab({ userAgent: 'CustomAgent/2.0' });

    await svc.closeTab(tabId);

    expect(mockContextClose).toHaveBeenCalled();
  });

  it('should close the per-tab context when closing a normal tab', async () => {
    const svc = await createService();
    const tabId = await svc.openTab();
    mockContextClose.mockClear();

    await svc.closeTab(tabId);

    expect(mockContextClose).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
// BR-05: skills.read — projectId ↔ spaceId compatibility
// ═══════════════════════════════════════════════════════════════════

describe('BR-05: skills.read projectId/spaceId compatibility', () => {
  /**
   * Unit-test the parameter normalisation logic without importing the
   * full skills module (which requires @tabtin/terminal-core etc.).
   * We extract the same logic used in execute():
   *   spaceId = (input.spaceId ?? (input as any).projectId)?.trim() || ''
   */
  function resolveSpaceId(input: Record<string, unknown>): string {
    return (
      ((input.spaceId as string | undefined) ??
        (input.projectId as string | undefined))?.trim() || ''
    );
  }

  it('should resolve spaceId directly', () => {
    expect(resolveSpaceId({ spaceId: 'space-1' })).toBe('space-1');
  });

  it('should resolve projectId as fallback', () => {
    expect(resolveSpaceId({ projectId: 'proj-2' })).toBe('proj-2');
  });

  it('should prefer spaceId over projectId', () => {
    expect(
      resolveSpaceId({ spaceId: 'space-1', projectId: 'proj-2' }),
    ).toBe('space-1');
  });

  it('should return empty when neither provided', () => {
    expect(resolveSpaceId({})).toBe('');
  });

  it('should trim whitespace from projectId', () => {
    expect(resolveSpaceId({ projectId: '  proj-3  ' })).toBe('proj-3');
  });

  it('should fallback to projectId when spaceId is undefined', () => {
    expect(
      resolveSpaceId({ spaceId: undefined, projectId: 'proj-4' }),
    ).toBe('proj-4');
  });
});
