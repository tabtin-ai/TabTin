import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpenAICodexLogin } from '../openai-codex-login.js';
import {
  REDIRECT_URI,
  type OpenAICodexOAuthCredential,
} from '../openai-codex-oauth.js';

const credential: OpenAICodexOAuthCredential = {
  type: 'oauth',
  access: 'access-token',
  refresh: 'refresh-token',
  expires: Date.now() + 60_000,
  accountId: 'acct_123',
};

describe('OpenAICodexLogin', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('浏览器回调 state 一致时兑换凭据并通过 store.modify 保存', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const exchangeAuthorizationCode = vi.fn().mockResolvedValue(credential);
    const fetchImpl = vi.fn();
    const modify = vi.fn(async (fn) => fn(null));
    const login = new OpenAICodexLogin({
      callbackPort: 0,
      openExternal,
      exchangeAuthorizationCode,
      fetchImpl,
      credentialStore: { modify },
      generatePKCE: () => ({
        verifier: 'verifier',
        challenge: 'challenge',
        state: 'expected-state',
      }),
      buildAuthorizeUrl: ({ state }) =>
        `https://auth.example.test/authorize?state=${state}`,
    });

    await login.startBrowserLogin();

    const callback = new URL(login.callbackUrl);
    const response = await fetch(
      `${callback}?code=authorization-code&state=expected-state`,
    );

    expect(response.status).toBe(200);
    await vi.waitFor(() =>
      expect(exchangeAuthorizationCode).toHaveBeenCalledWith({
        code: 'authorization-code',
        verifier: 'verifier',
        redirectUri: REDIRECT_URI,
        signal: expect.any(AbortSignal),
        fetchImpl,
      }),
    );
    expect(modify).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(
      'https://auth.example.test/authorize?state=expected-state',
    );
    login.cancelLogin();
  });

  it('浏览器回调 state 不匹配时拒绝兑换凭据', async () => {
    const exchangeAuthorizationCode = vi.fn();
    const login = new OpenAICodexLogin({
      callbackPort: 0,
      openExternal: vi.fn().mockResolvedValue(undefined),
      exchangeAuthorizationCode,
      credentialStore: { modify: vi.fn() },
      generatePKCE: () => ({
        verifier: 'verifier',
        challenge: 'challenge',
        state: 'expected-state',
      }),
      buildAuthorizeUrl: ({ state }) =>
        `https://auth.example.test/authorize?state=${state}`,
    });

    await login.startBrowserLogin();

    const response = await fetch(
      `${login.callbackUrl}?code=authorization-code&state=unexpected-state`,
    );

    expect(response.status).toBe(400);
    expect(exchangeAuthorizationCode).not.toHaveBeenCalled();
    login.cancelLogin();
  });

  it('设备码登录返回用户码，并在授权后经 store.modify 保存凭据', async () => {
    const modify = vi.fn(async (fn) => fn(null));
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            device_auth_id: 'device-auth-id',
            user_code: 'ABCD-EFGH',
            interval: 0,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(credential), { status: 200 }),
      );
    const login = new OpenAICodexLogin({
      fetchImpl,
      credentialStore: { modify },
      pollDelay: async () => {},
      openExternal: vi.fn().mockResolvedValue(undefined),
    });

    await expect(login.startDeviceCodeLogin()).resolves.toEqual({
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://auth.openai.com/codex/device',
    });
    await vi.waitFor(() => expect(modify).toHaveBeenCalledTimes(1));
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://auth.openai.com/api/accounts/deviceauth/token',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
