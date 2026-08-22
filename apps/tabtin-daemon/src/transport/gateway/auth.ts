import type { ConfigManager } from '../../platform/system/config/config-manager.js';
import type { DaemonConfig, InstallToken, DeviceCredential } from '../../base/types/daemon-config.js';
import { CapabilityDetector } from '../../platform/system/capability/detector.js';

export class TokenAuth {
  private readonly configManager: ConfigManager;
  private readonly capabilityDetector = new CapabilityDetector();

  constructor(configManager: ConfigManager) {
    this.configManager = configManager;
  }

  async activateToken(rawToken: string, serverOverride?: string): Promise<DaemonConfig> {
    const tokenData = this.decodeToken(rawToken);
    const serverUrl = serverOverride ?? tokenData.server_url;

    const fingerprint = this.configManager.getOrCreateFingerprint();
    const capabilities = await this.capabilityDetector.detect();
    const credential = await this.registerDevice(serverUrl, rawToken, fingerprint, tokenData, capabilities);

    const config = this.configManager.initFromToken(
      {
        server_url: serverUrl,
        ws_url: tokenData.ws_url,
        organization_id: tokenData.organization_id,
        // LH2-D3：把 install token 里的 user_id 持久化到 DaemonConfig，
        // 后续 DaemonAgentHost.resolveOwner 用此值构造 SyncQueue.owner。
        user_id: tokenData.user_id,
        device_name: tokenData.device_name,
      },
      {
        device_id: credential.device_id,
        access_token: credential.access_token,
      },
    );

    return config;
  }

  /**
   * Decode and structurally validate the install token (DE-05).
   *
   * Enforces: 3-part JWT format, header alg/typ, signature presence,
   * required payload fields, expiry, and URL scheme safety (HTTPS/WSS).
   * Full HMAC-SHA256 signature verification is performed server-side during registration.
   */
  private decodeToken(rawToken: string): InstallToken {
    const parts = rawToken.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid token format: expected header.payload.signature (3 parts)');
    }

    const [headerB64, payloadB64, signatureB64] = parts;

    let header: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf-8'));
    } catch {
      throw new Error('Invalid token: malformed header');
    }
    if (header.alg !== 'HS256' || header.typ !== 'DIT') {
      throw new Error(
        `Invalid token header: expected alg=HS256 typ=DIT, got alg=${String(header.alg)} typ=${String(header.typ)}`,
      );
    }

    // HMAC-SHA256 = 32 bytes → ≥43 base64url chars
    if (!signatureB64 || signatureB64.length < 40) {
      throw new Error('Invalid token: signature missing or truncated');
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));
    } catch {
      throw new Error('Invalid token: malformed payload');
    }

    const requiredFields = ['organization_id', 'user_id', 'server_url', 'ws_url', 'scope', 'device_name'] as const;
    for (const f of requiredFields) {
      if (!payload[f]) {
        throw new Error(`Invalid token: missing required field '${f}'`);
      }
    }

    if (payload.scope !== 'device_register') {
      throw new Error(`Invalid token scope: expected 'device_register', got '${String(payload.scope)}'`);
    }

    if (payload.expires_at) {
      const exp = new Date(payload.expires_at as string);
      if (Number.isNaN(exp.getTime()) || exp.getTime() < Date.now()) {
        throw new Error('Install token has expired');
      }
    }

    TokenAuth.validateHttpUrl(payload.server_url as string, 'server_url');
    TokenAuth.validateWsUrl(payload.ws_url as string, 'ws_url');

    return payload as unknown as InstallToken;
  }

  // ---- URL validators (DE-05) ----

  private static isLocalhost(hostname: string): boolean {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  }

  private static validateHttpUrl(url: string, label: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid ${label}: ${url}`);
    }
    if (!TokenAuth.isLocalhost(parsed.hostname) && parsed.protocol !== 'https:') {
      throw new Error(`${label} must use HTTPS for non-localhost hosts: ${url}`);
    }
  }

  private static validateWsUrl(url: string, label: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid ${label}: ${url}`);
    }
    if (!TokenAuth.isLocalhost(parsed.hostname) && parsed.protocol !== 'wss:') {
      throw new Error(`${label} must use WSS for non-localhost hosts: ${url}`);
    }
  }

  private async registerDevice(
    serverUrl: string,
    token: string,
    fingerprint: string,
    tokenData: InstallToken,
    capabilities: string[],
  ): Promise<DeviceCredential> {
    const os = await import('node:os');
    const url = `${serverUrl}/api/context/devices/activate`;
    const body = {
      token,
      fingerprint,
      device_type: 'daemon',
      device_name: tokenData.device_name,
      os_info: {
        os: process.platform,
        arch: process.arch,
        hostname: os.hostname(),
        release: os.release(),
        node_version: process.version,
      },
      capabilities,
    };

    const MAX_RETRIES = 3;
    const INITIAL_DELAY_MS = 1000;

    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const text = await response.text();
          const err = new Error(`Device registration failed (${response.status}): ${text}`);
          if (response.status >= 400 && response.status < 500) {
            throw err;
          }
          lastError = err;
          if (attempt < MAX_RETRIES) {
            await new Promise(r => setTimeout(r, INITIAL_DELAY_MS * Math.pow(2, attempt - 1)));
            continue;
          }
          throw lastError;
        }

        const json = await response.json() as { success?: boolean; data?: DeviceCredential; message?: string };
        if (!json.success || !json.data) {
          throw new Error(`Device activation failed: ${json.message ?? 'unknown error'}`);
        }
        return json.data;
      } catch (err) {
        if (err instanceof TypeError) {
          lastError = err;
          if (attempt < MAX_RETRIES) {
            await new Promise(r => setTimeout(r, INITIAL_DELAY_MS * Math.pow(2, attempt - 1)));
            continue;
          }
        }
        throw err;
      }
    }

    throw lastError ?? new Error('Device registration failed after retries');
  }
}
