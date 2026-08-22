/**
 * Tab 管理工具 - 封装 IPC 为 Agent 工具
 *
 * 将主进程的 run-session IPC 封装为 Agent 工具，
 * 使 AI Agent 能够直接管理标签页
 */

import type { AgentTool } from '../types';
import type { ToolError } from '../types/errors';
import { ToolErrorCode, ToolErrorFactory } from '../types/errors';
import { standardizeLegacyResult } from '../utils/tool-output';
import {
  resolveBrowserEnvAPI,
  resolveContextSpaceAPI,
  resolveCrawlViewAPI,
  resolveRunSessionAPI,
  resolveViewFactoryAPI
} from '../utils/runtime-bridge';
import { t } from '../i18n';

// ==================== 工具执行帮助 ====================

type CrawlViewAPI = {
  loadUrl?: (tabId: string, url: string, options?: any) => Promise<any> | any;
  waitForSelector?: (tabId: string, options: any) => Promise<any> | any;
};

type OpenTabPayload = OpenTabInput & {
  notifyRenderer?: boolean;
  displayMode?: 'embedded' | 'windowed' | 'hidden';
  showInSidebar?: boolean;
  tabName?: string;
};

/**
 * partition 解析优先级（本地化退役 Wave 2 之后）：
 *   1. `input.partition`（显式传入，由调用者完全负责）
 *   2. `config.partition`（来自源 view 的上下文——Agent 从一个 TabWeb 继续开 tab）
 *   3. `BrowserEnvAPI.getPartitionForSpace(spaceId)`（Space 绑定的登录环境 partition）
 *   4. 都解析不到 → 留 undefined，主进程 RunSessionManager 拿 metadata.spaceId
 *      二次解析或返回错误。Daemon 模式不走 Electron partition 语义，也不补 fallback。
 *
 * `spaceId` 与 `crawlspaceId` 是独立维度：
 * - `crawlspaceId` 标识视图分组 / 会话 workspace；
 * - `spaceId` 标识租户 / 登录身份。
 * partition 只表达登录身份，不再混用 crawlspaceId 拼字符串。
 */
function deriveDefaultsFromSourceView(input: OpenTabInput): Partial<OpenTabPayload> {
  const sourceViewId = (input as any).crawlTabId as string | undefined;
  if (!sourceViewId) return {};

  const viewFactory = resolveViewFactoryAPI();
  const state = viewFactory?.getViewState?.(sourceViewId);
  const config = state?.config || {};
  const crawlspaceId = config.metadata?.crawlspaceId;
  const baseMetadata = config.metadata || {};
  const metadata = crawlspaceId
    ? {
        ...baseMetadata,
        crawlspaceId,
        kind: baseMetadata.kind || 'workspace-view'
      }
    : baseMetadata;

  const spaceId =
    typeof input.metadata?.spaceId === 'string' ? input.metadata.spaceId
      : typeof baseMetadata.spaceId === 'string' ? baseMetadata.spaceId
      : undefined;
  const resolvedPartition = resolvePartitionForOpenTab({
    explicit: input.partition,
    configPartition: config.partition,
    spaceId,
    crawlspaceId: typeof crawlspaceId === 'string' ? crawlspaceId : undefined,
  });
  // 旧代码在 `crawlspaceId && !resolvedPartition` 时打 warn，但现在
  // `resolvePartitionForOpenTab` 保证 crawlspaceId 存在 → 必返回 partition
  // （兼容兜底分支），所以那条 warn 永远不触发，已删除避免误导。

  return {
    profile: input.profile ?? config.profile,
    partition: resolvedPartition,
    userAgent: input.userAgent ?? config.userAgent,
    metadata: input.metadata ?? metadata,
    ...(crawlspaceId ? { notifyRenderer: true } : {})
  };
}

/**
 * Wave 2b-F：集中的 partition 解析入口。暴露为内部函数便于下游
 * `open_tab` 主体在 metadata.crawlspaceId 走自动拼接分支前也能先过一遍
 * "spaceId → 环境 partition" 的 fallback。
 */
function resolvePartitionForOpenTab(args: {
  explicit?: string | undefined;
  configPartition?: string | undefined;
  spaceId?: string | undefined;
  crawlspaceId?: string | undefined;
}): string | undefined {
  if (args.explicit) return args.explicit;
  if (args.configPartition) return args.configPartition;
  if (args.spaceId) {
    try {
      const api = resolveBrowserEnvAPI();
      const partition = api?.getPartitionForSpace?.(args.spaceId);
      if (partition) return partition;
    } catch (err) {
      // resolver 约定永不抛；防御性 catch 不影响 fallback 链
      console.warn('[open_tab] resolveBrowserEnvAPI.getPartitionForSpace 异常，走兼容分支:', err);
    }
  }
  // Daemon 模式 / Service 未注入 → 让 RunSessionManager 按 metadata.spaceId
  // 在主进程侧重新解析；本处不再补 legacy `tabtin:crawlspace:${crawlspaceId}`
  // fallback（无现网用户、无 legacy 数据）。
  return undefined;
}

function resolveOpenTabSpaceId(input: OpenTabInput): string | undefined {
  const metadataSpaceId = typeof input.metadata?.spaceId === 'string' ? input.metadata.spaceId : undefined;
  return metadataSpaceId || input._space_id;
}

function resolveOpenTabScopeKey(input: OpenTabInput): string | undefined {
  return input.tabScopeKey || input.workspaceScopeKey || undefined;
}

// ==================== open_tab ====================

/**
 * 打开新标签页的输入参数
 */
export interface OpenTabInput {
  runId: string;
  viewId?: string;
  /** @deprecated 历史遗留字段，等同 viewId。请使用 viewId 替代。 */
  id?: string;
  url?: string;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  timeout?: number;
  waitForSelector?: string;
  waitForTimeout?: number;
  waitForState?: 'attached' | 'visible' | 'hidden';
  profile?: string;
  partition?: string;       // Session 分区（用于隔离）
  userAgent?: string;       // 自定义 User-Agent
  proxy?: any;              // 代理配置
  metadata?: Record<string, any>;
  fallbackReason?: string;
  /** 当前桌面/对话 workspace scope key；由 runtime 在交互式对话中自动注入。 */
  tabScopeKey?: string | null;
  /** tabScopeKey 的语义别名。 */
  workspaceScopeKey?: string | null;
  /** runtime 注入的当前 Space ID。 */
  _space_id?: string;
}

/**
 * 打开新标签页的输出结果
 */
export interface OpenTabOutput {
  success: boolean;
  data?: Record<string, any>;
  /** 创建的标签页 ID（规范输出，推荐使用） */
  viewId?: string;
  /**
   * @deprecated 历史遗留字段，等同 viewId。请使用 viewId 替代。
   * 将在未来版本中移除。
   */
  id?: string;
  profile?: string;         // 使用的 Profile
  reused?: boolean;         // 是否复用了已有标签页
  error?: ToolError;
}

/**
 * 打开新标签页工具
 *
 * 功能：
 * - 在指定的 Run 中创建新标签页
 * - 支持 Session 隔离（partition）
 * - 支持自定义 User-Agent 和代理
 * - 自动注册到 Run 并设置为活跃标签页
 */
export const openTabTool: AgentTool<OpenTabInput, OpenTabOutput> = {
  name: 'open_tab',

  description: t('tools.tabManagement.open.description'),

  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: t('tools.tabManagement.open.params.url')
      },
      waitUntil: {
        type: 'string',
        enum: ['load', 'domcontentloaded', 'networkidle'],
        description: t('tools.tabManagement.open.params.waitUntil')
      },
      timeout: {
        type: 'number',
        description: t('tools.tabManagement.open.params.timeout')
      },
      waitForSelector: {
        type: 'string',
        description: t('tools.tabManagement.open.params.waitForSelector')
      },
      waitForTimeout: {
        type: 'number',
        description: t('tools.tabManagement.open.params.waitForTimeout')
      },
      waitForState: {
        type: 'string',
        enum: ['attached', 'visible', 'hidden'],
        description: t('tools.tabManagement.open.params.waitForState')
      },
      profile: {
        type: 'string',
        description: t('tools.tabManagement.open.params.profile'),
        default: 'background-task'
      },
      partition: {
        type: 'string',
        description: t('tools.tabManagement.open.params.partition')
      },
      userAgent: {
        type: 'string',
        description: t('tools.tabManagement.open.params.userAgent')
      },
      proxy: {
        type: 'object',
        description: t('tools.tabManagement.open.params.proxy')
      },
      runId: {
        type: 'string',
        description: t('tools.tabManagement.open.params.runId')
      },
      viewId: {
        type: 'string',
        description: t('tools.tabManagement.open.params.viewId')
      },
      id: {
        type: 'string',
        description: '[deprecated: 请使用 viewId] ' + t('tools.tabManagement.open.params.id'),
        deprecated: true
      } as any,
      fallbackReason: {
        type: 'string',
        description: t('tools.tabManagement.open.params.fallbackReason')
      }
    },
    required: ['runId']
  },

  async execute(input: OpenTabInput): Promise<OpenTabOutput> {
    try {
      if (!input.runId) {
        return standardizeLegacyResult(
          {
            success: false,
            error: t('errors.runIdRequired'),
            error_code: ToolErrorCode.INVALID_PARAMETER
          },
          { defaultErrorCode: ToolErrorCode.INVALID_PARAMETER }
        );
      }
      const runSession = resolveRunSessionAPI();
      const derivedDefaults = deriveDefaultsFromSourceView(input);
      const payloadBase: OpenTabPayload = { ...input };
      if ((input as any).crawlTabId) {
        delete payloadBase.displayMode;
        delete payloadBase.showInSidebar;
        delete payloadBase.notifyRenderer;
        delete payloadBase.tabName;
      }
      let payloadMerged: OpenTabPayload = {
        ...payloadBase,
        ...derivedDefaults
      };
      const fallbackReason =
        (input as any).fallbackReason ?? payloadMerged.fallbackReason;
      if (fallbackReason) {
        payloadMerged = {
          ...payloadMerged,
          fallbackReason,
          metadata: {
            ...(payloadMerged.metadata || {}),
            fallbackReason
          }
        };
      }
      const injectedSpaceId = resolveOpenTabSpaceId(payloadMerged);
      if (injectedSpaceId && payloadMerged.metadata?.spaceId !== injectedSpaceId) {
        payloadMerged = {
          ...payloadMerged,
          metadata: {
            ...(payloadMerged.metadata || {}),
            spaceId: injectedSpaceId
          }
        };
      }
      const visibleScopeKey = resolveOpenTabScopeKey(payloadMerged);
      if (payloadMerged.url && injectedSpaceId && visibleScopeKey && payloadMerged.displayMode !== 'hidden') {
        const contextSpace = resolveContextSpaceAPI();
        if (contextSpace?.createWebTab) {
          const result = await contextSpace.createWebTab({
            spaceId: injectedSpaceId,
            tabScopeKey: visibleScopeKey,
            workspaceScopeKey: visibleScopeKey,
            runId: input.runId,
            url: payloadMerged.url,
            title: payloadMerged.tabName || payloadMerged.url,
          });
          if (result?.success) {
            const viewId = result.data?.viewId;
            if (viewId && (payloadMerged.waitUntil || payloadMerged.waitForSelector)) {
              const crawlView = resolveCrawlViewAPI();
              if (payloadMerged.waitUntil && !crawlView?.loadUrl) {
                return standardizeLegacyResult({
                  success: false,
                  error: ToolErrorFactory.fatal(
                    ToolErrorCode.IPC_NOT_AVAILABLE,
                    'crawlView.loadUrl unavailable for waitUntil',
                    { viewId }
                  )
                });
              }
              if (payloadMerged.waitForSelector && !crawlView?.waitForSelector) {
                return standardizeLegacyResult({
                  success: false,
                  error: ToolErrorFactory.fatal(
                    ToolErrorCode.IPC_NOT_AVAILABLE,
                    'crawlView.waitForSelector unavailable',
                    { viewId }
                  )
                });
              }
              if (payloadMerged.waitUntil && crawlView?.loadUrl) {
                const loadResult = await crawlView.loadUrl(viewId, payloadMerged.url, {
                  waitUntil: payloadMerged.waitUntil,
                  timeout: payloadMerged.timeout,
                  waitForSelector: payloadMerged.waitForSelector,
                  waitForTimeout: payloadMerged.waitForTimeout,
                  waitForState: payloadMerged.waitForState
                });
                if (!loadResult?.success) {
                  return standardizeLegacyResult({
                    success: false,
                    error: ToolErrorFactory.fatal(
                      ToolErrorCode.TIMEOUT,
                      loadResult?.error || 'loadUrl failed',
                      { viewId, url: payloadMerged.url }
                    )
                  });
                }
              } else if (payloadMerged.waitForSelector && crawlView?.waitForSelector) {
                const waitResult = await crawlView.waitForSelector(viewId, {
                  selector: payloadMerged.waitForSelector,
                  timeout: payloadMerged.waitForTimeout || payloadMerged.timeout,
                  state: payloadMerged.waitForState
                });
                if (!waitResult?.success) {
                  return standardizeLegacyResult({
                    success: false,
                    error: ToolErrorFactory.fatal(
                      ToolErrorCode.TIMEOUT,
                      waitResult?.error || 'waitForSelector failed',
                      { viewId, url: payloadMerged.url, selector: payloadMerged.waitForSelector }
                    )
                  });
                }
              }
            }
            return standardizeLegacyResult({
              success: true,
              data: result.data,
              viewId,
              id: viewId,
              profile: payloadMerged.profile,
              reused: false
            });
          }
          return standardizeLegacyResult({
            success: false,
            error: ToolErrorFactory.fatal(
              ToolErrorCode.IPC_NOT_AVAILABLE,
              result?.error || 'contextSpace.createWebTab failed',
              { spaceId: injectedSpaceId, tabScopeKey: visibleScopeKey, url: payloadMerged.url }
            )
          });
        }
      }
      // Wave 2b-F：partition 解析统一入口，不论是否有 crawlspaceId。
      //
      // 旧逻辑只在 `metadata.crawlspaceId && !partition` 时拼 partition —— Agent
      // 直接调 `open_tab({ metadata: { spaceId } })`（无 crawlspaceId 也无
      // crawlTabId）会走到没 partition 的路径，view 回退到 defaultSession，
      // 这是 Wave 2b-F 要修的反例。
      //
      // 现行逻辑（Wave 3 收尾）：payloadMerged.partition 仍为空时，以 metadata.spaceId
      // 为主要依据查环境 partition；没有 spaceId 时返回 undefined，由
      // `RunSessionManager` 在主进程按 metadata 兜底解析。**不再回落**到
      // 历史的 `tabtin:crawlspace:{id}` 兼容分支（无现网用户、无 legacy 数据，
      // credential-vault 白名单也已剔除该前缀）。
      if (!payloadMerged.partition) {
        const meta = payloadMerged.metadata || {};
        const spaceIdFromMeta = typeof meta.spaceId === 'string' ? meta.spaceId : undefined;
        const crawlspaceIdFromMeta = typeof meta.crawlspaceId === 'string' ? meta.crawlspaceId : undefined;
        const resolved = resolvePartitionForOpenTab({
          explicit: undefined,
          configPartition: undefined,
          spaceId: spaceIdFromMeta,
          crawlspaceId: crawlspaceIdFromMeta,
        });
        if (resolved) {
          payloadMerged.partition = resolved;
        }
      }
      if (!payloadMerged.viewId && !payloadMerged.id) {
        const crawlspaceId =
          typeof payloadMerged.metadata?.crawlspaceId === 'string'
            ? payloadMerged.metadata.crawlspaceId
            : null;
        if (crawlspaceId) {
          payloadMerged.id = `view-${crawlspaceId}-${Date.now()}`;
        }
      }
      const payload = payloadMerged.viewId && !payloadMerged.id
        ? { ...payloadMerged, id: payloadMerged.viewId }
        : payloadMerged;
      // 本地化退役 Wave 2 之后主进程 BES 永远立即可用,工具层不再需要
      // programmatic 重试逻辑(原来用于规避 BES bootstrap 未就绪的瞬时错误)。
      const result: any = await runSession?.openTab?.(payload);

      if (!result) {
        return standardizeLegacyResult(
          {
            success: false,
            error: t('errors.ipcNotAvailable'),
            error_code: ToolErrorCode.IPC_NOT_AVAILABLE
          },
          { defaultErrorCode: ToolErrorCode.IPC_NOT_AVAILABLE }
        );
      }

      if (result?.success) {
        const resolvedViewId = result.viewId ?? result.id;
        const resolvedId = result.id ?? result.viewId;
        const resolved = standardizeLegacyResult({
          ...result,
          viewId: resolvedViewId,
          id: resolvedId
        });
        if (input.url && (input.waitUntil || input.waitForSelector || input.timeout || input.waitForTimeout)) {
          const crawlView = resolveCrawlViewAPI();
          if (!crawlView?.loadUrl && !crawlView?.waitForSelector) {
            return standardizeLegacyResult({
              success: false,
              error: ToolErrorFactory.fatal(
                ToolErrorCode.IPC_NOT_AVAILABLE,
                'crawlView API unavailable for wait options',
                { viewId: resolvedViewId }
              )
            });
          }
          if (input.waitUntil && crawlView?.loadUrl) {
            const loadResult = await crawlView.loadUrl(resolvedViewId, input.url, {
              waitUntil: input.waitUntil,
              timeout: input.timeout,
              waitForSelector: input.waitForSelector,
              waitForTimeout: input.waitForTimeout,
              waitForState: input.waitForState
            });
            if (!loadResult?.success) {
              return standardizeLegacyResult({
                success: false,
                error: ToolErrorFactory.fatal(
                  ToolErrorCode.TIMEOUT,
                  loadResult?.error || 'loadUrl failed',
                  { viewId: resolvedViewId, url: input.url }
                )
              });
            }
          } else if (input.waitForSelector && crawlView?.waitForSelector) {
            const waitResult = await crawlView.waitForSelector(resolvedViewId, {
              selector: input.waitForSelector,
              timeout: input.waitForTimeout || input.timeout,
              state: input.waitForState
            });
            if (!waitResult?.success) {
              return standardizeLegacyResult({
                success: false,
                error: ToolErrorFactory.fatal(
                  ToolErrorCode.TIMEOUT,
                  waitResult?.error || 'waitForSelector failed',
                  { viewId: resolvedViewId, url: input.url, selector: input.waitForSelector }
                )
              });
            }
          }
        }
        return resolved;
      }
      return standardizeLegacyResult(result);
    } catch (error) {
      console.error('[openTabTool] 执行失败:', error);
      return standardizeLegacyResult(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          error_code: ToolErrorCode.UNKNOWN_ERROR
        },
        { defaultErrorCode: ToolErrorCode.UNKNOWN_ERROR }
      );
    }
  }
};

// ==================== switch_tab ====================

/**
 * 切换标签页的输入参数
 */
export interface SwitchTabInput {
  runId?: string;
  viewId: string;           // 要切换到的标签页 ID
  bounds?: any;             // 可选的显示区域
  waitForSelector?: string;
  waitForTimeout?: number;
  waitForState?: 'attached' | 'visible' | 'hidden';
}

/**
 * 切换标签页的输出结果
 */
export interface SwitchTabOutput {
  success: boolean;
  data?: Record<string, any>;
  error?: ToolError;
}

/**
 * 切换标签页工具
 *
 * 功能：
 * - 切换到指定的标签页
 * - 更新 Run 的活跃标签页
 * - 可选地调整显示区域
 */
export const switchTabTool: AgentTool<SwitchTabInput, SwitchTabOutput> = {
  name: 'switch_tab',

  description: t('tools.tabManagement.switch.description'),

  parameters: {
    type: 'object',
    properties: {
      viewId: {
        type: 'string',
        description: t('tools.tabManagement.switch.params.viewId')
      },
      runId: {
        type: 'string',
        description: t('tools.tabManagement.switch.params.runId')
      },
      bounds: {
        type: 'object',
        description: t('tools.tabManagement.switch.params.bounds')
      },
      waitForSelector: {
        type: 'string',
        description: t('tools.tabManagement.switch.params.waitForSelector')
      },
      waitForTimeout: {
        type: 'number',
        description: t('tools.tabManagement.switch.params.waitForTimeout')
      },
      waitForState: {
        type: 'string',
        enum: ['attached', 'visible', 'hidden'],
        description: t('tools.tabManagement.switch.params.waitForState')
      }
    },
    required: ['viewId']
  },

  async execute(input: SwitchTabInput): Promise<SwitchTabOutput> {
    try {
      const runSession = resolveRunSessionAPI();
      const result = await runSession?.switchTab?.(input);

      if (!result) {
        return standardizeLegacyResult(
          {
            success: false,
            error: t('errors.ipcNotAvailable'),
            error_code: ToolErrorCode.IPC_NOT_AVAILABLE
          },
          { defaultErrorCode: ToolErrorCode.IPC_NOT_AVAILABLE }
        );
      }

      const resolved = standardizeLegacyResult(result);
      if (resolved.success && input.waitForSelector) {
        const crawlView = resolveCrawlViewAPI();
        if (!crawlView?.waitForSelector) {
          return standardizeLegacyResult({
            success: false,
            error: ToolErrorFactory.fatal(
              ToolErrorCode.IPC_NOT_AVAILABLE,
              'crawlView.waitForSelector unavailable',
              { viewId: input.viewId }
            )
          });
        }
        const waitResult = await crawlView.waitForSelector(input.viewId, {
          selector: input.waitForSelector,
          timeout: input.waitForTimeout,
          state: input.waitForState
        });
        if (!waitResult?.success) {
          return standardizeLegacyResult({
            success: false,
            error: ToolErrorFactory.fatal(
              ToolErrorCode.TIMEOUT,
              waitResult?.error || 'waitForSelector failed',
              { viewId: input.viewId, selector: input.waitForSelector }
            )
          });
        }
      }
      return resolved;
    } catch (error) {
      console.error('[switchTabTool] 执行失败:', error);
      return standardizeLegacyResult(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          error_code: ToolErrorCode.UNKNOWN_ERROR
        },
        { defaultErrorCode: ToolErrorCode.UNKNOWN_ERROR }
      );
    }
  }
};

// ==================== close_tab ====================

/**
 * 关闭标签页的输入参数
 */
export interface CloseTabInput {
  runId?: string;
  viewId: string;           // 要关闭的标签页 ID
  force?: boolean;          // 是否强制关闭
}

/**
 * 关闭标签页的输出结果
 */
export interface CloseTabOutput {
  success: boolean;
  data?: Record<string, any>;
  error?: ToolError;
}

/**
 * 关闭标签页工具
 *
 * 功能：
 * - 关闭指定的标签页
 * - 从 Run 中注销标签页
 * - 可选地强制关闭（即使有未保存的更改）
 */
export const closeTabTool: AgentTool<CloseTabInput, CloseTabOutput> = {
  name: 'close_tab',

  description: t('tools.tabManagement.close.description'),

  parameters: {
    type: 'object',
    properties: {
      viewId: {
        type: 'string',
        description: t('tools.tabManagement.close.params.viewId')
      },
      runId: {
        type: 'string',
        description: t('tools.tabManagement.close.params.runId')
      },
      force: {
        type: 'boolean',
        description: t('tools.tabManagement.close.params.force'),
        default: false
      }
    },
    required: ['viewId']
  },

  async execute(input: CloseTabInput): Promise<CloseTabOutput> {
    try {
      const viewFactory = resolveViewFactoryAPI();
      const viewState = viewFactory?.getViewState?.(input.viewId);
      const shouldForce =
        typeof input.force === 'boolean'
          ? input.force
          : Boolean(viewState?.config?.metadata?.crawlspaceId);
      const runSession = resolveRunSessionAPI();
      const result = await runSession?.closeTab?.({
        ...input,
        force: shouldForce
      });

      if (!result) {
        return standardizeLegacyResult(
          {
            success: false,
            error: t('errors.ipcNotAvailable'),
            error_code: ToolErrorCode.IPC_NOT_AVAILABLE
          },
          { defaultErrorCode: ToolErrorCode.IPC_NOT_AVAILABLE }
        );
      }

      return standardizeLegacyResult(result);
    } catch (error) {
      console.error('[closeTabTool] 执行失败:', error);
      return standardizeLegacyResult(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          error_code: ToolErrorCode.UNKNOWN_ERROR
        },
        { defaultErrorCode: ToolErrorCode.UNKNOWN_ERROR }
      );
    }
  }
};

// ==================== 工具集合导出 ====================

/**
 * Tab 管理工具集合
 *
 * 包含：
 * - open_tab: 打开新标签页
 * - switch_tab: 切换标签页
 * - close_tab: 关闭标签页
 */
export const tabManagementTools = [
  openTabTool,
  switchTabTool,
  closeTabTool
];
