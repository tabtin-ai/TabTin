import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const heartbeatPath = path.resolve(__dirname, '../src/transport/gateway/heartbeat.ts');
const gatewayClientPath = path.resolve(__dirname, '../src/transport/gateway/gateway-client.ts');
const daemonPath = path.resolve(__dirname, '../src/bootstrap/daemon.ts');

const heartbeatSource = fs.readFileSync(heartbeatPath, 'utf-8');
const gatewaySource = fs.readFileSync(gatewayClientPath, 'utf-8');
const daemonSource = fs.readFileSync(daemonPath, 'utf-8');

describe('CD-007: Heartbeat uses gateway dynamic token instead of static config.credential', () => {
  it('should NOT use this.config.credential in Authorization header', () => {
    const authHeaderMatch = heartbeatSource.match(
      /['"]Authorization['"]\s*:\s*`Bearer \$\{([^}]+)\}`/,
    );
    expect(authHeaderMatch).not.toBeNull();
    expect(authHeaderMatch![1]).not.toContain('this.config.credential');
  });

  it('should use this.gateway.getAccessToken() in Authorization header', () => {
    expect(heartbeatSource).toMatch(
      /['"]Authorization['"]\s*:\s*`Bearer \$\{this\.gateway\.getAccessToken\(\)\}`/,
    );
  });
});

describe('CD-006: Gateway supports dynamic token updates', () => {
  it('should have currentAccessToken as a mutable field', () => {
    expect(gatewaySource).toMatch(/private\s+currentAccessToken:\s*string/);
  });

  it('should initialize currentAccessToken from config.credential', () => {
    expect(gatewaySource).toMatch(/this\.currentAccessToken\s*=\s*config\.credential/);
  });

  it('should expose updateAccessToken() method', () => {
    expect(gatewaySource).toMatch(/updateAccessToken\(token:\s*string\):\s*void/);
  });

  it('getAccessToken() should return currentAccessToken, not config.credential', () => {
    const getterMatch = gatewaySource.match(
      /getAccessToken\(\):\s*string\s*\{[\s\S]*?return\s+(this\.\w+)/,
    );
    expect(getterMatch).not.toBeNull();
    expect(getterMatch![1]).toBe('this.currentAccessToken');
  });

  it('should use currentAccessToken for WS requests, not config.credential', () => {
    const wsRequestMatches = gatewaySource.match(/token:\s*this\.\w+/g) ?? [];
    for (const match of wsRequestMatches) {
      expect(match).not.toContain('this.config.credential');
    }
  });
});

describe('CD-005: Automatic token renewal', () => {
  it('heartbeat should declare onTokenRenewed callback', () => {
    expect(heartbeatSource).toMatch(/onTokenRenewed:\s*\(\(newToken:\s*string\)\s*=>\s*void\)\s*\|\s*null/);
  });

  it('heartbeat should have attemptTokenRenewal method', () => {
    expect(heartbeatSource).toMatch(/async\s+attemptTokenRenewal\(\)/);
  });

  it('heartbeat should have renewToken method that calls TOKEN_RENEW endpoint', () => {
    expect(heartbeatSource).toMatch(/private\s+async\s+renewToken\(\s*signal\?:\s*AbortSignal\s*\)/);
    expect(heartbeatSource).toContain('API_ENDPOINTS.DEVICE.TOKEN_RENEW');
  });

  it('heartbeat should trigger renewal when token_expires_in_seconds < 6 hours', () => {
    expect(heartbeatSource).toMatch(/sixHours\s*=\s*6\s*\*\s*3600/);
    expect(heartbeatSource).toMatch(/expiresIn\s*<\s*sixHours/);
    expect(heartbeatSource).toMatch(/startBackgroundTokenRenewal\(['"]soon['"]\)/);
  });

  it('heartbeat should trigger renewal when token is already expired', () => {
    expect(heartbeatSource).toMatch(/expiresIn\s*<=\s*0/);
  });

  it('heartbeat should guard against concurrent renewal attempts', () => {
    expect(heartbeatSource).toMatch(/renewController/);
  });

  it('daemon.ts should wire onTokenRenewed to update all credential consumers', () => {
    expect(daemonSource).toMatch(/this\.heartbeat\.onTokenRenewed\s*=/);
    expect(daemonSource).toMatch(/this\.gateway\.updateAccessToken\(newToken\)/);
    expect(daemonSource).toMatch(/this\.configManager\.save\(this\.config\)/);
    expect(daemonSource).toMatch(/updateDjangoProxyCredential\(newToken\)/);
  });

  it('renewal response should read access_token from data', () => {
    expect(heartbeatSource).toMatch(/json\?\.data\?\.access_token/);
  });
});
