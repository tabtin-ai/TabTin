import http from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { DaemonCliServer } from '../src/transport/cli/cli-server.js';

function getHealth(socketPath: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: '/health', method: 'GET' }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
    });
    request.on('error', reject);
    request.end();
  });
}

describe('DaemonCliServer', () => {
  it('enforces one process-wide route runtime and supports sequential owners', async () => {
    const first = new DaemonCliServer();
    const second = new DaemonCliServer();
    const suffix = `${process.pid}-${Date.now()}`;
    const firstSocket = join(tmpdir(), `tabtin-cli-first-${suffix}.sock`);
    const secondSocket = join(tmpdir(), `tabtin-cli-second-${suffix}.sock`);

    try {
      first.start({ socketPath: firstSocket, version: '1.0.0', spaceId: 'space-a', publishDiscovery: false });
      expect(await getHealth(firstSocket)).toMatchObject({ data: { version: '1.0.0', spaceId: 'space-a' } });
      expect(() => second.start({ socketPath: secondSocket, version: '2.0.0', spaceId: 'space-b', publishDiscovery: false }))
        .toThrow('already active');
      await first.stop();
      second.start({ socketPath: secondSocket, version: '2.0.0', spaceId: 'space-b', publishDiscovery: false });
      expect(await getHealth(secondSocket)).toMatchObject({ data: { version: '2.0.0', spaceId: 'space-b' } });
    } finally {
      await Promise.all([first.stop(), second.stop()]);
    }
  });
});
