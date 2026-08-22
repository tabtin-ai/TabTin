/**
 * Tests for B-01 (tsup noExternal) and I-1 (code route wiring).
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';

// ── B-01: tsup noExternal ────────────────────────────────────────

describe('B-01: tsup noExternal covers all @tabtin/* workspace packages', () => {
  const rootDir = join(__dirname, '..');
  const pkgJson = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8'));
  const tsupConfigRaw = readFileSync(join(rootDir, 'tsup.config.ts'), 'utf-8');

  const workspaceDeps = Object.keys(pkgJson.dependencies ?? {})
    .filter((dep: string) => dep.startsWith('@tabtin/'));

  it('package.json has @tabtin/* workspace dependencies', () => {
    expect(workspaceDeps.length).toBeGreaterThanOrEqual(8);
  });

  it('tsup.config.ts dynamically reads @tabtin/* from package.json', () => {
    expect(tsupConfigRaw).toContain('tabtinDeps');
    expect(tsupConfigRaw).toContain("d.startsWith('@tabtin/')");
    expect(tsupConfigRaw).toContain('noExternal: bundledTabtinDeps');
  });

  it('tsup.config.ts does NOT use a hardcoded list of 2 packages', () => {
    expect(tsupConfigRaw).not.toMatch(
      /noExternal:\s*\[\s*'@tabtin\/terminal-core'\s*,\s*'@tabtin\/ws-gateway-client'\s*\]/,
    );
  });

  it('all @tabtin/* deps start with @tabtin/', () => {
    for (const dep of workspaceDeps) {
      expect(dep.startsWith('@tabtin/')).toBe(true);
    }
  });

  it('build output does not contain external @tabtin/* imports', () => {
    const distPath = join(rootDir, 'dist', 'index.js');
    const distContent = readFileSync(distPath, 'utf-8');
    const externalImports = distContent.match(/from\s+["']@tabtin\/[^"']+["']/g) ?? [];
    expect(externalImports).toEqual([]);
  });
});

// ── I-1: /code/* route wiring ────────────────────────────────────

describe('I-1: /code/* routes dispatch to ActionExecutorAdapter', () => {
  let serverInfo: { socketPath: string; token: string } | null = null;

  beforeAll(async () => {
    const { startCLIServer } = await import('../src/transport/cli/cli-server.js');
    const socketPath = join(__dirname, '..', `.test-code-route-${process.pid}.sock`);
    serverInfo = startCLIServer({ version: '0.0.1-test', socketPath });
  });

  afterAll(async () => {
    const sockPath = serverInfo?.socketPath;
    const { stopCLIServer } = await import('../src/transport/cli/cli-server.js');
    await stopCLIServer();
    if (sockPath && existsSync(sockPath)) {
      try { unlinkSync(sockPath); } catch { /* ignore */ }
    }
  });

  function makeRequest(
    path: string,
    body?: Record<string, any>,
  ): Promise<{ status: number; data: any }> {
    return new Promise((resolve, reject) => {
      const bodyStr = body ? JSON.stringify(body) : undefined;
      const req = http.request(
        {
          socketPath: serverInfo!.socketPath,
          path,
          method: 'POST',
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

  it('GET /code/unknown returns 404 with UNKNOWN_ROUTE', async () => {
    const { status, data } = await makeRequest('/code/unknown');
    expect(status).toBe(404);
    expect(data.error?.code).toBe('UNKNOWN_ROUTE');
  });

  it('POST /code/read does NOT return 501', async () => {
    const { status, data } = await makeRequest('/code/read', {
      file_path: '/tmp/nonexistent-test-file-tabtin.txt',
    });
    expect(status).not.toBe(501);
    expect(data.error?.code).not.toBe('NOT_IMPLEMENTED');
  });

  it('POST /code/glob does NOT return 501', async () => {
    const { status, data } = await makeRequest('/code/glob', {
      pattern: '*.nonexistent-test-pattern-xyz',
    });
    expect(status).not.toBe(501);
    expect(data.error?.code).not.toBe('NOT_IMPLEMENTED');
  });

  it('POST /code/grep does NOT return 501', async () => {
    const { status, data } = await makeRequest('/code/grep', {
      pattern: 'nonexistent-test-pattern-xyz',
    });
    expect(status).not.toBe(501);
    expect(data.error?.code).not.toBe('NOT_IMPLEMENTED');
  });

  it('POST /code/write does NOT return 501', async () => {
    const { status, data } = await makeRequest('/code/write', {
      file_path: '/tmp/tabtin-test-write-' + Date.now() + '.txt',
      content: 'test',
    });
    expect(status).not.toBe(501);
    expect(data.error?.code).not.toBe('NOT_IMPLEMENTED');
  });

  it('POST /code/edit does NOT return 501', async () => {
    const { status, data } = await makeRequest('/code/edit', {
      file_path: '/tmp/nonexistent-test-file-tabtin.txt',
      old_string: 'a',
      new_string: 'b',
    });
    expect(status).not.toBe(501);
    expect(data.error?.code).not.toBe('NOT_IMPLEMENTED');
  });

  it('POST /code/git-status does NOT return 501', async () => {
    const { status, data } = await makeRequest('/code/git-status', {});
    expect(status).not.toBe(501);
    expect(data.error?.code).not.toBe('NOT_IMPLEMENTED');
  });

  it('POST /code/git-diff does NOT return 501', async () => {
    const { status, data } = await makeRequest('/code/git-diff', {});
    expect(status).not.toBe(501);
    expect(data.error?.code).not.toBe('NOT_IMPLEMENTED');
  });

  it('TOOL_MAP covers all required routes', async () => {
    const requiredRoutes = ['/read', '/write', '/edit', '/glob', '/grep', '/git-status', '/git-diff'];
    for (const route of requiredRoutes) {
      const { status, data } = await makeRequest(`/code${route}`, {});
      expect(status).not.toBe(501);
      expect(data.error?.code).not.toBe('NOT_IMPLEMENTED');
    }
  });
});
