import type { AgentTool } from '../types';
import type { ToolError } from '../types/errors';
import { ToolErrorCode } from '../types/errors';
import { standardizeLegacyResult } from '../utils/tool-output';
import { resolvePageToMarkdownAPI } from '../utils/runtime-bridge';
import { resolveViewId } from '../utils/resolve-view-id';
import { t } from '../i18n';

export interface PageToMarkdownInput {
  viewId?: string;
  crawlTabId?: string;
  url?: string;
  includeLinks?: boolean;
  includeImages?: boolean;
}

export interface PageToMarkdownOutput {
  success: boolean;
  data?: {
    markdown: string;
    title?: string;
    url?: string;
    wordCount: number;
  };
  error?: ToolError;
}

export const pageToMarkdownTool: AgentTool<PageToMarkdownInput, PageToMarkdownOutput> = {
  name: 'page_to_markdown',
  description: t('tools.markdown.convert.description'),
  parameters: {
    type: 'object',
    properties: {
      viewId: {
        type: 'string',
        description: t('tools.markdown.convert.params.viewId'),
      },
      url: {
        type: 'string',
        description: t('tools.markdown.convert.params.url'),
      },
      includeLinks: {
        type: 'boolean',
        description: t('tools.markdown.convert.params.includeLinks'),
      },
      includeImages: {
        type: 'boolean',
        description: t('tools.markdown.convert.params.includeImages'),
      },
    },
    required: [],
  },
  async execute(input: PageToMarkdownInput): Promise<PageToMarkdownOutput> {
    const api = resolvePageToMarkdownAPI();
    if (!api?.convert) {
      return standardizeLegacyResult(
        {
          success: false,
          error: '当前环境不支持页面转 Markdown 功能。请确保已安装 Chrome/Chromium 浏览器，或使用 Electron 桌面客户端。',
          error_code: ToolErrorCode.CAPABILITY_UNAVAILABLE,
        },
        { defaultErrorCode: ToolErrorCode.CAPABILITY_UNAVAILABLE }
      ) as unknown as PageToMarkdownOutput;
    }

    const viewId = resolveViewId(input);
    if (!viewId && !input.url) {
      return standardizeLegacyResult({
        success: false,
        error: 'Either viewId/crawlTabId or url is required',
        error_code: ToolErrorCode.INVALID_PARAMETER,
      }) as unknown as PageToMarkdownOutput;
    }

    try {
      const result = await api.convert({
        viewId,
        url: input.url,
        includeLinks: input.includeLinks ?? true,
        includeImages: input.includeImages ?? true,
      });

      if (!result.success) {
        return standardizeLegacyResult({
          success: false,
          error: result.error || 'Markdown conversion failed',
          error_code: ToolErrorCode.UNKNOWN_ERROR,
        }) as unknown as PageToMarkdownOutput;
      }

      return {
        success: true,
        data: {
          markdown: result.markdown!,
          title: result.title,
          url: result.url,
          wordCount: result.wordCount ?? 0,
        },
      };
    } catch (error) {
      return standardizeLegacyResult({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        error_code: ToolErrorCode.UNKNOWN_ERROR,
      }) as unknown as PageToMarkdownOutput;
    }
  },
};

export const markdownTools = [pageToMarkdownTool];
