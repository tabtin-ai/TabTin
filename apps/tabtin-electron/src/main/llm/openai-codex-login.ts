import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { shell } from 'electron';

import { createLogger } from '../logger.js';
import {
  OpenAICodexCredentialStore,
  sharedOpenAICodexCredentialStore,
} from './openai-codex-credential-store.js';
import {
  openAICodexFetch,
  type OpenAICodexFetch,
} from './openai-codex-http.js';
import {
  AUTH_BASE,
  CLIENT_ID,
  REDIRECT_URI,
  SCOPE,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  extractChatgptAccountId,
  generatePKCE,
  type OpenAICodexOAuthCredential,
} from './openai-codex-oauth.js';
import { notifyOpenAICodexStatusChanged } from './openai-codex-status-events.js';

const log = createLogger('OpenAICodex');

export const DEVICE_USER_CODE_URL = `${AUTH_BASE}/api/accounts/deviceauth/usercode`;
export const DEVICE_TOKEN_URL = `${AUTH_BASE}/api/accounts/deviceauth/token`;
export const DEVICE_VERIFICATION_URI = `${AUTH_BASE}/codex/device`;
export const DEVICE_REDIRECT_URI = `${AUTH_BASE}/deviceauth/callback`;

type Pkce = ReturnType<typeof generatePKCE>;

type OpenAICodexLoginDependencies = {
  callbackHost?: string;
  callbackPort?: number;
  createServer?: typeof createServer;
  openExternal?: (url: string) => Promise<void>;
  exchangeAuthorizationCode?: typeof exchangeAuthorizationCode;
  buildAuthorizeUrl?: typeof buildAuthorizeUrl;
  generatePKCE?: () => Pkce;
  fetchImpl?: OpenAICodexFetch;
  credentialStore?: Pick<OpenAICodexCredentialStore, 'modify'>;
  pollDelay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

export type DeviceCodeLoginStart = {
  userCode: string;
  verificationUri: string;
};

type DeviceCodeStartResponse = {
  device_auth_id?: unknown;
  user_code?: unknown;
  interval?: unknown;
};

/**
 * 主进程 OAuth 登录编排。IPC 的 login-browser 与 login-device-code 都只在
 * 登录已成功启动时返回；完成后的凭据写入在后台进行，renderer 通过 get-status
 * 刷新状态。这样无需把敏感 token 或内部轮询状态暴露到 renderer。
 */
export class OpenAICodexLogin {
  private readonly callbackHost: string;
  private readonly callbackPort: number;
  private readonly createHttpServer: typeof createServer;
  private readonly openExternal: (url: string) => Promise<void>;
  private readonly exchangeAuthorizationCode: typeof exchangeAuthorizationCode;
  private readonly buildAuthorizeUrl: typeof buildAuthorizeUrl;
  private readonly generatePKCE: () => Pkce;
  private readonly fetchImpl: OpenAICodexFetch;
  private readonly credentialStore: Pick<OpenAICodexCredentialStore, 'modify'>;
  private readonly pollDelay: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;
  private activeAbortController: AbortController | null = null;
  private callbackServer: Server | null = null;
  private activeCallbackUrl: string = REDIRECT_URI;

  constructor(dependencies: OpenAICodexLoginDependencies = {}) {
    this.callbackHost = dependencies.callbackHost ?? '127.0.0.1';
    this.callbackPort = dependencies.callbackPort ?? 1455;
    this.createHttpServer = dependencies.createServer ?? createServer;
    this.openExternal = dependencies.openExternal ?? shell.openExternal;
    this.exchangeAuthorizationCode =
      dependencies.exchangeAuthorizationCode ?? exchangeAuthorizationCode;
    this.buildAuthorizeUrl =
      dependencies.buildAuthorizeUrl ?? buildAuthorizeUrl;
    this.generatePKCE = dependencies.generatePKCE ?? generatePKCE;
    this.fetchImpl = dependencies.fetchImpl ?? openAICodexFetch;
    this.credentialStore =
      dependencies.credentialStore ?? sharedOpenAICodexCredentialStore;
    this.pollDelay = dependencies.pollDelay ?? delay;
  }

  get callbackUrl(): string {
    return this.activeCallbackUrl;
  }

  async startBrowserLogin(): Promise<void> {
    this.cancelLogin();
    const controller = new AbortController();
    const pkce = this.generatePKCE();
    this.activeAbortController = controller;

    const server = this.createHttpServer((request, response) => {
      void this.handleBrowserCallback(request, response, pkce, controller);
    });
    this.callbackServer = server;

    try {
      await listen(server, this.callbackPort, this.callbackHost);
      this.activeCallbackUrl = resolveCallbackUrl(server, this.callbackHost);
      await this.openExternal(
        this.buildAuthorizeUrl({
          challenge: pkce.challenge,
          state: pkce.state,
        }),
      );
    } catch (error) {
      this.cancelLogin();
      throw error;
    }
  }

  async startDeviceCodeLogin(): Promise<DeviceCodeLoginStart> {
    this.cancelLogin();
    const controller = new AbortController();
    this.activeAbortController = controller;

    try {
      const response = await this.fetchImpl(DEVICE_USER_CODE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          scope: SCOPE,
          redirect_uri: DEVICE_REDIRECT_URI,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          `OpenAI Codex device code start failed (${response.status})`,
        );
      }
      const payload = (await response.json()) as DeviceCodeStartResponse;
      if (
        typeof payload.device_auth_id !== 'string' ||
        typeof payload.user_code !== 'string'
      ) {
        throw new Error(
          'OpenAI Codex device code response is missing required fields',
        );
      }

      const intervalMilliseconds =
        typeof payload.interval === 'number' && payload.interval >= 0
          ? payload.interval * 1_000
          : 5_000;
      void this.pollDeviceCode(
        payload.device_auth_id,
        intervalMilliseconds,
        controller,
      ).catch((error) => {
        if (!controller.signal.aborted) {
          log.warn(
            'Device code login did not complete:',
            error instanceof Error ? error.message : String(error),
          );
        }
      });
      return {
        userCode: payload.user_code,
        verificationUri: DEVICE_VERIFICATION_URI,
      };
    } catch (error) {
      if (this.activeAbortController === controller) this.cancelLogin();
      throw error;
    }
  }

  cancelLogin(): void {
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    this.closeCallbackServer();
  }

  private async handleBrowserCallback(
    request: IncomingMessage,
    response: ServerResponse,
    pkce: Pkce,
    controller: AbortController,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', this.activeCallbackUrl);
    if (url.pathname !== '/auth/callback') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || state !== pkce.state) {
      response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(loginResultPage(false));
      this.finishLogin(controller);
      return;
    }

    try {
      const credential = await this.exchangeAuthorizationCode({
        code,
        verifier: pkce.verifier,
        // 授权 URL 与 token exchange 必须使用同一个 registered redirect URI。
        // callbackUrl 仅记录测试时动态端口及实际监听位置，不能代替 OAuth 参数。
        redirectUri: REDIRECT_URI,
        signal: controller.signal,
        fetchImpl: this.fetchImpl,
      });
      if (!controller.signal.aborted) {
        await this.credentialStore.modify(() => credential);
        await notifyOpenAICodexStatusChanged('connected');
      }
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(loginResultPage(true));
    } catch (error) {
      if (!controller.signal.aborted) {
        log.warn(
          'Browser login token exchange failed:',
          error instanceof Error ? error.message : String(error),
        );
      }
      response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(loginResultPage(false));
    } finally {
      this.finishLogin(controller);
    }
  }

  private async pollDeviceCode(
    deviceAuthId: string,
    intervalMilliseconds: number,
    controller: AbortController,
  ): Promise<void> {
    while (!controller.signal.aborted) {
      const response = await this.fetchImpl(DEVICE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_auth_id: deviceAuthId }),
        signal: controller.signal,
      });
      if (response.ok) {
        const credential = await parseDeviceCredential(response);
        if (!controller.signal.aborted) {
          await this.credentialStore.modify(() => credential);
          await notifyOpenAICodexStatusChanged('connected');
        }
        this.finishLogin(controller);
        return;
      }

      const errorCode = await readErrorCode(response);
      if (errorCode !== 'authorization_pending' && errorCode !== 'slow_down') {
        throw new Error(
          `OpenAI Codex device code token failed (${response.status})`,
        );
      }
      await this.pollDelay(
        errorCode === 'slow_down'
          ? intervalMilliseconds + 5_000
          : intervalMilliseconds,
        controller.signal,
      );
    }
  }

  private finishLogin(controller: AbortController): void {
    if (this.activeAbortController !== controller) return;
    this.activeAbortController = null;
    this.closeCallbackServer();
  }

  private closeCallbackServer(): void {
    const server = this.callbackServer;
    this.callbackServer = null;
    if (server) server.close();
  }
}

async function parseDeviceCredential(
  response: Response,
): Promise<OpenAICodexOAuthCredential> {
  const payload = (await response.json()) as Record<string, unknown>;
  if (
    payload.type === 'oauth' &&
    typeof payload.access === 'string' &&
    typeof payload.refresh === 'string' &&
    typeof payload.expires === 'number' &&
    typeof payload.accountId === 'string'
  ) {
    return payload as OpenAICodexOAuthCredential;
  }
  if (
    typeof payload.access_token !== 'string' ||
    typeof payload.refresh_token !== 'string' ||
    typeof payload.expires_in !== 'number'
  ) {
    throw new Error(
      'OpenAI Codex device code token response is missing required fields',
    );
  }
  const accountId = extractChatgptAccountId(payload.access_token);
  if (!accountId)
    throw new Error(
      'Failed to extract ChatGPT account ID from device code token',
    );
  return {
    type: 'oauth',
    access: payload.access_token,
    refresh: payload.refresh_token,
    expires: Date.now() + payload.expires_in * 1_000,
    accountId,
  };
}

async function readErrorCode(response: Response): Promise<string | null> {
  try {
    const payload = (await response.json()) as { error?: unknown };
    return typeof payload.error === 'string' ? payload.error : null;
  } catch {
    return null;
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function resolveCallbackUrl(server: Server, host: string): string {
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('OpenAI Codex callback server address unavailable');
  return `http://${host}:${address.port}/auth/callback`;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

function loginResultPage(success: boolean): string {
  const message = success
    ? 'ChatGPT Codex 登录已完成，您可以返回 TabTin。'
    : '登录校验失败，请返回 TabTin 后重试。';
  return `<!doctype html><html><body><p>${message}</p></body></html>`;
}
