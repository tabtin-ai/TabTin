import { beforeEach, describe, expect, it, vi } from 'vitest';

const { info, netFetch, warn } = vi.hoisted(() => ({
  info: vi.fn(),
  netFetch: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('electron', () => ({
  net: { fetch: netFetch },
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info, warn }),
}));

import { openAICodexFetch } from '../openai-codex-http.js';

describe('OpenAI Codex HTTP transport', () => {
  beforeEach(() => {
    info.mockReset();
    netFetch.mockReset();
    warn.mockReset();
  });

  it('uses the Electron network stack so Codex requests inherit system proxy settings', async () => {
    const response = new Response(null, { status: 204 });
    netFetch.mockResolvedValue(response);

    await expect(
      openAICodexFetch('https://auth.openai.com/oauth/token', {
        method: 'POST',
      }),
    ).resolves.toBe(response);

    expect(netFetch).toHaveBeenCalledWith(
      'https://auth.openai.com/oauth/token',
      {
        method: 'POST',
      },
    );
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining(
        'HTTP request completed: /oauth/token status=204',
      ),
    );
  });
});
