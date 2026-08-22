/**
 * Capability 接口契约 —— 对应 M1 §3.1 / 总控 Part 3.2.1。
 *
 * Capability 是"能力打包单元" —— 把 tools / hooks / sampling / manifest
 * 变换 + 生命周期统一成一个对象。
 *
 * **设计哲学**（详见总控 Part 2.2）：
 *   - 本地化为若干 hooks
 *   - 最大复用现有 EngineHooks 机制（生产中验证：skills-and-notes /
 *     doom-loop-guard / context-pressure 等中间件）
 *   - 装配在宿主层（ElectronAgentHost / DaemonAgentHost），query.ts
 *     主循环零感知
 *
 * **下游消费方**：
 *   - W2: 5 个 Capability 实现（FileSystem / Shell / Skills / Audit / Cost）
 *         按本接口 implements / extends CapabilityBase
 *   - W2: 宿主在 createSession 时 buildCapabilitiesFromPreset → bind →
 *         prepareAgentTools / composeCapabilityHooks
 *   - W3: HITL Pipeline 通过 Capability 的 hooks().beforeTool 拦截
 *
 * **历史**：曾有 `instructions?()` hook + `prepareAgentInstructions` 装配函数，
 * 阶段 2.3（2026-05-20）整套物理下线 —— 0 production caller。未来要把 cap
 * 文案拼到 system prompt 必须走 `@tabtin/agent-prompt::buildSystemPrompt` +
 * `@tabtin/prompt-contract` 注册表，**不要**恢复 `instructions()` 接口
 * （会再造一层与 SECTION_REGISTRY 平行的隐形 SSoT）。
 */

import type {
  Tool,
} from '../engine/contracts/tools.js';
import type {
  EngineHooks,
} from '../engine/contracts/kernel.js';
import type { BackendSession } from './backend-session.js';
import type { Manifest } from './manifest.js';

/**
 * Capability 类别 —— 决定 UI 分组 + 默认装配策略。
 *
 * - `app`: 内置 App 的 Agent 侧入口（TabData / TabDoc / TabMemo / TabVideo 等）
 * - `core`: 通用 / 元能力基础设施（FileSystem / Shell / Skills / Cost 等）
 * - `governance`: 治理 / 横切关注点（Audit / 未来的 Permission / Guardrail）
 *
 * **判断口诀**：
 *   - 操作领域对象（表 / 文 / 视频）→ app
 *   - 通用基础工具（读文件 / 跑命令 / 查 skill）→ core
 *   - 横切约束（审批 / 审计 / 预算）→ governance
 */
export type CapabilityCategory = 'app' | 'core' | 'governance';

/**
 * Capability 接口 —— 6 个 hook + 2 个生命周期辅助。
 *
 * **使用约定**：
 *   - 简单 Capability 直接 implements 本接口；
 *   - 复杂 / 持久化 Capability 应 `extends CapabilityBase`（见 base.ts）
 *     以复用 clone + 并发保护默认实现；
 *   - 所有 hook 都是 optional —— Capability 只贡献它实际需要的部分
 *     （某些 cap 可能只贡献 sampling_params 一项）。
 *
 * **冻结约定**（M1 实施期间不得自作主张推翻）：字段只增不删，语义不变。
 * 如发现接口不够用 → 停手回 harness 开 RFC。
 *
 * **2026-05-20 例外**：阶段 2.3 删除了原 hook 5 `instructions?()`（0 production
 * caller，详见文件顶部 docstring 历史段）。此处"例外删除"经过 3 个 review agent
 * 独立审查 + harness 治理决议，未来若需类似能力按文件顶部指引走 agent-prompt /
 * prompt-contract 路径，不要恢复本接口字段。
 */
export interface Capability {
  /**
   * 全局唯一类型标识（例 `'filesystem'` / `'tab-data'` / `'tab-memo'`）。
   *
   * 用于：
   *   - CapabilityRegistry 注册 key
   *   - required_capability_types() 引用
   *   - UI 分组展示标识
   *   - 错误日志定位（CapabilityToolsConflictError 引用 capType）
   *
   * **命名约定**：kebab-case，与 packages/apps/<name>/app.json 的 id
   * 对齐（App 类）；core / governance 类用语义化短名。
   */
  readonly type: string;

  /** 类别 —— 决定 UI 分组展示。详见 CapabilityCategory 注释。 */
  readonly category: CapabilityCategory;

  // ── Hook 1: 依赖声明 ────────────────────────────────────────────
  /**
   * 声明本 Capability 依赖哪些其他 Capability 的 type。
   *
   * 校验时机：CapabilityRegistry.validateDependencies(caps) 在宿主装配
   * 阶段调用 —— 缺失依赖立即抛 CapabilityDependencyError，不做静默放过。
   *
   * 例：TabMemoCap 依赖 { 'filesystem' } 因为记忆读写需要文件 IO；
   *     SkillsCap 依赖 { 'filesystem' } 同理。
   *
   * 返回 ReadonlySet 而非 Array —— 强调"集合语义无序无重复"。
   */
  required_capability_types?(): ReadonlySet<string>;

  // ── Hook 2: Manifest 变换（仅 LocalVM/Cloud）────────────────────
  /**
   * 在 session 创建前对 Manifest 做变换。**纯函数，不修改原参数**。
   *
   * 调用时机：M3 LocalVMBackend / M4 CloudBackend 启动 session 前，
   * 按 capabilities 列表顺序串联调用：
   *   manifest_0 = initial_manifest
   *   manifest_i = caps[i].process_manifest?.(manifest_{i-1}) ?? manifest_{i-1}
   *
   * Native 模式：manifest 参数为 undefined，本 hook 不被调用（M2
   * NativeBackendSession 不消费 manifest）。
   *
   * 例：SkillsCap.process_manifest 把 skill 目录挂进 manifest.entries。
   */
  process_manifest?(manifest: Manifest): Manifest;

  // ── Hook 3: session 绑定 ────────────────────────────────────────
  /**
   * Runtime 在每轮 prepare_agent 时调用，绑定本次的 BackendSession。
   * Capability 内部应保存 session 引用供后续 tools handler 使用。
   *
   * **并发保护约定**：同一个 Capability 实例如果已绑定 sessionA，
   * 再调用 bind(sessionB) 时**必须抛 Error**。如需并发使用（同 Capability
   * 类型挂在多个 Agent / Run 上），Runtime 必须先 clone()。
   *
   * 此约束由 CapabilityBase 默认实现提供（见 base.ts）；具体 Capability
   * 子类可以 override，但**不得放松**约束。
   */
  bind?(session: BackendSession): void | Promise<void>;

  // ── Hook 4: 工具贡献 ─────────────────────────────────────────────
  /**
   * 返回本 Capability 提供的工具列表。
   *
   * **调用前置条件**：必须在 bind 之后 —— tools handler 通常依赖
   * `this._session`（详见 base.ts CapabilityBase）。
   *
   * **工具名约束**（Anthropic API 硬约束）：name 必须匹配 `^[a-zA-Z0-9_-]{1,64}$`，
   * 不合规会被 prepareAgentTools 抛 CapabilityToolNameError。建议命名：
   *   `<capType>__<verb>` 或 `<verb>_<noun>`（避免与其他 Capability 撞名）。
   */
  tools?(): Tool[];

  // ── Hook 5: 提示词贡献（已下线）──────────────────────────────────
  // 原 `instructions?(manifest?)` 已于阶段 2.3（2026-05-20）删除。
  // 0 production caller，详见文件顶部 docstring。

  // ── Hook 6: 模型参数调整 ────────────────────────────────────────
  /**
   * 返回要合并到 sampling params 的字段（如 temperature / top_p /
   * thinking budget / context_management 等 Provider 特定字段）。
   *
   * **多 Capability 合并语义**：按 caps 列表顺序 deep_merge；`current`
   * 是前面已合并的结果（首个 Capability 看到 base 配置）。
   *
   * 例：CompactionCap.sampling_params 返回 { context_management: [...] }
   * 让 Provider 启用上下文管理。
   */
  sampling_params?(current: Record<string, unknown>): Record<string, unknown>;

  // ── Hook 7: EngineHooks 注入 ────────────────────────────────────
  /**
   * 返回要挂到 Runtime 的 EngineHooks。
   *
   * **为什么复用 EngineHooks 而不新造 process_context**：
   * 现有 runtime 的 beforeRun / beforeIteration / afterIteration /
   * beforeTool / afterTool 机制已经在生产中验证（skills-and-notes /
   * doom-loop-guard / context-pressure 等中间件
   * 都挂在上面；#4019 批次 11 起统一为单代 ctx 契约）。Capability 通过
   * hooks() 与现有中间件生态无缝衔接，不再引入并行的第二套钩子。
   *
   * 装配路径：
   *   const capHooks = composeCapabilityHooks(caps);
   *   const finalHooks = composeHooks(capHooks, ...legacyMiddlewares);
   *   createRuntime({ hooks: finalHooks, ... });
   *
   * **返回 null / 全部字段未设置**：表示本 Capability 不注入任何钩子
   * （纯 tools + prompt 贡献的 Capability 是完全合理的）。
   */
  hooks?(): EngineHooks | null;

  // ── 生命周期辅助 ─────────────────────────────────────────────────

  /**
   * 每次 prepare_agent 时 clone 一个新实例（避免并发污染）。
   *
   * **何时必须 override**：Capability 持有以下任何一类字段时
   * （见 CapabilityBase.clone 的 SKIP_KEYS 注释）：
   *   - asyncio Lock / AbortController
   *   - EventEmitter 订阅句柄
   *   - 不可 structuredClone 的资源（数据库连接、HTTP client）
   *
   * **简单 Capability**：直接用 CapabilityBase.clone 默认实现即可。
   */
  clone?(): Capability;

  /**
   * session 结束前的收尾 hook（pre_stop_hook）。
   *
   * 调用时机：BackendSession.shutdown() 之前 —— **此时 session 还活着**，
   * Capability 可以做最后一次读写（典型：TabMemoCap 的 phase_one 蒸馏，
   * 把本次 session 的 events.jsonl 蒸馏成笔记写入 TabMemo）。
   *
   * **耗时操作**：可以在这里做（比 sync 快慢更适合做这类清理）。
   */
  on_session_stop?(session: BackendSession): Promise<void>;
}
