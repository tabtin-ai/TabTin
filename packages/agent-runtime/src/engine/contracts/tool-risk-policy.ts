/**
 * ToolRiskPolicyPort —— 宿主注入的工具风险判决端口（ Stage 3）。
 *
 * 引擎只消费三态判决与最小工作区边界；EffectivePolicy / MemoStore / judge()
 * 实现留在宿主（`@tabtin/security-policy` 适配器）。
 */

/** 引擎 / adapter 需要的最小工作区边界（替代 WorkspaceSnapshot）。 */
export interface WorkspaceBoundary {
  allowedPaths: readonly string[];
  allowedFiles: readonly string[];
  spaceSessionId?: string;
}

export type RiskDecisionBehavior = 'allow' | 'deny' | 'ask';

/**
 * 判决原因：引擎只分支 `type`（如 plan_blocked / memo_allow）；
 * 其余字段原样透传 wire / UI，不在内核解析产品枚举。
 */
export type RiskDecisionReason = {
  type: string;
  [key: string]: unknown;
};

export interface RiskDecision {
  behavior: RiskDecisionBehavior;
  reason: RiskDecisionReason;
  approvalKey?: string;
  userVisibleReason?: string;
  /** 宿主 / security-policy 透传的下一步建议（引擎只读 suggestion 字符串）。 */
  resolutionHints?: ReadonlyArray<{ suggestion?: string; [key: string]: unknown }>;
}

/** 投影给判决端口的工具描述（字段与旧 JudgeTool 对齐，类型不绑产品包）。 */
export interface ToolRiskJudgeTool {
  name: string;
  policyActionKind?: string;
  deviceActionRisk?: 'observe' | 'interact';
  isReadOnly?: boolean;
  riskLevel?: string;
  planTargetWriteGuarded: boolean;
  extractPath?: (input: unknown) => string | string[] | undefined;
  extractSubcmd?: (input: unknown) => string | undefined;
  isWriteOp?: (input: unknown) => boolean;
}

export interface ToolRiskJudgeInput {
  tool: ToolRiskJudgeTool;
  input: Record<string, unknown>;
  agentMode?: string;
  homeDir?: string;
}

export interface ToolRiskPolicySnapshot {
  workspace?: WorkspaceBoundary;
}

/**
 * wire 缺 `pattern_key` 时重建 memo 主键的入参（与 judge.lookup 对齐）。
 * 内核只传工具名 / 可选 kind / input；路径归一化与三段式 key 由宿主实现。
 */
export interface BuildMemoPatternKeyInput {
  toolName: string;
  policyActionKind?: string;
  toolInput: unknown;
  /** 可选：Tool.extractPolicyParams，用于取 file_path / path。 */
  extractPolicyParams?: (input: unknown) => Record<string, unknown>;
  decisionReason?: RiskDecisionReason;
}

export interface ToolRiskPolicyPort {
  /**
   * PD-13：每轮 runTools 拍一次策略快照。
   * `undefined` = 本轮无有效策略 → hasJudge=false（须已显式注入本 port；
   * 完全未注入 port 时 orchestration 直接 throw）。
   */
  resolveSnapshot(): ToolRiskPolicySnapshot | undefined;

  /** 单工具判决（三态）。 */
  judge(input: ToolRiskJudgeInput): RiskDecision;

  /**
   * wire 缺 pattern_key 时按 security-policy 同款算法重建 memo 主键。
   * LocalPermissionHandler 写 always/thread memo 时使用。
   */
  buildMemoPatternKey(input: BuildMemoPatternKeyInput): string;

  /**
   * 将当前会话最终生效的执行根并入工作区边界。
   *
   * runtime 重建 / worktree 切换时，执行上下文与宿主策略闭包可能来自不同代；
   * 子 Agent 在 fork 前用此方法把最终 workspaceRoot 收口到同一授权边界。
   * 返回新端口实例；不修改父端口。
   */
  forWorkspaceRoot(workspaceRoot: string): ToolRiskPolicyPort;

  /**
   * readonly 子 Agent：返回新端口实例；不修改父端口。
   * 文件目录授权继承父级策略，写能力约束由 agentMode / 工具集表达。
   */
  forReadonlyChild(): ToolRiskPolicyPort;
}
