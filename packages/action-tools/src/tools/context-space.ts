import type { AgentTool } from '../types';
import type { ToolError } from '../types/errors';
import { ToolErrorCode, ToolErrorFactory } from '../types/errors';
import { standardizeLegacyResult } from '../utils/tool-output';
import { resolveContextSpaceAPI } from '../utils/runtime-bridge';
import { t } from '../i18n';

type ContextSpaceTab = {
  tabKey: string;
  type: string;
  id: string;
  title?: string;
  meta?: Record<string, unknown>;
};

type ContextSpacePane = {
  id: string;
  tabKey?: string | null;
};

type ContextSpaceGroup = {
  id: string;
  spaceId: string;
  anchorTabKey: string;
  activePaneId: string | null;
  panes: ContextSpacePane[];
  layout: Record<string, unknown> | null;
};

type ContextSpaceState = {
  spaceId?: string;
  crawlspaceId?: string | null;
  activeTabKey: string | null;
  tabOrder: string[];
  tabs: ContextSpaceTab[];
  groups: ContextSpaceGroup[];
};

type ScopedContextSpaceInput = {
  tabScopeKey?: string | null;
  workspaceScopeKey?: string | null;
};

const buildIpcMissingError = <T>(message: string) =>
  standardizeLegacyResult({
    success: false,
    error: ToolErrorFactory.fatal(ToolErrorCode.IPC_NOT_AVAILABLE, message)
  }) as unknown as T;

// ==================== list_context_space ====================

export interface ListContextSpaceInput extends ScopedContextSpaceInput {
  spaceId?: string;
  crawlspaceId?: string | null;
  includeLayout?: boolean;
}

export interface ListContextSpaceOutput {
  success: boolean;
  data?: ContextSpaceState;
  error?: ToolError;
}

export const listContextSpaceTool: AgentTool<ListContextSpaceInput, ListContextSpaceOutput> = {
  name: 'list_context_space',
  description: t('tools.contextSpace.list.description'),
  parameters: {
    type: 'object',
    properties: {
      spaceId: { type: 'string', description: t('tools.contextSpace.list.params.spaceId') },
      crawlspaceId: { type: 'string', description: t('tools.contextSpace.list.params.crawlspaceId') },
      includeLayout: { type: 'boolean', description: t('tools.contextSpace.list.params.includeLayout'), default: true }
    },
    required: []
  },
  async execute(input: ListContextSpaceInput): Promise<ListContextSpaceOutput> {
    const contextSpace = resolveContextSpaceAPI();
    if (!contextSpace?.listContextSpace) {
      return buildIpcMissingError<ListContextSpaceOutput>('contextSpace.listContextSpace unavailable');
    }
    try {
      const result = await contextSpace.listContextSpace(input);
      return standardizeLegacyResult(result) as unknown as ListContextSpaceOutput;
    } catch (error) {
      return standardizeLegacyResult(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          error_code: ToolErrorCode.UNKNOWN_ERROR
        },
        { defaultErrorCode: ToolErrorCode.UNKNOWN_ERROR }
      ) as unknown as ListContextSpaceOutput;
    }
  }
};

// ==================== close_context_tab ====================

export interface CloseContextTabInput extends ScopedContextSpaceInput {
  spaceId: string;
  tabKey: string;
  crawlspaceId?: string | null;
}

export interface CloseContextTabOutput {
  success: boolean;
  data?: { nextActiveTabKey?: string | null };
  error?: ToolError;
}

export const closeContextTabTool: AgentTool<CloseContextTabInput, CloseContextTabOutput> = {
  name: 'close_context_tab',
  description: t('tools.contextSpace.close.description'),
  parameters: {
    type: 'object',
    properties: {
      spaceId: { type: 'string', description: t('tools.contextSpace.close.params.spaceId') },
      tabKey: { type: 'string', description: t('tools.contextSpace.close.params.tabKey') },
      crawlspaceId: { type: 'string', description: t('tools.contextSpace.close.params.crawlspaceId') }
    },
    required: ['spaceId', 'tabKey']
  },
  async execute(input: CloseContextTabInput): Promise<CloseContextTabOutput> {
    const contextSpace = resolveContextSpaceAPI();
    if (!contextSpace?.closeContextTab) {
      return buildIpcMissingError<CloseContextTabOutput>('contextSpace.closeContextTab unavailable');
    }
    try {
      const result = await contextSpace.closeContextTab(input);
      return standardizeLegacyResult(result) as unknown as CloseContextTabOutput;
    } catch (error) {
      return standardizeLegacyResult(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          error_code: ToolErrorCode.UNKNOWN_ERROR
        },
        { defaultErrorCode: ToolErrorCode.UNKNOWN_ERROR }
      ) as unknown as CloseContextTabOutput;
    }
  }
};

// ==================== set_active_context_tab ====================

export interface SetActiveContextTabInput extends ScopedContextSpaceInput {
  spaceId: string;
  tabKey: string | null;
  paneId?: string | null;
  crawlspaceId?: string | null;
}

export interface SetActiveContextTabOutput {
  success: boolean;
  data?: { activeTabKey: string | null };
  error?: ToolError;
}

export const setActiveContextTabTool: AgentTool<SetActiveContextTabInput, SetActiveContextTabOutput> = {
  name: 'set_active_context_tab',
  description: t('tools.contextSpace.setActive.description'),
  parameters: {
    type: 'object',
    properties: {
      spaceId: { type: 'string', description: t('tools.contextSpace.setActive.params.spaceId') },
      tabKey: { type: 'string', description: t('tools.contextSpace.setActive.params.tabKey') },
      paneId: { type: 'string', description: t('tools.contextSpace.setActive.params.paneId') },
      crawlspaceId: { type: 'string', description: t('tools.contextSpace.setActive.params.crawlspaceId') }
    },
    required: ['spaceId']
  },
  async execute(input: SetActiveContextTabInput): Promise<SetActiveContextTabOutput> {
    const contextSpace = resolveContextSpaceAPI();
    if (!contextSpace?.setActiveContextTab) {
      return buildIpcMissingError<SetActiveContextTabOutput>('contextSpace.setActiveContextTab unavailable');
    }
    try {
      const result = await contextSpace.setActiveContextTab(input);
      return standardizeLegacyResult(result) as unknown as SetActiveContextTabOutput;
    } catch (error) {
      return standardizeLegacyResult(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          error_code: ToolErrorCode.UNKNOWN_ERROR
        },
        { defaultErrorCode: ToolErrorCode.UNKNOWN_ERROR }
      ) as unknown as SetActiveContextTabOutput;
    }
  }
};

// ==================== restore_context_group ====================

export interface RestoreContextGroupInput extends ScopedContextSpaceInput {
  spaceId: string;
  groupId: string;
}

export interface RestoreContextGroupOutput {
  success: boolean;
  data?: { tabOrder: string[] };
  error?: ToolError;
}

export const restoreContextGroupTool: AgentTool<RestoreContextGroupInput, RestoreContextGroupOutput> = {
  name: 'restore_context_group',
  description: t('tools.contextSpace.restoreGroup.description'),
  parameters: {
    type: 'object',
    properties: {
      spaceId: { type: 'string', description: t('tools.contextSpace.restoreGroup.params.spaceId') },
      groupId: { type: 'string', description: t('tools.contextSpace.restoreGroup.params.groupId') }
    },
    required: ['spaceId', 'groupId']
  },
  async execute(input: RestoreContextGroupInput): Promise<RestoreContextGroupOutput> {
    const contextSpace = resolveContextSpaceAPI();
    if (!contextSpace?.restoreContextGroup) {
      return buildIpcMissingError<RestoreContextGroupOutput>('contextSpace.restoreContextGroup unavailable');
    }
    try {
      const result = await contextSpace.restoreContextGroup(input);
      return standardizeLegacyResult(result) as unknown as RestoreContextGroupOutput;
    } catch (error) {
      return standardizeLegacyResult(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          error_code: ToolErrorCode.UNKNOWN_ERROR
        },
        { defaultErrorCode: ToolErrorCode.UNKNOWN_ERROR }
      ) as unknown as RestoreContextGroupOutput;
    }
  }
};

// ==================== assign_pane_content ====================

export interface AssignPaneContentInput extends ScopedContextSpaceInput {
  spaceId: string;
  groupId: string;
  paneId: string;
  tabKey: string;
}

export interface AssignPaneContentOutput {
  success: boolean;
  error?: ToolError;
}

export const assignPaneContentTool: AgentTool<AssignPaneContentInput, AssignPaneContentOutput> = {
  name: 'assign_pane_content',
  description: t('tools.contextSpace.assignPane.description'),
  parameters: {
    type: 'object',
    properties: {
      spaceId: { type: 'string', description: t('tools.contextSpace.assignPane.params.spaceId') },
      groupId: { type: 'string', description: t('tools.contextSpace.assignPane.params.groupId') },
      paneId: { type: 'string', description: t('tools.contextSpace.assignPane.params.paneId') },
      tabKey: { type: 'string', description: t('tools.contextSpace.assignPane.params.tabKey') }
    },
    required: ['spaceId', 'groupId', 'paneId', 'tabKey']
  },
  async execute(input: AssignPaneContentInput): Promise<AssignPaneContentOutput> {
    const contextSpace = resolveContextSpaceAPI();
    if (!contextSpace?.assignPaneContent) {
      return buildIpcMissingError<AssignPaneContentOutput>('contextSpace.assignPaneContent unavailable');
    }
    try {
      const result = await contextSpace.assignPaneContent(input);
      return standardizeLegacyResult(result) as unknown as AssignPaneContentOutput;
    } catch (error) {
      return standardizeLegacyResult(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          error_code: ToolErrorCode.UNKNOWN_ERROR
        },
        { defaultErrorCode: ToolErrorCode.UNKNOWN_ERROR }
      ) as unknown as AssignPaneContentOutput;
    }
  }
};

// ==================== split_pane_with_tab ====================

export interface SplitPaneWithTabInput extends ScopedContextSpaceInput {
  spaceId: string;
  groupId: string;
  paneId: string;
  side: 'left' | 'right' | 'top' | 'bottom';
  tabKey: string;
}

export interface SplitPaneWithTabOutput {
  success: boolean;
  error?: ToolError;
}

export const splitPaneWithTabTool: AgentTool<SplitPaneWithTabInput, SplitPaneWithTabOutput> = {
  name: 'split_pane_with_tab',
  description: t('tools.contextSpace.splitPane.description'),
  parameters: {
    type: 'object',
    properties: {
      spaceId: { type: 'string', description: t('tools.contextSpace.splitPane.params.spaceId') },
      groupId: { type: 'string', description: t('tools.contextSpace.splitPane.params.groupId') },
      paneId: { type: 'string', description: t('tools.contextSpace.splitPane.params.paneId') },
      side: { type: 'string', enum: ['left', 'right', 'top', 'bottom'] },
      tabKey: { type: 'string', description: t('tools.contextSpace.splitPane.params.tabKey') }
    },
    required: ['spaceId', 'groupId', 'paneId', 'side', 'tabKey']
  },
  async execute(input: SplitPaneWithTabInput): Promise<SplitPaneWithTabOutput> {
    const contextSpace = resolveContextSpaceAPI();
    if (!contextSpace?.splitPaneWithTab) {
      return buildIpcMissingError<SplitPaneWithTabOutput>('contextSpace.splitPaneWithTab unavailable');
    }
    try {
      const result = await contextSpace.splitPaneWithTab(input);
      return standardizeLegacyResult(result) as unknown as SplitPaneWithTabOutput;
    } catch (error) {
      return standardizeLegacyResult(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          error_code: ToolErrorCode.UNKNOWN_ERROR
        },
        { defaultErrorCode: ToolErrorCode.UNKNOWN_ERROR }
      ) as unknown as SplitPaneWithTabOutput;
    }
  }
};

// ==================== move_pane ====================

export interface MovePaneInput extends ScopedContextSpaceInput {
  spaceId: string;
  groupId: string;
  sourcePaneId: string;
  targetPaneId: string;
  side: 'left' | 'right' | 'top' | 'bottom';
}

export interface MovePaneOutput {
  success: boolean;
  error?: ToolError;
}

export const movePaneTool: AgentTool<MovePaneInput, MovePaneOutput> = {
  name: 'move_pane',
  description: t('tools.contextSpace.movePane.description'),
  parameters: {
    type: 'object',
    properties: {
      spaceId: { type: 'string', description: t('tools.contextSpace.movePane.params.spaceId') },
      groupId: { type: 'string', description: t('tools.contextSpace.movePane.params.groupId') },
      sourcePaneId: { type: 'string', description: t('tools.contextSpace.movePane.params.sourcePaneId') },
      targetPaneId: { type: 'string', description: t('tools.contextSpace.movePane.params.targetPaneId') },
      side: { type: 'string', enum: ['left', 'right', 'top', 'bottom'] }
    },
    required: ['spaceId', 'groupId', 'sourcePaneId', 'targetPaneId', 'side']
  },
  async execute(input: MovePaneInput): Promise<MovePaneOutput> {
    const contextSpace = resolveContextSpaceAPI();
    if (!contextSpace?.movePane) {
      return buildIpcMissingError<MovePaneOutput>('contextSpace.movePane unavailable');
    }
    try {
      const result = await contextSpace.movePane(input);
      return standardizeLegacyResult(result) as unknown as MovePaneOutput;
    } catch (error) {
      return standardizeLegacyResult(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          error_code: ToolErrorCode.UNKNOWN_ERROR
        },
        { defaultErrorCode: ToolErrorCode.UNKNOWN_ERROR }
      ) as unknown as MovePaneOutput;
    }
  }
};

// ==================== dock_pane ====================

export interface DockPaneInput extends ScopedContextSpaceInput {
  spaceId: string;
  groupId: string;
  paneId: string;
  side: 'left' | 'right' | 'top' | 'bottom';
}

export interface DockPaneOutput {
  success: boolean;
  error?: ToolError;
}

export const dockPaneTool: AgentTool<DockPaneInput, DockPaneOutput> = {
  name: 'dock_pane',
  description: t('tools.contextSpace.dockPane.description'),
  parameters: {
    type: 'object',
    properties: {
      spaceId: { type: 'string', description: t('tools.contextSpace.dockPane.params.spaceId') },
      groupId: { type: 'string', description: t('tools.contextSpace.dockPane.params.groupId') },
      paneId: { type: 'string', description: t('tools.contextSpace.dockPane.params.paneId') },
      side: { type: 'string', enum: ['left', 'right', 'top', 'bottom'] }
    },
    required: ['spaceId', 'groupId', 'paneId', 'side']
  },
  async execute(input: DockPaneInput): Promise<DockPaneOutput> {
    const contextSpace = resolveContextSpaceAPI();
    if (!contextSpace?.dockPane) {
      return buildIpcMissingError<DockPaneOutput>('contextSpace.dockPane unavailable');
    }
    try {
      const result = await contextSpace.dockPane(input);
      return standardizeLegacyResult(result) as unknown as DockPaneOutput;
    } catch (error) {
      return standardizeLegacyResult(
        {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          error_code: ToolErrorCode.UNKNOWN_ERROR
        },
        { defaultErrorCode: ToolErrorCode.UNKNOWN_ERROR }
      ) as unknown as DockPaneOutput;
    }
  }
};

export const contextSpaceTools = [
  listContextSpaceTool,
  closeContextTabTool,
  setActiveContextTabTool,
  restoreContextGroupTool,
  assignPaneContentTool,
  splitPaneWithTabTool,
  movePaneTool,
  dockPaneTool
];
