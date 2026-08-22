import type { ActionExecutorAdapter } from '@tabtin/action-tools/headless';
import type { BrowserApplicationPort } from '../../base/browser/browser-application-port.js';

export interface EnvironmentPort {
  get(name: string): string | undefined;
  set(name: string, value: string | undefined): void;
}

export interface WsConnectionInfo {
  serverUrl: string;
  wsUrl: string;
  credential: string;
  organizationId: string;
  userId: string;
  fingerprint: string;
}

export type CLISkillsMaterializer = (params: {
  organizationId: string;
  spaceId: string;
  userId: string;
  appId: string;
  slug: string;
}) => Promise<{ installed: number; skipped: number; errors: string[] }>;

export type CLISkillsInteropAdder = (rootPath: string) => Promise<void>;

export interface CliRequestContextOptions {
  environment: EnvironmentPort;
  spaceId?: string | null;
  browserApplication?: BrowserApplicationPort | null;
  actionAdapter?: ActionExecutorAdapter | null;
  wsConnectionInfo?: WsConnectionInfo | null;
  workspaceSnapshotResolver?: (() => import('@tabtin/security-policy').WorkspaceSnapshot | null) | null;
  subagentCancelResolver?: ((childId: string) => boolean) | null;
  skillsMaterializer?: CLISkillsMaterializer | null;
  skillsInteropAdder?: CLISkillsInteropAdder | null;
}

/** Per-server mutable request state. Ownership belongs to the CLI server instance. */
export class CliRequestContext {
  private spaceId: string | null;
  private browserApplication: BrowserApplicationPort | null;
  private actionAdapter: ActionExecutorAdapter | null;
  private wsConnectionInfo: WsConnectionInfo | null;
  private workspaceSnapshotResolver: (() => import('@tabtin/security-policy').WorkspaceSnapshot | null) | null;
  private subagentCancelResolver: ((childId: string) => boolean) | null;
  private skillsMaterializer: CLISkillsMaterializer | null;
  private skillsInteropAdder: CLISkillsInteropAdder | null;

  constructor(private readonly environment: EnvironmentPort, options: Omit<CliRequestContextOptions, 'environment'> = {}) {
    this.spaceId = options.spaceId ?? null;
    this.browserApplication = options.browserApplication ?? null;
    this.actionAdapter = options.actionAdapter ?? null;
    this.wsConnectionInfo = options.wsConnectionInfo ?? null;
    this.workspaceSnapshotResolver = options.workspaceSnapshotResolver ?? null;
    this.subagentCancelResolver = options.subagentCancelResolver ?? null;
    this.skillsMaterializer = options.skillsMaterializer ?? null;
    this.skillsInteropAdder = options.skillsInteropAdder ?? null;
  }

  setSpaceId(value: string | null): void {
    this.spaceId = value;
    this.environment.set('TABTIN_SPACE_ID', value ?? undefined);
  }
  getSpaceId(): string | null { return this.spaceId || this.environment.get('TABTIN_SPACE_ID') || null; }
  peekSpaceId(): string | null { return this.spaceId; }
  getOrganizationId(): string | null { return this.wsConnectionInfo?.organizationId || this.environment.get('TABTIN_ORGANIZATION_ID') || null; }
  getUserId(): string | null { return this.wsConnectionInfo?.userId || this.environment.get('TABTIN_USER_ID') || null; }
  requireUserId(): string {
    const value = this.getUserId();
    if (!value) throw new Error('未登录：无法解析 userId，拒绝写入本地 skills 目录（请重新运行 `tabtin-daemon init --token <token> --force`）');
    return value;
  }
  getOrganizationRoot(): string | null { return this.environment.get('TABTIN_ORGANIZATION_ROOT') || null; }
  setBrowserApplication(value: BrowserApplicationPort | null): void { this.browserApplication = value; }
  getBrowserApplication(): BrowserApplicationPort | null { return this.browserApplication; }
  setActionAdapter(value: ActionExecutorAdapter | null): void { this.actionAdapter = value; }
  getActionAdapter(): ActionExecutorAdapter | null { return this.actionAdapter; }
  setWsConnectionInfo(value: WsConnectionInfo | null): void { this.wsConnectionInfo = value; }
  getWsConnectionInfo(): WsConnectionInfo | null { return this.wsConnectionInfo; }
  updateWsCredential(value: string): void { if (this.wsConnectionInfo) this.wsConnectionInfo.credential = value; }
  setWorkspaceSnapshotResolver(value: (() => import('@tabtin/security-policy').WorkspaceSnapshot | null) | null): void { this.workspaceSnapshotResolver = value; }
  resolveWorkspaceSnapshot(): import('@tabtin/security-policy').WorkspaceSnapshot | null { return this.workspaceSnapshotResolver?.() ?? null; }
  setSubagentCancelResolver(value: ((childId: string) => boolean) | null): void { this.subagentCancelResolver = value; }
  getSubagentCancelResolver(): ((childId: string) => boolean) | null { return this.subagentCancelResolver; }
  setSkillsMaterializer(value: CLISkillsMaterializer | null): void { this.skillsMaterializer = value; }
  getSkillsMaterializer(): CLISkillsMaterializer | null { return this.skillsMaterializer; }
  setSkillsInteropAdder(value: CLISkillsInteropAdder | null): void { this.skillsInteropAdder = value; }
  getSkillsInteropAdder(): CLISkillsInteropAdder | null { return this.skillsInteropAdder; }
}
