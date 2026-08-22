/**
 * BR-1 — Daemon cookies route 动作词表对齐（逻辑复刻单测）。
 *
 * 背景：修复前 CLI cookies set/clear 不发 action → Daemon 默认 action='get'，
 * set/clear 静默退化成 get（返回一堆 cookies，Agent 误以为成功）。且 Daemon 原本
 * 只认 {get, add, clear}（是 add 不是 set），单给 CLI 加 action='set' 会在 Daemon
 * 上变成 400「不支持的 action」。修复后双端动词统一为 get/set/clear，Daemon 把 'set'
 * 当 'add' 的别名收下（保留 'add' 兼容旧调用）。
 *
 * 为何复刻而非 import 真 handler：daemon 的 handleBrowserRoute 顶层 import 链会拖入
 * 一串未构建 dist 的 workspace 包（@tabtin/shared/storage-paths、@tabtin/browser-core
 * 等），vitest 在 install 后默认跑不动（仓库既有 BR-05 测试同样用「复刻被测逻辑」绕开）。
 * 这里 1:1 镜像 apps/tabtin-daemon/src/transport/cli/routes/browser/index.ts 的 `/cookies` 分支，
 * 改 handler 时务必同步本测试。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 复刻 @tabtin/agent-wire 的响应信封形状（与真实端一致）。
const okResponse = (data: unknown) => ({ ok: true as const, data });
const errorResponse = (code: string, message: string, extra?: Record<string, unknown>) => ({
  ok: false as const,
  error: { code, message, ...extra },
});

interface CookieSvc {
  getCookies: (urls?: string[]) => Promise<unknown[]>;
  addCookies: (cookies: unknown[]) => Promise<void>;
  clearCookies: () => Promise<void>;
}

interface Sent {
  statusCode: number;
  payload: any;
}

/**
 * 1:1 复刻 browser.ts `if (route === '/cookies')` 分支（含 BR-1 的 set→add 别名）。
 * 任何对源码该分支的改动都应同步到此。
 */
async function cookiesRoute(body: any, svc: CookieSvc): Promise<Sent> {
  let sent: Sent = { statusCode: 0, payload: null };
  const sendJSON = (code: number, data: any) => { sent = { statusCode: code, payload: data }; };

  const action = body.action || 'get';
  try {
    if (action === 'get') {
      const urls: string[] | undefined = Array.isArray(body.urls)
        ? body.urls
        : (body.url ? [body.url] : undefined);
      const cookies = await svc.getCookies(urls);
      sendJSON(200, okResponse({ cookies, count: cookies.length }));
    } else if (action === 'add' || action === 'set') {
      // BR-1: 'set' 是 'add' 的别名（保留 'add' 兼容旧调用）。
      if (!Array.isArray(body.cookies) || body.cookies.length === 0) {
        sendJSON(400, errorResponse('VALIDATION_ERROR', '缺少 cookies 数组参数', {
          suggestions: ['body.cookies 应为 Playwright Cookie 对象数组，每项至少含 name、value、domain 或 url'],
        }));
        return sent;
      }
      await svc.addCookies(body.cookies);
      sendJSON(200, okResponse({ added: body.cookies.length }));
    } else if (action === 'clear') {
      await svc.clearCookies();
      sendJSON(200, okResponse({ cleared: true }));
    } else {
      sendJSON(400, errorResponse('VALIDATION_ERROR', `不支持的 cookies action: ${action}`, {
        suggestions: ['支持的 action: get（获取）、set（设置，等同 add）、clear（清除）'],
      }));
    }
  } catch (err: any) {
    sendJSON(500, errorResponse('INTERNAL_ERROR', err?.message || 'Cookie 操作失败', { retryable: true }));
  }
  return sent;
}

describe('BR-1: Daemon cookies route 动作词表（set 作 add 别名）', () => {
  const addCookies = vi.fn(async (_cookies: unknown[]) => {});
  const clearCookies = vi.fn(async () => {});
  const getCookies = vi.fn(async (_urls?: string[]) => [
    { name: 'a', value: 'b', domain: 'example.com' },
  ]);
  const svc: CookieSvc = { addCookies, clearCookies, getCookies };

  beforeEach(() => {
    addCookies.mockClear();
    clearCookies.mockClear();
    getCookies.mockClear();
  });

  it('action=set 应作为 add 别名，调用 addCookies 而非 getCookies', async () => {
    const cookies = [{ name: 'sid', value: 'abc', domain: 'example.com' }];
    const { statusCode, payload } = await cookiesRoute({ action: 'set', cookies }, svc);

    expect(addCookies).toHaveBeenCalledWith(cookies);
    expect(getCookies).not.toHaveBeenCalled();
    expect(statusCode).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.data.added).toBe(1);
  });

  it('action=add 仍兼容（旧调用不破）', async () => {
    const cookies = [{ name: 'sid', value: 'abc', domain: 'example.com' }];
    const { statusCode, payload } = await cookiesRoute({ action: 'add', cookies }, svc);

    expect(addCookies).toHaveBeenCalledWith(cookies);
    expect(statusCode).toBe(200);
    expect(payload.data.added).toBe(1);
  });

  it('action=set 缺 cookies 数组应 400，且不调用 addCookies', async () => {
    const { statusCode, payload } = await cookiesRoute({ action: 'set' }, svc);

    expect(addCookies).not.toHaveBeenCalled();
    expect(statusCode).toBe(400);
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('VALIDATION_ERROR');
  });

  it('action=clear 调用 clearCookies', async () => {
    const { statusCode, payload } = await cookiesRoute({ action: 'clear' }, svc);

    expect(clearCookies).toHaveBeenCalledTimes(1);
    expect(getCookies).not.toHaveBeenCalled();
    expect(statusCode).toBe(200);
    expect(payload.data.cleared).toBe(true);
  });

  it('action=get（默认，缺省 action）调用 getCookies', async () => {
    const { statusCode, payload } = await cookiesRoute({}, svc);

    expect(getCookies).toHaveBeenCalledTimes(1);
    expect(addCookies).not.toHaveBeenCalled();
    expect(statusCode).toBe(200);
    expect(payload.data.count).toBe(1);
  });

  it('未知 action 报 400，提示词表含 set', async () => {
    const { statusCode, payload } = await cookiesRoute({ action: 'bogus' }, svc);

    expect(statusCode).toBe(400);
    expect(payload.ok).toBe(false);
    expect(JSON.stringify(payload.error)).toContain('set');
  });
});
