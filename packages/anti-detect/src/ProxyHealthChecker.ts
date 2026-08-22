import type { ProxyConfig } from '@tabtin/crawl-integration';
import { Socket } from 'net';
import http from 'http';

export type ProxyHealth = 'healthy' | 'degraded' | 'unhealthy';

export interface ProxyHealthResult {
  healthy: boolean;
  /** 细分健康等级：healthy = TCP+HTTP 均通过, degraded = TCP 通但 HTTP 失败, unhealthy = TCP 不通 */
  health: ProxyHealth;
  latencyMs?: number;
  error?: string;
  /** HTTP 连通性测试诊断信息（仅 degraded 时填充） */
  httpDiagnostics?: string;
}

const HTTP_CHECK_URL = 'http://connectivitycheck.gstatic.com/generate_204';
const HTTP_CHECK_EXPECTED_STATUS = 204;

/**
 * 代理健康检查
 *
 * 两阶段检测：
 * 1. TCP 握手 — 验证代理端口可达
 * 2. HTTP 请求 — 通过代理访问轻量 URL，验证实际转发能力
 */
export class ProxyHealthChecker {
  async check(proxy: ProxyConfig, timeoutMs = 3000): Promise<ProxyHealthResult> {
    const host = (proxy as any)?.host || (proxy as any)?.server;
    const port = (proxy as any)?.port || proxy.port || (proxy.protocol === 'https' ? 443 : 80);
    if (!host || !port) {
      return { healthy: false, health: 'unhealthy', error: 'MISSING_HOST_OR_PORT' };
    }

    const start = Date.now();

    // 阶段 1：TCP 握手
    const tcpResult = await this.tcpCheck(host, port, timeoutMs);
    if (!tcpResult.ok) {
      return {
        healthy: false,
        health: 'unhealthy',
        latencyMs: Date.now() - start,
        error: tcpResult.error,
      };
    }

    const tcpLatency = Date.now() - start;
    const remainingTimeout = Math.max(timeoutMs - tcpLatency, 1000);

    // 阶段 2：HTTP 连通性测试（通过代理发送 HTTP 请求）
    const httpResult = await this.httpCheck(host, port, proxy, remainingTimeout);
    const totalLatency = Date.now() - start;

    if (!httpResult.ok) {
      return {
        healthy: false,
        health: 'degraded',
        latencyMs: totalLatency,
        httpDiagnostics: httpResult.diagnostics,
      };
    }

    return {
      healthy: true,
      health: 'healthy',
      latencyMs: totalLatency,
    };
  }

  private tcpCheck(
    host: string,
    port: number,
    timeoutMs: number
  ): Promise<{ ok: boolean; error?: string }> {
    return new Promise(resolve => {
      const socket = new Socket();

      const cleanup = (result: { ok: boolean; error?: string }) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(result);
      };

      socket.setTimeout(timeoutMs, () => {
        cleanup({ ok: false, error: 'TCP_TIMEOUT' });
      });

      socket.once('error', err => {
        cleanup({ ok: false, error: err.message });
      });

      socket.connect(port, host, () => {
        cleanup({ ok: true });
      });
    });
  }

  private httpCheck(
    proxyHost: string,
    proxyPort: number,
    proxy: ProxyConfig,
    timeoutMs: number
  ): Promise<{ ok: boolean; diagnostics?: string }> {
    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        req.destroy();
        resolve({ ok: false, diagnostics: 'HTTP_CHECK_TIMEOUT' });
      }, timeoutMs);

      const targetUrl = new URL(HTTP_CHECK_URL);

      const headers: Record<string, string> = {
        Host: targetUrl.host,
      };

      if (proxy.username && proxy.password) {
        const credentials = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
        headers['Proxy-Authorization'] = `Basic ${credentials}`;
      }

      const req = http.request(
        {
          host: proxyHost,
          port: proxyPort,
          method: 'GET',
          path: HTTP_CHECK_URL,
          headers,
          timeout: timeoutMs,
        },
        res => {
          clearTimeout(timeout);
          res.resume();
          if (res.statusCode === HTTP_CHECK_EXPECTED_STATUS) {
            resolve({ ok: true });
          } else {
            resolve({
              ok: false,
              diagnostics: `HTTP_STATUS_MISMATCH: expected ${HTTP_CHECK_EXPECTED_STATUS}, got ${res.statusCode}`,
            });
          }
        }
      );

      req.on('error', err => {
        clearTimeout(timeout);
        resolve({ ok: false, diagnostics: `HTTP_REQUEST_ERROR: ${err.message}` });
      });

      req.end();
    });
  }
}
