import { describe, expect, it } from 'vitest';
import { DjangoProxy } from '../src/transport/cli/routes/shared/error-handler.js';

describe('DjangoProxy', () => {
  it('isolates configuration between instances', async () => {
    const configured = new DjangoProxy();
    const unconfigured = new DjangoProxy();
    configured.configure({ serverUrl: 'http://127.0.0.1', credential: '', organizationId: 'org-1' });

    expect((await configured.request('GET', '/health')).status).toBe(401);
    expect((await unconfigured.request('GET', '/health')).status).toBe(503);
  });

  it('returns to an unconfigured state after dispose', async () => {
    const proxy = new DjangoProxy();
    proxy.configure({ serverUrl: 'http://127.0.0.1', credential: '', organizationId: 'org-1' });
    proxy.dispose();
    expect((await proxy.request('GET', '/health')).status).toBe(503);
  });
});
