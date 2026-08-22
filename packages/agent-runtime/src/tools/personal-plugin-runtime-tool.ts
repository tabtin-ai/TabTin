import type {
  Tool,
  ToolContext,
  ToolResult,
} from '../engine/contracts/tools.js';
import { jsonError } from '../capability/core/_utils.js';
import { INTERNAL_ERROR, MISSING_REQUIRED_PARAM } from '../engine/errors/error-kinds.js';

export interface PersonalPluginLaunchRuntimeInput {
  organizationId: string;
  spaceId: string;
  agentId?: string;
  pluginId: string;
  serviceId?: string;
  title?: string;
  openBrowser?: boolean;
  requireMcp?: boolean;
}

export interface PersonalPluginLaunchRuntimeStatus {
  state: string;
  runtimeId?: string;
  pluginId?: string;
  serviceId?: string;
  url?: string;
  installPath?: string;
  projectDir?: string;
  process?: {
    command?: string;
    cwd?: string;
    pid?: number;
    processId?: string;
  };
  mcp?: {
    state?: string;
    serverCount?: number;
    tools?: Array<{ name: string }>;
  };
}

export interface PersonalPluginRuntimeToolDeps {
  agentId?: string;
  /**
   * ** RB1**：host 在装配 ToolProvider 时烘进的 per-runtime 业务身份。
   * 启动 Personal Plugin runtime 用这里的烘焙值，不再从运行时 `ToolContext` 读
   * spaceId/organizationId（切 Space 会重建 runtime，故为常量，可安全烘焙）。
   */
  spaceId?: string;
  organizationId?: string;
  launchRuntime: (input: PersonalPluginLaunchRuntimeInput) => Promise<PersonalPluginLaunchRuntimeStatus>;
}

const launchRuntimeInputSchema = {
  type: 'object',
  properties: {
    pluginId: {
      type: 'string',
      description: 'Personal Plugin id, for example "cowart".',
    },
    serviceId: {
      type: 'string',
      description: 'Optional local service id from the plugin manifest, for example "canvas".',
    },
    title: {
      type: 'string',
      description: 'Optional title for the browser tab opened by the plugin runtime.',
    },
    openBrowser: {
      type: 'boolean',
      description: 'Whether TabTin should open the plugin local service URL in the in-app browser. Defaults to true.',
    },
    requireMcp: {
      type: 'boolean',
      description: 'Whether MCP attachment is required for this launch. Defaults to false.',
    },
  },
  required: ['pluginId'],
  additionalProperties: false,
} as unknown as Tool['inputSchema'];

function trimOptional(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function createPersonalPluginRuntimeTool(deps: PersonalPluginRuntimeToolDeps): Tool {
  return {
    name: 'personal_plugin_launch_runtime',
    policyActionKind: 'object_write',
    description:
      '启动已安装并在当前 Agent 启用的 Personal Plugin 本地 runtime。' +
      '本工具会根据平台 registry 找到插件安装目录，在插件自己的安装目录中启动 local service，' +
      '按需 attach MCP，并打开浏览器标签。不要用 shell 手动搜索或启动 Personal Plugin 脚本。',
    inputSchema: launchRuntimeInputSchema,
    isReadOnly: false,
    async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
      const raw = (input ?? {}) as Record<string, unknown>;
      const pluginId = trimOptional(raw.pluginId);
      if (!pluginId) {
        return jsonError('缺少参数 pluginId。', {
          error_kind: MISSING_REQUIRED_PARAM,
          field: 'pluginId',
          hint: 'Pass the Personal Plugin id from the invoked skill metadata.',
        });
      }
      if (!deps.organizationId || !deps.spaceId) {
        return jsonError('缺少当前 Workspace 上下文，无法启动 Personal Plugin runtime。', {
          error_kind: MISSING_REQUIRED_PARAM,
          field: !deps.organizationId ? 'organizationId' : 'spaceId',
          hint: 'Retry this action inside a concrete Workspace conversation.',
        });
      }

      try {
        const status = await deps.launchRuntime({
          organizationId: deps.organizationId,
          spaceId: deps.spaceId,
          agentId: deps.agentId,
          pluginId,
          serviceId: trimOptional(raw.serviceId),
          title: trimOptional(raw.title),
          openBrowser: typeof raw.openBrowser === 'boolean' ? raw.openBrowser : true,
          requireMcp: raw.requireMcp === true,
        });
        const mcpTools = status.mcp?.tools?.map((tool) => tool.name).filter(Boolean) ?? [];
        return {
          content: JSON.stringify({
            state: status.state,
            pluginId: status.pluginId ?? pluginId,
            serviceId: status.serviceId,
            url: status.url,
            runtimeId: status.runtimeId,
            process: status.process
              ? {
                  pid: status.process.pid,
                  processId: status.process.processId,
                  cwd: status.process.cwd,
                }
              : undefined,
            mcp: status.mcp
              ? {
                  state: status.mcp.state,
                  serverCount: status.mcp.serverCount,
                  tools: mcpTools,
                }
              : undefined,
          }),
        };
      } catch (err) {
        return jsonError(`启动 Personal Plugin runtime 失败：${(err as Error).message}`, {
          error_kind: INTERNAL_ERROR,
          pluginId,
        });
      }
    },
  };
}
