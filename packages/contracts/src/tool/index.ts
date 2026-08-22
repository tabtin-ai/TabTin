// ─── Agent Tool ──────────────────────────────────────────────────────
//
// ToolErrorCode / ToolError / StandardToolOutput 死镜像已删除（2026-07）。
// 现阶段 SSoT：`packages/browser-core/src/types/errors.ts`
// （action-tools 经 `@tabtin/browser-core` re-export 消费）。
// P2 将改为生成式单源；本模块不再承载错误码镜像。

export interface AgentTool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
  riskLevel?: ToolRiskLevel;
  execute: (input: TInput) => Promise<TOutput>;
}

// ─── Tool Manifest ───────────────────────────────────────────────────

export type ToolExecutionTarget = 'frontend' | 'backend' | 'hybrid';

export type ToolRiskLevel = 'safe' | 'review' | 'strict';

export type ToolParameters = {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
};

export interface ToolManifest {
  name: string;
  description: string;
  parameters: ToolParameters;
  appId: string;
  executionTarget: ToolExecutionTarget;
  riskLevel?: ToolRiskLevel;
  tags?: string[];
}
