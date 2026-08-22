/**
 * Browser 工具定义
 *
 * 为 AI Agent 提供智能浏览器自动化能力
 */

import type { AgentTool } from '../types';
import { standardizeLegacyResult } from '../utils/tool-output';
import { getSharedBrowserToolImpl } from '../impl/BrowserToolImpl';
import { t } from '../i18n';
import type {
  ExecuteActInput,
  ExecuteActOutput,
  ExecuteObserveInput,
  ExecuteObserveOutput,
  RequestSnapshotInput,
  RequestSnapshotOutput,
} from './browser-types';

// ==================== 工具 1: execute_act ====================

export const executeActTool: AgentTool<ExecuteActInput, ExecuteActOutput> = {
  name: 'execute_act',

  description: t('tools.browser.executeAct.description'),

  parameters: {
    type: 'object',
    properties: {
      actions: {
        type: 'array',
        description: t('tools.browser.executeAct.params.actions'),
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['click', 'fill', 'scroll', 'wait', 'drag', 'type', 'keyPress', 'keyDown', 'keyUp', 'hover', 'dblclick', 'upload', 'select'],
              description: t('tools.browser.executeAct.params.actionType')
            },
            selector: {
              type: 'string',
              description: t('tools.browser.executeAct.params.selector')
            },
            value: {
              type: 'string',
              description: t('tools.browser.executeAct.params.value')
            },
            duration: {
              type: 'number',
              description: t('tools.browser.executeAct.params.duration')
            },
            key: {
              type: 'string',
              description: 'Key for keyPress/keyDown/keyUp (e.g. "Enter", "Cmd+A")'
            },
            toSelector: {
              type: 'string',
              description: 'Target selector for drag actions'
            },
            fromX: { type: 'number', description: 'Source X coordinate for drag' },
            fromY: { type: 'number', description: 'Source Y coordinate for drag' },
            toX: { type: 'number', description: 'Target X coordinate for drag' },
            toY: { type: 'number', description: 'Target Y coordinate for drag' },
            x: { type: 'number', description: 'X coordinate for coordinate-based click' },
            y: { type: 'number', description: 'Y coordinate for coordinate-based click' },
            files: {
              type: 'array',
              items: { type: 'string' },
              description: 'File path(s) for upload action'
            },
            steps: { type: 'number', description: 'Intermediate steps for drag (default 10)' },
            delay: { type: 'number', description: 'Delay between characters for type action (ms)' }
          },
          required: ['type']
        }
      },
      stop_on_error: {
        type: 'boolean',
        description: t('tools.browser.executeAct.params.stopOnError'),
        default: true
      },
      runId: {
        type: 'string',
        description: t('tools.browser.executeAct.params.runId')
      },
      crawlTabId: {
        type: 'string',
        description: t('tools.browser.executeAct.params.crawlTabId')
      },
      partition: {
        type: 'string',
        description: t('tools.browser.executeAct.params.partition')
      },
      proxy: {
        type: 'object',
        description: t('tools.browser.executeAct.params.proxy')
      },
      userAgent: {
        type: 'string',
        description: t('tools.browser.executeAct.params.userAgent')
      }
    },
    required: ['actions']
  },

  async execute(input: ExecuteActInput): Promise<ExecuteActOutput> {
    const impl = getSharedBrowserToolImpl();
    const result = await impl.executeAct(input);
    return standardizeLegacyResult(result);
  }
};

// ==================== 工具 2: execute_observe ====================

export const executeObserveTool: AgentTool<ExecuteObserveInput, ExecuteObserveOutput> = {
  name: 'execute_observe',

  description: t('tools.browser.executeObserve.description'),

  parameters: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        description: t('tools.browser.executeObserve.params.selector')
      },
      runId: {
        type: 'string',
        description: t('tools.browser.executeObserve.params.runId')
      },
      crawlTabId: {
        type: 'string',
        description: t('tools.browser.executeObserve.params.crawlTabId')
      },
      partition: {
        type: 'string',
        description: t('tools.browser.executeObserve.params.partition')
      },
      proxy: {
        type: 'object',
        description: t('tools.browser.executeObserve.params.proxy')
      },
      userAgent: {
        type: 'string',
        description: t('tools.browser.executeObserve.params.userAgent')
      }
    },
    required: []
  },

  async execute(input: ExecuteObserveInput): Promise<ExecuteObserveOutput> {
    const impl = getSharedBrowserToolImpl();
    const result = await impl.executeObserve(input);
    return standardizeLegacyResult(result);
  }
};

// ==================== 工具 4: request_snapshot ====================

export const requestSnapshotTool: AgentTool<RequestSnapshotInput, RequestSnapshotOutput> = {
  name: 'request_snapshot',

  description: t('tools.browser.requestSnapshot.description'),

  parameters: {
    type: 'object',
    properties: {
      include_dom: {
        type: 'boolean',
        description: t('tools.browser.requestSnapshot.params.includeDom'),
        default: true
      },
      include_screenshot: {
        type: 'boolean',
        description: t('tools.browser.requestSnapshot.params.includeScreenshot'),
        default: false
      },
      include_accessibility_tree: {
        type: 'boolean',
        description: t('tools.browser.requestSnapshot.params.includeAccessibilityTree'),
        default: true
      },
      include_raw_html: {
        type: 'boolean',
        description: t('tools.browser.requestSnapshot.params.includeRawHtml'),
        default: false
      },
      include_clean_html: {
        type: 'boolean',
        description: t('tools.browser.requestSnapshot.params.includeCleanHtml'),
        default: false
      },
      full_page_screenshot: {
        type: 'boolean',
        description: '全页面截图（包含滚动区域，需配合 include_screenshot）',
        default: false
      },
      screenshot_width: {
        type: 'number',
        description: '截图 viewport 宽度（默认 1280px，避免被侧边栏压缩）',
      },
      runId: {
        type: 'string',
        description: t('tools.browser.requestSnapshot.params.runId')
      },
      crawlTabId: {
        type: 'string',
        description: t('tools.browser.requestSnapshot.params.crawlTabId')
      },
      partition: {
        type: 'string',
        description: t('tools.browser.requestSnapshot.params.partition')
      },
      proxy: {
        type: 'object',
        description: t('tools.browser.requestSnapshot.params.proxy')
      },
      userAgent: {
        type: 'string',
        description: t('tools.browser.requestSnapshot.params.userAgent')
      }
    },
    required: []
  },

  async execute(input: RequestSnapshotInput): Promise<RequestSnapshotOutput> {
    const impl = getSharedBrowserToolImpl();
    const result = await impl.requestSnapshot(input);
    return standardizeLegacyResult(result);
  }
};

// ==================== 工具集合导出 ====================

export const browserTools = [
  executeActTool,
  executeObserveTool,
  requestSnapshotTool,
];
