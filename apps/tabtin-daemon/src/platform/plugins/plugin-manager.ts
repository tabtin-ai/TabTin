import type { DaemonPlugin } from './types.js';
import type { Logger } from '../observability/logging/logger.js';

export class PluginManager {
  private readonly logger: Logger;
  private readonly plugins = new Map<string, DaemonPlugin>();
  private onPluginLoaded?: (plugin: DaemonPlugin) => void;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  setOnPluginLoaded(callback: (plugin: DaemonPlugin) => void): void {
    this.onPluginLoaded = callback;
  }

  async loadConfiguredPlugins(pluginNames: string[]): Promise<void> {
    for (const name of pluginNames) {
      await this.loadPlugin(name);
    }
  }

  async loadPlugin(name: string): Promise<void> {
    if (this.plugins.has(name)) {
      this.logger.warn(`Plugin '${name}' already loaded`);
      return;
    }

    try {
      const moduleName = `@tabtin/daemon-plugin-${name}`;
      const mod = await import(moduleName);
      const PluginClass = mod.default ?? mod[Object.keys(mod)[0]];
      if (!PluginClass) {
        throw new Error(`No default export found in ${moduleName}`);
      }

      const plugin: DaemonPlugin = new PluginClass();
      await plugin.initialize();
      this.plugins.set(name, plugin);
      this.onPluginLoaded?.(plugin);
      this.logger.info(`Plugin loaded: ${name} v${plugin.version} (capabilities: ${plugin.getCapabilities().join(', ')})`);
    } catch (err) {
      this.logger.error(`Failed to load plugin '${name}'`, err instanceof Error ? err.message : err);
    }
  }

  async unloadPlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) return;
    await plugin.destroy();
    this.plugins.delete(name);
    this.logger.info(`Plugin unloaded: ${name}`);
  }

  getPlugins(): DaemonPlugin[] {
    return [...this.plugins.values()];
  }

  getAdditionalCapabilities(): string[] {
    const caps: string[] = [];
    for (const plugin of this.plugins.values()) {
      caps.push(...plugin.getCapabilities());
    }
    return caps;
  }

  async destroyAll(): Promise<void> {
    for (const [name, plugin] of this.plugins) {
      try {
        await plugin.destroy();
      } catch (err) {
        this.logger.warn(`Error destroying plugin '${name}'`, err);
      }
    }
    this.plugins.clear();
  }
}
