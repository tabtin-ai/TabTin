import type {
  BackendCapabilities,
  BackendConfig,
  BackendFactory,
  BackendResolveConfig,
  ExecutionBackend,
  PlatformType,
} from './types';

interface RegistryEntry {
  factory: BackendFactory;
  capabilities: BackendCapabilities;
  instance?: ExecutionBackend;
}

/**
 * 可插拔执行后端注册表。
 *
 * 各平台层（Electron、Daemon、Cloud）在启动时注册自己的 BackendFactory，
 * 调用方通过 resolve() 按能力要求获取匹配的后端实例。
 */
export class ExecutionBackendRegistry {
  private backends = new Map<string, RegistryEntry>();

  register(id: string, factory: BackendFactory, capabilities: BackendCapabilities): void {
    if (this.backends.has(id)) {
      throw new Error(`Backend "${id}" is already registered`);
    }
    this.backends.set(id, { factory, capabilities });
  }

  /**
   * 按能力要求解析最佳后端。
   *
   * 匹配逻辑：
   * 1. requireSandbox=true → 仅返回 supportsSandbox 的后端
   * 2. requireNetworkIsolation=true → 仅返回 supportsNetworkIsolation 的后端
   * 3. platform → 仅返回声明支持该平台的后端
   * 4. preferInteractive=true → 在满足上述条件的候选中优先返回 supportsInteractive 的后端
   * 5. 多个候选时，local 优先于 remote
   */
  async resolve(config: BackendResolveConfig = {}): Promise<ExecutionBackend | null> {
    const candidates: RegistryEntry[] = [];

    for (const entry of this.backends.values()) {
      const cap = entry.capabilities;

      if (config.requireSandbox && !cap.supportsSandbox) continue;
      if (config.requireNetworkIsolation && !cap.supportsNetworkIsolation) continue;
      if (config.platform && !cap.platforms.includes(config.platform)) continue;

      candidates.push(entry);
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      if (config.preferInteractive) {
        const ai = a.capabilities.supportsInteractive ? 1 : 0;
        const bi = b.capabilities.supportsInteractive ? 1 : 0;
        if (ai !== bi) return bi - ai;
      }

      const la = a.capabilities.latencyClass === 'local' ? 1 : 0;
      const lb = b.capabilities.latencyClass === 'local' ? 1 : 0;
      return lb - la;
    });

    const best = candidates[0];
    return this._getInstance(best);
  }

  async get(id: string): Promise<ExecutionBackend | null> {
    const entry = this.backends.get(id);
    if (!entry) return null;
    return this._getInstance(entry);
  }

  list(): Array<{ id: string; capabilities: BackendCapabilities }> {
    const result: Array<{ id: string; capabilities: BackendCapabilities }> = [];
    for (const [id, entry] of this.backends) {
      result.push({ id, capabilities: entry.capabilities });
    }
    return result;
  }

  async unregister(id: string): Promise<boolean> {
    const entry = this.backends.get(id);
    if (!entry) return false;
    if (entry.instance) {
      await entry.instance.cleanup();
    }
    this.backends.delete(id);
    return true;
  }

  /**
   * 清理所有已实例化的后端并清空注册表。
   */
  async dispose(): Promise<void> {
    for (const entry of this.backends.values()) {
      if (entry.instance) {
        await entry.instance.cleanup();
      }
    }
    this.backends.clear();
  }

  private async _getInstance(entry: RegistryEntry): Promise<ExecutionBackend> {
    if (!entry.instance) {
      entry.instance = await entry.factory.create({});
    }
    return entry.instance;
  }
}
