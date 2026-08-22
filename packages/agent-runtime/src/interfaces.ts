/**
 * Shared interfaces for agent-runtime consumers (Daemon, Electron, etc.).
 */

export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

/**
 * Abstraction over the WS gateway transport, so the local agent runtime
 * (DaemonAgentHost / ElectronAgentHost) can emit events identically across
 * Daemon and Electron contexts.
 */
export interface GatewayPort {
  sendAgentEvent(
    threadId: string,
    type: string,
    payload: Record<string, any>,
  ): Promise<void>;

  subscribeToActionTopic(threadId: string): Promise<void>;
  unsubscribeFromActionTopic(threadId: string): Promise<void>;
}

export interface RuntimeConfig {
  /**
   * Static path or a dynamic resolver. When a function is provided,
   * it will be called at prompt-forward time so the value can track
   * the user's active project (e.g. in Electron).
   */
  workspace_root?: string | (() => string | undefined);
}
