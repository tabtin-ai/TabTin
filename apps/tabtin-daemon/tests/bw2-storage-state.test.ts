import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRoute = vi.fn(async (_pattern: string, _handler: Function) => {});
const mockBrowserOn = vi.fn();
const mockBrowserClose = vi.fn(async () => {});

type MockPage = {
  close: ReturnType<typeof vi.fn>;
  isClosed: ReturnType<typeof vi.fn>;
  url: ReturnType<typeof vi.fn>;
  goto: ReturnType<typeof vi.fn>;
  evaluate: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  context: ReturnType<typeof vi.fn>;
  title: ReturnType<typeof vi.fn>;
  content: ReturnType<typeof vi.fn>;
  innerText: ReturnType<typeof vi.fn>;
  waitForSelector: ReturnType<typeof vi.fn>;
  viewportSize: ReturnType<typeof vi.fn>;
  localStorageData: Map<string, string>;
  sessionStorageData: Map<string, string>;
};

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as any;
}

function makeContext(storageState: Record<string, unknown>) {
  const ctx: any = {
    route: mockRoute,
    close: vi.fn(async () => {}),
    cookies: vi.fn(async () => storageState.cookies ?? []),
    addCookies: vi.fn(async () => {}),
    clearCookies: vi.fn(async () => {}),
    clearPermissions: vi.fn(async () => {}),
    storageState: vi.fn(async () => storageState),
    newCDPSession: vi.fn(),
    newPage: vi.fn(),
  };
  ctx.newPage.mockImplementation(() => makePage(ctx));
  return ctx;
}

function makePage(ctx: any, url = 'https://example.com/app'): MockPage {
  const localStorageData = new Map<string, string>([['oldLocal', 'keep']]);
  const sessionStorageData = new Map<string, string>([['oldSession', 'keep']]);
  const page: MockPage = {
    close: vi.fn(async () => {}),
    isClosed: vi.fn(() => false),
    url: vi.fn(() => url),
    goto: vi.fn(async (nextUrl: string) => {
      page.url.mockReturnValue(nextUrl);
      return { status: () => 200 };
    }),
    evaluate: vi.fn(async (fn?: Function, arg?: Array<{ name: string; value: string }>) => {
      const src = String(fn ?? '');
      if (src.includes('window.localStorage.clear')) {
        localStorageData.clear();
        sessionStorageData.clear();
        return undefined;
      }
      if (src.includes('window.localStorage.setItem')) {
        for (const item of arg ?? []) localStorageData.set(item.name, item.value);
        return undefined;
      }
      if (src.includes('window.sessionStorage.setItem')) {
        for (const item of arg ?? []) sessionStorageData.set(item.name, item.value);
        return undefined;
      }
      if (src.includes('window.sessionStorage.length')) {
        return [...sessionStorageData.entries()].map(([name, value]) => ({ name, value }));
      }
      return [];
    }),
    on: vi.fn(),
    context: vi.fn(() => ctx),
    title: vi.fn(async () => 'Test'),
    content: vi.fn(async () => '<html></html>'),
    innerText: vi.fn(async () => ''),
    waitForSelector: vi.fn(async () => null),
    viewportSize: vi.fn(() => ({ width: 1280, height: 720 })),
    localStorageData,
    sessionStorageData,
  };
  return page;
}

describe('BW-2: Daemon storageState save/load', () => {
  let contexts: any[];

  beforeEach(() => {
    vi.resetModules();
    contexts = [];
    mockRoute.mockClear();
    mockBrowserOn.mockClear();
    mockBrowserClose.mockClear();

    vi.doMock('node:fs', () => ({ existsSync: () => true }));
    vi.doMock('patchright-core', () => ({
      chromium: {
        launch: vi.fn(async () => ({
          isConnected: () => true,
          newContext: vi.fn((opts?: any) => {
            const ctx = makeContext({
              cookies: [{ name: 'sid', value: '1', domain: 'example.com', path: '/' }],
              origins: [{
                origin: 'https://example.com',
                localStorage: [{ name: 'theme', value: 'dark' }],
              }],
              opts,
            });
            contexts.push(ctx);
            return ctx;
          }),
          on: mockBrowserOn,
          close: mockBrowserClose,
        })),
      },
    }));
  });

  it('保存命名 session 的 cookies/localStorage，并补当前页 sessionStorage', async () => {
    const { DaemonBrowserService } = await import('../src/platform/browser/DaemonBrowserService.js');
    const svc = new DaemonBrowserService(makeLogger());
    await svc.createSession('research');
    const tabId = await svc.openTabInSession('research', { url: 'https://example.com/app' });
    const page = contexts[0].newPage.mock.results[0].value as MockPage;
    page.evaluate.mockResolvedValue([{ name: 'draft', value: 'yes' }]);

    const result = await svc.saveStorageState({ name: 'research', tabId });

    expect(result.name).toBe('research');
    expect(result.cookieCount).toBe(1);
    expect(result.localStorageCount).toBe(1);
    expect(result.sessionStorageCount).toBe(1);
    expect(result.indexedDB).toBe('not-supported');
    expect(result.state.origins).toEqual([{
      origin: 'https://example.com',
      localStorage: [{ name: 'theme', value: 'dark' }],
      sessionStorage: [{ name: 'draft', value: 'yes' }],
    }]);
  });

  it('加载 storageState 到已有命名 session 默认 merge，且不自动打开缺失 origin', async () => {
    const { DaemonBrowserService } = await import('../src/platform/browser/DaemonBrowserService.js');
    const svc = new DaemonBrowserService(makeLogger());
    await svc.createSession('research');
    await svc.openTabInSession('research', { url: 'https://example.com/app' });
    const page = contexts[0].newPage.mock.results[0].value as MockPage;
    page.evaluate.mockClear();

    const result = await svc.loadStorageState({
      cookies: [{ name: 'sid', value: '2', domain: 'example.com', path: '/' }],
      origins: [
        {
          origin: 'https://example.com',
          localStorage: [{ name: 'theme', value: 'light' }],
          sessionStorage: [{ name: 'draft', value: 'restored' }],
        },
        {
          origin: 'https://other.example',
          sessionStorage: [{ name: 'skip', value: '1' }],
        },
      ],
    }, { name: 'research' });

    expect(contexts[0].addCookies).toHaveBeenCalledWith([
      { name: 'sid', value: '2', domain: 'example.com', path: '/' },
    ]);
    expect(page.evaluate).toHaveBeenCalledTimes(2);
    expect(contexts[0].newPage).toHaveBeenCalledTimes(1);
    expect(page.localStorageData.get('oldLocal')).toBe('keep');
    expect(page.sessionStorageData.get('oldSession')).toBe('keep');
    expect(page.localStorageData.get('theme')).toBe('light');
    expect(page.sessionStorageData.get('draft')).toBe('restored');
    expect(result).toMatchObject({
      name: 'research',
      active: true,
      loaded: true,
      mode: 'merge',
      cookieCount: 1,
      localStorageCount: 1,
      sessionStorageCount: 1,
      skippedSessionStorageOrigins: ['https://other.example'],
      openedSessionStorageOrigins: [],
      indexedDB: 'not-supported',
    });
  });

  it('显式 openMissingOrigins 才为缺失 origin 打开承载页恢复 sessionStorage', async () => {
    const { DaemonBrowserService } = await import('../src/platform/browser/DaemonBrowserService.js');
    const svc = new DaemonBrowserService(makeLogger());
    await svc.createSession('research');
    await svc.openTabInSession('research', { url: 'https://example.com/app' });

    const result = await svc.loadStorageState({
      cookies: [],
      origins: [{
        origin: 'https://other.example',
        sessionStorage: [{ name: 'draft', value: 'restored' }],
      }],
    }, { name: 'research', openMissingOrigins: true });

    expect(contexts[0].newPage).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      sessionStorageCount: 1,
      skippedSessionStorageOrigins: [],
      openedSessionStorageOrigins: ['https://other.example'],
    });
  });

  it('加载到普通 tab 时，没有同 origin 页面则跳过 sessionStorage', async () => {
    const { DaemonBrowserService } = await import('../src/platform/browser/DaemonBrowserService.js');
    const svc = new DaemonBrowserService(makeLogger());
    const tabId = await svc.openTab({ url: 'https://example.com/app' });

    const result = await svc.loadStorageState({
      cookies: [],
      origins: [{
        origin: 'https://other.example',
        sessionStorage: [{ name: 'skip', value: '1' }],
      }],
    }, { name: 'snapshot', tabId });

    expect(result).toMatchObject({
      tabId,
      mode: 'merge',
      sessionStorageCount: 0,
      skippedSessionStorageOrigins: ['https://other.example'],
      openedSessionStorageOrigins: [],
    });
  });

  it('name + tabId 同传时要求 tab 属于该命名 session，避免误写其它 context', async () => {
    const { DaemonBrowserService } = await import('../src/platform/browser/DaemonBrowserService.js');
    const svc = new DaemonBrowserService(makeLogger());
    await svc.createSession('research');
    const otherTabId = await svc.openTab({ url: 'https://example.com/app' });

    await expect(svc.saveStorageState({ name: 'research', tabId: otherTabId }))
      .rejects
      .toThrow(`Tab ${otherTabId} does not belong to session "research"`);
  });

  it('name + tabId 同传时只保存指定 tab 的 sessionStorage', async () => {
    const { DaemonBrowserService } = await import('../src/platform/browser/DaemonBrowserService.js');
    const svc = new DaemonBrowserService(makeLogger());
    await svc.createSession('research');
    const firstTabId = await svc.openTabInSession('research', { url: 'https://example.com/first' });
    const firstPage = contexts[0].newPage.mock.results[0].value as MockPage;
    firstPage.sessionStorageData.set('firstOnly', '1');
    const secondTabId = await svc.openTabInSession('research', { url: 'https://example.com/second' });
    const secondPage = contexts[0].newPage.mock.results[1].value as MockPage;
    secondPage.sessionStorageData.set('secondOnly', '1');

    const result = await svc.saveStorageState({ name: 'research', tabId: secondTabId });

    expect(result.tabId).toBe(secondTabId);
    expect(firstTabId).not.toBe(secondTabId);
    expect(result.state.origins[0]?.sessionStorage).toEqual(
      expect.arrayContaining([{ name: 'secondOnly', value: '1' }]),
    );
    expect(result.state.origins[0]?.sessionStorage).not.toEqual(
      expect.arrayContaining([{ name: 'firstOnly', value: '1' }]),
    );
  });

  it('mode=replace 会先清除目标页旧 storage key', async () => {
    const { DaemonBrowserService } = await import('../src/platform/browser/DaemonBrowserService.js');
    const svc = new DaemonBrowserService(makeLogger());
    const tabId = await svc.openTab({ url: 'https://example.com/app' });
    const page = contexts[0].newPage.mock.results[0].value as MockPage;

    const result = await svc.loadStorageState({
      cookies: [],
      origins: [{
        origin: 'https://example.com',
        localStorage: [{ name: 'theme', value: 'light' }],
        sessionStorage: [{ name: 'draft', value: 'restored' }],
      }],
    }, { name: 'snapshot', tabId, mode: 'replace' });

    expect(result.mode).toBe('replace');
    expect(contexts[0].clearCookies).toHaveBeenCalled();
    expect(page.localStorageData.get('oldLocal')).toBeUndefined();
    expect(page.sessionStorageData.get('oldSession')).toBeUndefined();
    expect(page.localStorageData.get('theme')).toBe('light');
    expect(page.sessionStorageData.get('draft')).toBe('restored');
  });

  it('普通 tab 可直接保存和加载 storageState，无需命名 session', async () => {
    const { DaemonBrowserService } = await import('../src/platform/browser/DaemonBrowserService.js');
    const svc = new DaemonBrowserService(makeLogger());
    const tabId = await svc.openTab({ url: 'https://example.com/app' });
    const page = contexts[0].newPage.mock.results[0].value as MockPage;
    page.evaluate.mockResolvedValue([{ name: 'draft', value: 'tab' }]);

    const saved = await svc.saveStorageState({ name: 'snapshot', tabId });
    expect(saved.tabId).toBe(tabId);
    expect(saved.name).toBe('snapshot');

    page.evaluate.mockClear();
    const loaded = await svc.loadStorageState(saved.state, { name: 'snapshot', tabId });
    expect(loaded.tabId).toBe(tabId);
    expect(loaded.loaded).toBe(true);
    expect(loaded.mode).toBe('merge');
    expect(page.evaluate).toHaveBeenCalled();
  });
});
describe('BW-2: Daemon session save/load routes', () => {
  const sendJSON = vi.fn();
  const res = {} as unknown as import('node:http').ServerResponse;

  beforeEach(() => {
    vi.resetModules();
    sendJSON.mockReset();
  });

  function lastResponse(): { status: number; body: any } {
    expect(sendJSON).toHaveBeenCalled();
    const [, status, body] = sendJSON.mock.calls.at(-1)!;
    return { status, body };
  }


  async function installBrowserApplication(service: any) {
    const [{ DaemonBrowserApplication }, { CliRequestContext }] = await Promise.all([
      import('../src/platform/browser/DaemonBrowserApplication.js'),
      import('../src/transport/cli/cli-context.js'),
    ]);
    const application = new DaemonBrowserApplication({
      resolveBrowser: () => service,
      getSpaceId: () => null,
      startRecording: vi.fn(),
      stopRecording: vi.fn(),
      getRecordingStatus: vi.fn(),
      loadRecording: vi.fn(),
      listRecordings: vi.fn(),
      recordAction: vi.fn(),
    });
    return new CliRequestContext({ get: () => undefined, set: () => {} }, { browserApplication: application });
  }
  it('/browser/session/save 调用 storageState 实现而不是返回 501', async () => {
    const service = {
      isAvailable: () => true,
      saveStorageState: vi.fn(async () => ({
        name: 'research',
        state: { cookies: [], origins: [] },
        savedAt: '2026-06-10T00:00:00.000Z',
        originCount: 0,
        cookieCount: 0,
        localStorageCount: 0,
        sessionStorageCount: 0,
        indexedDB: 'not-supported',
      })),
    };
    const context = await installBrowserApplication(service);

    const { handleBrowserRoute } = await import('../src/transport/cli/routes/browser/index.js');
    await handleBrowserRoute('/browser/session/save', 'POST', { name: 'research' }, res, sendJSON, context);

    expect(service.saveStorageState).toHaveBeenCalledWith({ name: 'research', tabId: undefined });
    const response = lastResponse();
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.data.indexedDB).toBe('not-supported');
  });

  it('/browser/session/load 解析 JSON state 并调用 storageState 实现', async () => {
    const service = {
      isAvailable: () => true,
      loadStorageState: vi.fn(async () => ({
        name: 'research',
        active: true,
        loaded: true,
        cookieCount: 0,
        originCount: 0,
        localStorageCount: 0,
        sessionStorageCount: 0,
        mode: 'merge',
        openedSessionStorageOrigins: [],
        skippedSessionStorageOrigins: [],
        indexedDB: 'not-supported',
      })),
    };
    const context = await installBrowserApplication(service);

    const { handleBrowserRoute } = await import('../src/transport/cli/routes/browser/index.js');
    await handleBrowserRoute('/browser/session/load', 'POST', {
      name: 'research',
      state: '{"cookies":[],"origins":[]}',
    }, res, sendJSON, context);

    expect(service.loadStorageState).toHaveBeenCalledWith(
      { cookies: [], origins: [] },
      { name: 'research', tabId: undefined, mode: undefined, openMissingOrigins: false },
    );
    const response = lastResponse();
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it('/browser/session/load 拒绝非法 JSON state', async () => {
    const service = {
      isAvailable: () => true,
      loadStorageState: vi.fn(),
    };
    const context = await installBrowserApplication(service);

    const { handleBrowserRoute } = await import('../src/transport/cli/routes/browser/index.js');
    await handleBrowserRoute('/browser/session/load', 'POST', {
      name: 'research',
      state: '{bad',
    }, res, sendJSON, context);

    expect(service.loadStorageState).not.toHaveBeenCalled();
    const response = lastResponse();
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('/browser/session/save 对 tab/session 不匹配返回 400', async () => {
    const service = {
      isAvailable: () => true,
      saveStorageState: vi.fn(async () => {
        throw new Error('Tab tab-1 does not belong to session "research"');
      }),
    };
    const context = await installBrowserApplication(service);

    const { handleBrowserRoute } = await import('../src/transport/cli/routes/browser/index.js');
    await handleBrowserRoute('/browser/session/save', 'POST', {
      name: 'research',
      tabId: 'tab-1',
    }, res, sendJSON, context);

    const response = lastResponse();
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});
