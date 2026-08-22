/**
 * 域级熔断器
 * 三态机：CLOSED（正常）→ OPEN（熔断）→ HALF_OPEN（试探）
 * 按域名粒度管理，防止对故障域名持续发送请求
 */

import { loggers } from '../logger/CrawlLogger.js';

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  cooldownMs: number;
  halfOpenMaxProbes: number;
  maxDomains: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  cooldownMs: 30_000,
  halfOpenMaxProbes: 1,
  maxDomains: 1000,
};

interface DomainCircuit {
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureTime: number;
  halfOpenProbes: number;
}

export class CircuitBreaker {
  private circuits = new Map<string, DomainCircuit>();
  private config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 检查域名是否允许请求。
   * 如果熔断器处于 OPEN 状态且冷却期未过，抛出错误。
   * 冷却期过后自动切换到 HALF_OPEN 并放行试探请求。
   */
  checkAllowed(domain: string): void {
    const circuit = this.circuits.get(domain);
    if (!circuit) return;

    if (circuit.state === CircuitState.CLOSED) return;

    if (circuit.state === CircuitState.OPEN) {
      const elapsed = Date.now() - circuit.lastFailureTime;
      if (elapsed >= this.config.cooldownMs) {
        circuit.state = CircuitState.HALF_OPEN;
        circuit.halfOpenProbes = 0;
        loggers.core.info('Circuit breaker HALF_OPEN', { domain });
      } else {
        throw new CircuitBreakerOpenError(domain, this.config.cooldownMs - elapsed);
      }
    }

    if (circuit.state === CircuitState.HALF_OPEN) {
      if (circuit.halfOpenProbes >= this.config.halfOpenMaxProbes) {
        throw new CircuitBreakerOpenError(domain, 0);
      }
      circuit.halfOpenProbes++;
    }
  }

  /**
   * 记录请求成功，重置域名的熔断状态
   */
  recordSuccess(domain: string): void {
    const circuit = this.circuits.get(domain);
    if (!circuit) return;

    if (circuit.state === CircuitState.HALF_OPEN) {
      loggers.core.info('Circuit breaker CLOSED (probe succeeded)', { domain });
    }

    circuit.state = CircuitState.CLOSED;
    circuit.consecutiveFailures = 0;
    circuit.halfOpenProbes = 0;
  }

  /**
   * 记录请求失败。连续失败达到阈值时触发熔断。
   */
  recordFailure(domain: string): void {
    let circuit = this.circuits.get(domain);
    if (!circuit) {
      circuit = {
        state: CircuitState.CLOSED,
        consecutiveFailures: 0,
        lastFailureTime: 0,
        halfOpenProbes: 0,
      };
      this.circuits.set(domain, circuit);
      this.evictIfNeeded();
    }

    circuit.consecutiveFailures++;
    circuit.lastFailureTime = Date.now();

    if (circuit.state === CircuitState.HALF_OPEN) {
      circuit.state = CircuitState.OPEN;
      loggers.core.warn('Circuit breaker OPEN (probe failed)', {
        domain,
        failures: circuit.consecutiveFailures,
      });
      return;
    }

    if (circuit.consecutiveFailures >= this.config.failureThreshold) {
      circuit.state = CircuitState.OPEN;
      loggers.core.warn('Circuit breaker OPEN', {
        domain,
        failures: circuit.consecutiveFailures,
        cooldownMs: this.config.cooldownMs,
      });
    }
  }

  /**
   * 获取域名的熔断状态（调试 / 监控用）
   */
  getState(domain: string): CircuitState {
    return this.circuits.get(domain)?.state ?? CircuitState.CLOSED;
  }

  /**
   * 重置指定域名的熔断器
   */
  reset(domain: string): void {
    this.circuits.delete(domain);
  }

  /**
   * 重置所有域名的熔断器
   */
  resetAll(): void {
    this.circuits.clear();
  }

  get size(): number {
    return this.circuits.size;
  }

  private evictIfNeeded(): void {
    if (this.circuits.size <= this.config.maxDomains) return;

    for (const [key, circuit] of this.circuits) {
      if (circuit.state === CircuitState.CLOSED) {
        this.circuits.delete(key);
        if (this.circuits.size <= this.config.maxDomains) return;
      }
    }
  }
}

export class CircuitBreakerOpenError extends Error {
  public readonly domain: string;
  public readonly retryAfterMs: number;

  constructor(domain: string, retryAfterMs: number) {
    super(`Circuit breaker OPEN for domain "${domain}", retry after ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = 'CircuitBreakerOpenError';
    this.domain = domain;
    this.retryAfterMs = retryAfterMs;
  }
}
