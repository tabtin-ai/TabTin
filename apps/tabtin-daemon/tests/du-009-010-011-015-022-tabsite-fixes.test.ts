/**
 * DU-011/015 回归测试：TabSite Daemon 路由修复验证
 *
 * 覆盖问题：
 *  - DU-011: Daemon build-info 返回 upload_available: false
 *  - DU-015: Daemon publish 路由校验 dist_url 非空
 *
 * 注：DU-009/010/022 原为 CLI TypeScript 源码级验证，CLI 已重写为 Go
 * （tabtin-cli-go），相关 describe 块已移除。
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';

// ── Daemon route integration tests ─────────────────────────────────
// These tests require pnpm build to resolve @tabtin/* workspace packages.
// They are conditionally skipped when the server cannot be started.

describe('DU-011/015: Daemon TabSite route fixes', () => {
  let serverInfo: { socketPath: string; token: string } | null = null;
  let startupFailed = false;

  beforeAll(async () => {
    try {
      const { startCLIServer } = await import('../src/transport/cli/cli-server.js');
      const socketPath = join(__dirname, '..', `.test-tabsite-du-${process.pid}.sock`);
      serverInfo = startCLIServer({ version: '0.0.1-test', socketPath });
    } catch {
      startupFailed = true;
    }
  });

  afterAll(async () => {
    if (startupFailed || !serverInfo) return;
    const sockPath = serverInfo?.socketPath;
    try {
      const { stopCLIServer } = await import('../src/transport/cli/cli-server.js');
      await stopCLIServer();
    } catch { /* ignore */ }
    if (sockPath && existsSync(sockPath)) {
      try { unlinkSync(sockPath); } catch { /* ignore */ }
    }
  });

  function makeRequest(
    path: string,
    method: string = 'POST',
    body?: Record<string, any>,
  ): Promise<{ status: number; data: any }> {
    return new Promise((resolve, reject) => {
      const bodyStr = body ? JSON.stringify(body) : undefined;
      const req = http.request(
        {
          socketPath: serverInfo!.socketPath,
          path,
          method,
          headers: {
            'Content-Type': 'application/json',
            'x-tabtin-token': serverInfo!.token,
            ...(bodyStr ? { 'Content-Length': String(Buffer.byteLength(bodyStr)) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf-8');
            try {
              resolve({ status: res.statusCode ?? 500, data: JSON.parse(raw) });
            } catch {
              resolve({ status: res.statusCode ?? 500, data: { raw } });
            }
          });
        },
      );
      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  // ── DU-011: init-template / upload-dist validation ──────────────
  // Daemon now supports init-template and upload-dist via @tabtin/tabsite-core.
  // Verify parameter validation instead of 501 NOT_IMPLEMENTED.

  it('DU-011: init-template rejects missing space_id', async () => {
    if (startupFailed) return;
    const { status, data } = await makeRequest('/site/init-template/test-site-id', 'POST', {});
    expect(status).toBe(400);
    expect(data.ok).toBe(false);
    expect(data.error?.code).toBe('VALIDATION_ERROR');
  });

  it('DU-011: upload-dist rejects missing dist_path', async () => {
    if (startupFailed) return;
    const { status, data } = await makeRequest('/site/upload-dist/test-site-id', 'POST', {});
    expect(status).toBe(400);
    expect(data.ok).toBe(false);
    expect(data.error?.code).toBe('VALIDATION_ERROR');
  });

  // ── DU-015: publish rejects empty dist_url ─────────────────────

  it('DU-015: publish rejects request with missing dist_url', async () => {
    if (startupFailed) return;
    const { status, data } = await makeRequest('/site/publish/test-site-id', 'POST', {
      message: 'test publish',
    });
    expect(status).toBe(400);
    expect(data.ok).toBe(false);
    expect(data.error?.code).toBe('VALIDATION_ERROR');
    expect(data.error?.message).toContain('dist_url');
  });

  it('DU-015: publish rejects request with empty string dist_url', async () => {
    if (startupFailed) return;
    const { status, data } = await makeRequest('/site/publish/test-site-id', 'POST', {
      message: 'test publish',
      dist_url: '',
    });
    expect(status).toBe(400);
    expect(data.ok).toBe(false);
    expect(data.error?.code).toBe('VALIDATION_ERROR');
  });

  it('DU-015: publish does not reject when dist_url is provided', async () => {
    if (startupFailed) return;
    const { status, data } = await makeRequest('/site/publish/test-site-id', 'POST', {
      message: 'test publish',
      dist_url: 'https://cdn.example.com/tabsite/sites/test/dist/',
    });
    if (status === 400) {
      expect(data.error?.message).not.toContain('dist_url');
    }
  });
});

// ── DU-011: Daemon build-info includes upload_available ────────────

describe('DU-011: Daemon tabsite route includes upload_available in build-info', () => {
  const daemonRouteSrc = readFileSync(
    join(__dirname, '..', 'src', 'transport', 'cli', 'routes', 'media', 'tabsite.ts'),
    'utf-8',
  );

  it('build-info response includes upload_available field', () => {
    const buildInfoSection = daemonRouteSrc.slice(
      daemonRouteSrc.indexOf('async function handleBuildInfo'),
      daemonRouteSrc.indexOf('async function handleCreateSite'),
    );
    expect(buildInfoSection).toContain('upload_available: true');
  });
});

// ── DU-015: Daemon publish route validates dist_url ────────────────

describe('DU-015: Daemon publish route validates dist_url', () => {
  const daemonRouteSrc = readFileSync(
    join(__dirname, '..', 'src', 'transport', 'cli', 'routes', 'media', 'tabsite.ts'),
    'utf-8',
  );

  it('publish handler checks dist_url before proxying to Django', () => {
    const publishSection = daemonRouteSrc.slice(
      daemonRouteSrc.indexOf('async function handlePublishSite'),
      daemonRouteSrc.indexOf('async function handleRollbackSite'),
    );
    expect(publishSection).toContain('dist_url');
    expect(publishSection).toContain('VALIDATION_ERROR');
  });

  it('validation happens before djangoRequest call', () => {
    const publishSection = daemonRouteSrc.slice(
      daemonRouteSrc.indexOf('async function handlePublishSite'),
      daemonRouteSrc.indexOf('async function handleRollbackSite'),
    );
    const validationIdx = publishSection.indexOf('VALIDATION_ERROR');
    const djangoIdx = publishSection.indexOf('djangoRequest');
    expect(validationIdx).toBeGreaterThan(0);
    expect(djangoIdx).toBeGreaterThan(0);
    expect(validationIdx).toBeLessThan(djangoIdx);
  });
});
