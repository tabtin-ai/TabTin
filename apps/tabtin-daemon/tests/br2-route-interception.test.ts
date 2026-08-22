/**
 * BR-2 回归：Daemon 拦截路由的"诚实性"。
 *
 * 旧实现 `/browser/route-list` 返回 200 + {routes: []} 假成功——Agent 会误以为
 * "确实没有任何拦截规则"，而真相是 Daemon 根本不维护可查询的规则列表。
 * 修复后改为诚实的 501 NOT_IMPLEMENTED，且提示里指向真实存在的 CLI 命令
 * （route / unroute），不再误导用户。
 *
 * 不起真实 HTTP server——直接调 handleBrowserRoute + mock res/sendJSON
 * （与 storage-route.test.ts 同风格）。`/route-list` 分支不依赖浏览器服务，
 * 因此无需 mock patchright / 启动浏览器。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleBrowserRoute } from '../src/transport/cli/routes/browser/index.js';
import { CliRequestContext } from '../src/transport/cli/cli-context.js';

const sendJSON = vi.fn();
const res = {} as unknown as import('node:http').ServerResponse;

function lastResponse(): { status: number; body: any } {
  expect(sendJSON).toHaveBeenCalled();
  const calls = sendJSON.mock.calls;
  const [, status, body] = calls[calls.length - 1];
  return { status, body };
}

beforeEach(() => {
  sendJSON.mockReset();
});

describe('BR-2: /browser/route-list 诚实报未实现（不再空数组假成功）', () => {
  const context = new CliRequestContext({ get: () => undefined, set: () => {} }, { browserApplication: {} as any });
  it('返回 501 NOT_IMPLEMENTED', async () => {
    await handleBrowserRoute('/browser/route-list', 'POST', {}, res, sendJSON, context);
    const r = lastResponse();
    expect(r.status).toBe(501);
    expect(r.body.ok).toBe(false);
    expect(r.body.error.code).toBe('NOT_IMPLEMENTED');
  });

  it('不再返回 routes 假数据', async () => {
    await handleBrowserRoute('/browser/route-list', 'POST', {}, res, sendJSON, context);
    const r = lastResponse();
    // 旧实现：sendJSON(200, okResponse({ routes: [] }))。修复后既无 data.routes，也无顶层 routes。
    expect(r.body.data?.routes).toBeUndefined();
    expect(r.body.routes).toBeUndefined();
  });

  it('提示里只指向真实存在的 CLI 命令（route / unroute）', async () => {
    await handleBrowserRoute('/browser/route-list', 'POST', {}, res, sendJSON, context);
    const r = lastResponse();
    const sugg = JSON.stringify(r.body.error.suggestions ?? []);
    expect(sugg).toContain('tabtin browser route');
    expect(sugg).toContain('tabtin browser unroute');
  });
});
