/**
 * F11 回归测试：ACB-004 修复验证（Server update 路由）
 *
 * 覆盖问题：
 *  - ACB-004: Server update 路由存在（Electron + Daemon）
 *
 * 注：WFE-002 / WFE-005 / ACB-004 CLI 部分的源码级检查已随 CLI 从 TypeScript
 * 重写为 Go（tabtin-cli-go）而失效，相关 describe 块已移除。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const electronRouteSrc = readFileSync(
  join(__dirname, '..', '..', 'tabtin-electron', 'src', 'main', 'cli', 'routes', 'tabsite.ts'),
  'utf-8',
);

const daemonRouteSrc = readFileSync(
  join(__dirname, '..', 'src', 'transport', 'cli', 'routes', 'media', 'tabsite.ts'),
  'utf-8',
);

describe('ACB-004: Electron CLI Server has update route', () => {
  it('Electron server matches /update/:id route', () => {
    expect(electronRouteSrc).toContain("update");
    expect(electronRouteSrc).toContain("updateMatch");
  });

  it('Electron server update uses PATCH method check', () => {
    const updateSection = electronRouteSrc.slice(
      electronRouteSrc.indexOf('Update site'),
      electronRouteSrc.indexOf('Site info'),
    );
    expect(updateSection).toContain("method === 'PATCH'");
  });

  it('Electron server update proxies to Django PATCH', () => {
    const updateSection = electronRouteSrc.slice(
      electronRouteSrc.indexOf('Update site'),
      electronRouteSrc.indexOf('Site info'),
    );
    expect(updateSection).toContain("djangoRequest('PATCH'");
    expect(updateSection).toContain('/api/tabsite/sites/');
  });

  it('Electron server update validates non-empty body', () => {
    const updateSection = electronRouteSrc.slice(
      electronRouteSrc.indexOf('Update site'),
      electronRouteSrc.indexOf('Site info'),
    );
    expect(updateSection).toContain('Object.keys(body)');
  });
});

describe('ACB-004: Daemon CLI Server has update route', () => {
  it('Daemon server matches /update/:id route', () => {
    expect(daemonRouteSrc).toContain('/^\\/update\\/([^/]+)$/');
    expect(daemonRouteSrc).toContain('handleUpdateSite');
  });

  it('Daemon server update uses PATCH method check', () => {
    expect(daemonRouteSrc).toContain("[/^\\/update\\/([^/]+)$/, 'PATCH'");
  });

  it('Daemon server update proxies to Django PATCH', () => {
    const updateSection = daemonRouteSrc.slice(daemonRouteSrc.indexOf('async function handleUpdateSite'));
    expect(updateSection).toContain("djangoRequest('PATCH'");
    expect(updateSection).toContain('/api/tabsite/sites/');
  });

  it('Daemon server update validates non-empty body', () => {
    const updateSection = daemonRouteSrc.slice(daemonRouteSrc.indexOf('async function handleUpdateSite'));
    expect(updateSection).toContain('Object.keys(body)');
  });

  it('Daemon server route comments include update route', () => {
    expect(daemonRouteSrc).toContain('PATCH /site/update/:id');
  });
});
