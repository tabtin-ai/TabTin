/**
 * Capability 层错误类型集中定义。
 *
 * 单独成文件避免 capability.ts / backend-session.ts / prepare.ts / registry.ts
 * 之间通过错误类型互相依赖（防止循环 import）。
 *
 * 设计原则：
 *   1. 每个错误带具体上下文字段（类型化），方便调用者构造结构化日志，
 *      不要求 grep error.message 字符串。
 *   2. error.message 同时给人类可读说明（让 W2 实施者一眼看懂哪儿炸了）。
 *   3. 全部 fail-fast——M1 §3.5/§3.6 要求装配阶段任何一条错误都直接抛，
 *      不做静默降级（"宁可让宿主启动崩，不要让一个错配的 Capability 在
 *      运行时偷偷绕过校验跑出去"——总控决策记录）。
 */

/**
 * Capability 依赖校验失败：当前 capability 列表里缺少某个被依赖的 type。
 *
 * 抛出位置：`CapabilityRegistry.validateDependencies(caps)`，在宿主装配
 * 阶段调用——一旦抛出表示 preset / agent_config 编排有误，**应在启动期
 * 阶段直接让宿主崩溃**而不是让 Agent 跑半截再失败。
 *
 * 字段：
 *   - `capType`: 声明依赖的 capability type（例 `'tab-memo'`）
 *   - `missingDep`: 缺失的依赖 type（例 `'filesystem'`）
 */
export class CapabilityDependencyError extends Error {
  constructor(
    readonly capType: string,
    readonly missingDep: string,
  ) {
    super(
      `Capability "${capType}" requires missing dependency: "${missingDep}". ` +
        `Add the missing capability to the agent's capability list, or remove the ` +
        `requirement from "${capType}.required_capability_types()".`,
    );
    this.name = 'CapabilityDependencyError';
  }
}

/**
 * 两个不同 Capability 贡献了同名 tool，违反"工具名全局唯一"的产品心智。
 *
 * 抛出位置：`prepareAgentTools(caps)` 收集 tool 时——fail-fast 直接抛，
 * 不做静默后者覆盖前者（那种行为会让 W2 调试时陷入"为什么我的 tool 行为
 * 跟实现不一致"的死局）。
 *
 * 修复路径：
 *   1. 让其中一个 Capability 给 tool 改名（推荐用 `<capType>__<verb>` 命名）
 *   2. 或者在 preset 层移除其中一个 Capability
 */
export class CapabilityToolsConflictError extends Error {
  constructor(
    readonly toolName: string,
    readonly firstCapType: string,
    readonly secondCapType: string,
  ) {
    super(
      `Tool name "${toolName}" is contributed by both "${firstCapType}" and "${secondCapType}". ` +
        `Tool names must be globally unique across all Capabilities. ` +
        `Either rename the tool in one of the Capabilities, or remove one from the agent's capability list.`,
    );
    this.name = 'CapabilityToolsConflictError';
  }
}

/**
 * Tool name 不符合 Anthropic API 的硬约束 `^[a-zA-Z0-9_-]{1,64}$`。
 *
 * 抛出位置：`prepareAgentTools(caps)` 收集 tool 时。
 *
 * 为什么 fail-fast：Anthropic / OpenAI 的 tool name 校验在请求发送时
 * 才报错（HTTP 400），到那时已经走过 prompt 构造 + cache 计算等成本，
 * 用户看到的错误是"模型不可用"而非"你的 tool name 写错了"——非常难排查。
 * 我们在装配期就拦下来。
 */
export class CapabilityToolNameError extends Error {
  constructor(
    readonly toolName: string,
    readonly capType: string,
  ) {
    super(
      `Tool name "${toolName}" from Capability "${capType}" violates naming rule ` +
        `^[a-zA-Z0-9_-]{1,64}$ (Anthropic API hard constraint). ` +
        `Use only ASCII letters, digits, underscore, and hyphen; max 64 characters.`,
    );
    this.name = 'CapabilityToolNameError';
  }
}

/**
 * 反序列化 SessionPersistState 时 `schemaVersion` 不匹配——硬 fail-fast，
 * **不做自动迁移**（`$schemaVersion` 模式）。
 *
 * 设计意图：跨 version persisted state 的自动迁移在分布式 Agent 系统里
 * 是反模式——任何一条字段语义微变就可能导致沉默腐化。M1 选择"破而后立":
 * 升版本就拒绝老 state，由调用者决定丢弃 / 重建 / 警告。
 *
 * 抛出位置：未来 M3 / M4 BackendSession 子类的 `hydrateWorkspace` 实现
 * 中——M1 只定义错误类型，不在 M1 阶段触发。
 */
export class SessionPersistStateVersionError extends Error {
  constructor(
    readonly expected: number,
    readonly actual: unknown,
  ) {
    super(
      `SessionPersistState schemaVersion mismatch: expected ${expected}, got ${String(actual)}. ` +
        `This session was persisted by an incompatible runtime version. ` +
        `No automatic migration is provided — discard or rebuild the session state.`,
    );
    this.name = 'SessionPersistStateVersionError';
  }
}
