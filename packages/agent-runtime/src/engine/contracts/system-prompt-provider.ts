/**
 * SystemPromptProvider —— 宿主注入的系统提示词装配端口（ Stage 2b）。
 *
 * 引擎 / 子 Agent 路径只消费「已装配好的字符串」或经本端口请求重烘焙；
 * 不再直接 import `@tabtin/agent-prompt` 的 `buildSystemPrompt`。
 */

/** runtime 侧可见的最小工具描述（不依赖 agent-prompt ToolLike）。 */
export interface SystemPromptToolRef {
  name: string;
  description?: string;
}

export interface ResolveSubagentPromptInput {
  parentPrompt: string;
  /** 宿主 opaque 烘焙配置；runtime 不解析字段。 */
  buildConfig: unknown | undefined;
  /** 不透明 mode id（通常为 ask / agent；由宿主解释）。 */
  mode: string;
  childTools?: ReadonlyArray<SystemPromptToolRef>;
}

export interface SystemPromptProvider {
  /**
   * 把父 Agent system prompt 重烘焙为子 Agent 执行者 / 只读研究者视角。
   * 实现细节（agent-prompt builder、group 名册剥离等）由宿主拥有。
   */
  resolveSubagentPrompt(input: ResolveSubagentPromptInput): string;
}
