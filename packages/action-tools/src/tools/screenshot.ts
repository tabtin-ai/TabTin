/**
 * capture_screenshot — Electron 原生截屏工具
 *
 * 捕获主窗口或指定视图的截屏，保存为文件并返回路径。
 * 不创建 Run 会话，适用于一次性截屏需求。
 */

import type { AgentTool } from '../types';
import type { ToolError } from '../types/errors';
import { ToolErrorCode } from '../types/errors';
import { standardizeLegacyResult } from '../utils/tool-output';
import { resolveScreenshotAPI } from '../utils/runtime-bridge';
import { resolveViewId } from '../utils/resolve-view-id';
import { t } from '../i18n';

export interface CaptureScreenshotInput {
  target?: 'window' | 'view' | 'screen';
  viewId?: string;
  crawlTabId?: string;
  displayId?: string;
  format?: 'png' | 'jpeg';
  quality?: number;
  includeBase64?: boolean;
  fullPage?: boolean;
}

export interface CaptureScreenshotOutput {
  success: boolean;
  data?: {
    path: string;
    width: number;
    height: number;
    format: string;
    sizeBytes: number;
    base64?: string;
    base64_degraded?: boolean;
    base64_format?: string;
    compression_hint?: string;
    scaleFactor?: number;
  };
  error?: ToolError;
}

export const captureScreenshotTool: AgentTool<CaptureScreenshotInput, CaptureScreenshotOutput> = {
  name: 'capture_screenshot',

  description: t('tools.screenshot.capture.description'),

  parameters: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        enum: ['window', 'view', 'screen'],
        description: t('tools.screenshot.capture.params.target'),
      },
      viewId: {
        type: 'string',
        description: t('tools.screenshot.capture.params.viewId'),
      },
      format: {
        type: 'string',
        enum: ['png', 'jpeg'],
        description: t('tools.screenshot.capture.params.format'),
      },
      quality: {
        type: 'number',
        description: t('tools.screenshot.capture.params.quality'),
      },
      includeBase64: {
        type: 'boolean',
        description: t('tools.screenshot.capture.params.includeBase64'),
      },
      fullPage: {
        type: 'boolean',
        description: t('tools.screenshot.capture.params.fullPage'),
      },
      displayId: {
        type: 'string',
        description: t('tools.screenshot.capture.params.displayId') || 'Display ID for multi-monitor setups (target=screen only)',
      },
    },
    required: [],
  },

  async execute(input: CaptureScreenshotInput): Promise<CaptureScreenshotOutput> {
    const api = resolveScreenshotAPI();
    if (!api?.capture) {
      return standardizeLegacyResult(
        {
          success: false,
          error: '当前环境不支持截屏功能。请确保已安装 Chrome/Chromium 浏览器，或使用 Electron 桌面客户端。',
          error_code: ToolErrorCode.CAPABILITY_UNAVAILABLE,
        },
        { defaultErrorCode: ToolErrorCode.CAPABILITY_UNAVAILABLE }
      ) as unknown as CaptureScreenshotOutput;
    }

    const viewId = resolveViewId(input);
    const target = input.target || (viewId ? 'view' : 'window');

    try {
      const result = await api.capture({
        target,
        viewId,
        displayId: input.displayId,
        format: input.format || 'png',
        quality: input.quality,
        includeBase64: input.includeBase64 ?? false,
        fullPage: input.fullPage,
      });

      if (!result.success) {
        return standardizeLegacyResult({
          success: false,
          error: result.error || '截屏失败',
          error_code: ToolErrorCode.UNKNOWN_ERROR,
        }) as unknown as CaptureScreenshotOutput;
      }

      const data: CaptureScreenshotOutput['data'] = {
        path: result.path!,
        width: result.width!,
        height: result.height!,
        format: result.format!,
        sizeBytes: result.sizeBytes!,
        base64: result.base64,
        base64_degraded: result.base64_degraded,
        base64_format: result.base64_format,
        scaleFactor: result.scaleFactor,
      };

      if (target === 'screen' && result.sizeBytes && result.sizeBytes > 2 * 1024 * 1024 && (input.format || 'png') !== 'jpeg') {
        data!.compression_hint = 'Screenshot is large. Consider using format=jpeg for smaller file size.';
      }

      return standardizeLegacyResult({
        success: true,
        data,
      }) as unknown as CaptureScreenshotOutput;
    } catch (error) {
      return standardizeLegacyResult({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        error_code: ToolErrorCode.UNKNOWN_ERROR,
      }) as unknown as CaptureScreenshotOutput;
    }
  },
};

export const screenshotTools = [captureScreenshotTool];
