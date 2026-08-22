/**
 * app-shell 运行时配置
 *
 * 各平台（Electron / Web）在应用启动时调用 configureAppShell() 注入差异实现，
 * 内部模块通过 getRuntime() 获取当前配置。避免 React Context 限制——Zustand store
 * 可在 React 树外运行。
 */

export interface HttpTransport {
  (options: {
    url: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{ status: number; data: any; headers?: Record<string, string> }>;
}

export interface AuthProvider {
  getToken(): Promise<string | null>;
  getCurrentUserId(): string | null;
}

export interface PlatformBridge {
  setActiveSpace(
    spaceId: string | null,
    crawlspaceId: string | null,
    organizationId: string | null,
    workspaceRoot?: string | null,
  ): void;
  resetChatClient(): void;
  closeAuxiliaryPanels?(): void;
  resolveCrawlspaceId?(spaceId: string): string | null;
  onSpaceDeleted?(spaceId: string): void;
  /**
   * 删 Workspace 成功后 best-effort 清本机外部导入档案（Electron）。
   * 按 workspaceId 或同 workingDir 匹配；失败不应阻断删除主路径。
   */
  clearExternalArchivesForWorkspace?(args: {
    organizationId: string
    workspaceId: string
    workingDir?: string | null
  }): void | Promise<void>;
  purgeInvalidSpaceDerivedState?(validSpaceIds: string[]): void;
  getDeviceFingerprint?(): string;
  getCurrentDeviceId?(): string | null;
  /**
   * Electron：把 Agent / Workspace 变更推到 Host turn 状态仓库。
   * 缺省（Web）可空实现。
   */
  pushHostTurnState?(payload: {
    agent?: {
      id: string
      detail?: Record<string, unknown>
      display_name?: string | null
      name?: string | null
      custom_rules?: string | null
      personal_rules?: string | null
      agent_config?: unknown
      organization_allow_member_yolo?: boolean | null
    }
    workspace?: {
      id: string
      custom_rules?: string | null
      execution_limits?: {
        max_iterations_per_run?: number | null
        max_credits_per_run?: number | string | null
        enabled?: boolean | null
      } | null
      approval_grant?: 'always_ask' | 'auto' | 'full_access' | null
    }
  }): void;
}

export interface AppShellRuntime {
  apiBaseUrl: string;
  transport: HttpTransport;
  auth: AuthProvider;
  bridge: PlatformBridge;
}

let _runtime: AppShellRuntime | null = null;

export function configureAppShell(runtime: AppShellRuntime): void {
  _runtime = runtime;
}

export function getRuntime(): AppShellRuntime {
  if (!_runtime) {
    throw new Error(
      '[app-shell] configureAppShell() 未调用。请在应用启动时注入运行时配置。',
    );
  }
  return _runtime;
}
