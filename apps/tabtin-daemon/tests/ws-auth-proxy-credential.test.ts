import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const gatewayClientPath = path.resolve(__dirname, '../src/transport/gateway/gateway-client.ts');
const daemonPath = path.resolve(__dirname, '../src/bootstrap/daemon.ts');

describe('WS-C8-P1-1: onAuthFailed callback registration', () => {
  const gatewaySource = fs.readFileSync(gatewayClientPath, 'utf-8');

  it('should declare onFatalAuthError callback property', () => {
    expect(gatewaySource).toContain('onFatalAuthError: FatalExitHandler | null');
  });

  it('should register onAuthFailed in WsGatewayClient constructor', () => {
    expect(gatewaySource).toMatch(/onAuthFailed:\s*\(error\)\s*=>/);
  });

  it('should call onFatalAuthError inside onAuthFailed handler', () => {
    expect(gatewaySource).toMatch(/this\.onFatalAuthError\?\.\(\)/);
  });

  it('should mark offline state with ws_auth source on auth failure', () => {
    expect(gatewaySource).toMatch(/offlineState\.fail\(['"]ws_auth['"]/);
  });

  it('daemon.ts should wire gateway.onFatalAuthError to fatal exit', () => {
    const daemonSource = fs.readFileSync(daemonPath, 'utf-8');
    expect(daemonSource).toMatch(/this\.gateway\.onFatalAuthError\s*=\s*fatalAuthExit/);
  });

  it('should share the same fatalAuthExit function between heartbeat and gateway', () => {
    const daemonSource = fs.readFileSync(daemonPath, 'utf-8');
    expect(daemonSource).toMatch(/this\.heartbeat\.onFatalAuthError\s*=\s*fatalAuthExit/);
    expect(daemonSource).toMatch(/this\.gateway\.onFatalAuthError\s*=\s*fatalAuthExit/);
  });
});

describe('I-2: Django proxy credential auto-refresh', () => {
  const daemonSource = fs.readFileSync(daemonPath, 'utf-8');

  it('should import updateDjangoProxyCredential', () => {
    expect(daemonSource).toMatch(/import\s*\{[^}]*updateDjangoProxyCredential[^}]*\}/);
  });

  it('should call updateDjangoProxyCredential inside onReconnect callback', () => {
    const reconnectBlock = daemonSource.match(
      /this\.gateway\.onReconnect\(async\s*\(\)\s*=>\s*\{([\s\S]*?)\}\);/,
    );
    expect(reconnectBlock).not.toBeNull();
    const body = reconnectBlock![1];
    expect(body).toContain('updateDjangoProxyCredential');
  });

  it('should pass current token from gateway.getAccessToken()', () => {
    expect(daemonSource).toMatch(
      /const\s+currentToken\s*=\s*this\.gateway\.getAccessToken\(\)/,
    );
    expect(daemonSource).toMatch(
      /updateDjangoProxyCredential\(currentToken\)/,
    );
  });

  it('updateDjangoProxyCredential should exist in error-handler module', () => {
    const errorHandlerPath = path.resolve(
      __dirname,
      '../src/transport/cli/routes/shared/error-handler.ts',
    );
    const errorHandlerSource = fs.readFileSync(errorHandlerPath, 'utf-8');
    expect(errorHandlerSource).toMatch(
      /export\s+function\s+updateDjangoProxyCredential/,
    );
  });
});
