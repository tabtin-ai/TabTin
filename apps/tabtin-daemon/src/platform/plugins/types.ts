type ActionHandler = (params: Record<string, any>) => Promise<Record<string, any>>;

export interface DaemonPlugin {
  readonly name: string;
  readonly version: string;

  /** Capabilities this plugin adds (e.g., 'browser', 'crawl') */
  getCapabilities(): string[];

  /** Action handlers this plugin provides */
  getActionHandlers(): Map<string, ActionHandler>;

  /** Called when the plugin is loaded */
  initialize(): Promise<void>;

  /** Called when the plugin is unloaded */
  destroy(): Promise<void>;
}

export interface DaemonPluginConstructor {
  new (): DaemonPlugin;
}
