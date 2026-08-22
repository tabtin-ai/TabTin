/**
 * `capability/governance` —— Governance 类 Capability 的 barrel。
 *
 * **W2.2.3 落地**：
 *   - `AuditCap`：hooks-only 型，把 agent / iteration / tool 6 类生命周期
 *     事件流向宿主注入的 `AuditWriter`（W3 / Harness 专题落地时接入
 *     Django ExecutionTrace）。
 *   - `CostCap`：全生命周期 hooks 型，合并 BudgetTracker + token-budget +
 *     context-pressure 三件套行为，把"成本压力"统一为单 Capability。
 *
 * **下游消费方**：
 *   - `capability/index.ts` —— 顶层 barrel 通过本文件 re-export
 *   - W2.3 宿主装配代码（ElectronAgentHost / DaemonAgentHost）通过
 *     `@tabtin/agent-runtime/capability` import 实例化
 */

export {
  AuditCap,
  AUDIT_CAP_STREAM_EVENT_TYPE,
  createRelayAuditWriter,
  type AuditCapInit,
  type AuditEvent,
  type AuditLevel,
  type AuditWriter,
} from './audit.js';

export {
  CostCap,
  calculateTokenWarningState,
  DEFAULT_MAX_CREDITS_PER_RUN,
  type CostCapConfig,
  type CostCapExecutionLimits,
  type CostCapInit,
  type PressureLevel,
  type TokenWarningState,
} from './cost.js';
