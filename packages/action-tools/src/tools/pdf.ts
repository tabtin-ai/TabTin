import type { AgentTool } from '../types';
import type { ToolError } from '../types/errors';
import { ToolErrorCode } from '../types/errors';
import { standardizeLegacyResult } from '../utils/tool-output';
import { resolvePdfAPI } from '../utils/runtime-bridge';
import { resolveViewId } from '../utils/resolve-view-id';
import { t } from '../i18n';

export interface GeneratePdfInput {
  viewId?: string;
  crawlTabId?: string;
  landscape?: boolean;
  printBackground?: boolean;
  pageSize?: string;
  margins?: { top?: number; bottom?: number; left?: number; right?: number };
  savePath?: string;
}

export interface GeneratePdfOutput {
  success: boolean;
  data?: {
    path: string;
    sizeBytes: number;
    pageCount?: number;
  };
  error?: ToolError;
}

export const generatePdfTool: AgentTool<GeneratePdfInput, GeneratePdfOutput> = {
  name: 'generate_pdf',
  description: t('tools.pdf.generate.description'),
  parameters: {
    type: 'object',
    properties: {
      viewId: {
        type: 'string',
        description: t('tools.pdf.generate.params.viewId'),
      },
      landscape: {
        type: 'boolean',
        description: t('tools.pdf.generate.params.landscape'),
      },
      printBackground: {
        type: 'boolean',
        description: t('tools.pdf.generate.params.printBackground'),
      },
      pageSize: {
        type: 'string',
        description: t('tools.pdf.generate.params.pageSize'),
      },
      margins: {
        type: 'object',
        description: t('tools.pdf.generate.params.margins'),
      },
      savePath: {
        type: 'string',
        description: t('tools.pdf.generate.params.savePath'),
      },
    },
    required: [],
  },
  async execute(input: GeneratePdfInput): Promise<GeneratePdfOutput> {
    const api = resolvePdfAPI();
    if (!api?.generate) {
      return standardizeLegacyResult(
        {
          success: false,
          error: '当前环境不支持 PDF 生成功能。请确保已安装 Chrome/Chromium 浏览器，或使用 Electron 桌面客户端。',
          error_code: ToolErrorCode.CAPABILITY_UNAVAILABLE,
        },
        { defaultErrorCode: ToolErrorCode.CAPABILITY_UNAVAILABLE }
      ) as unknown as GeneratePdfOutput;
    }

    const viewId = resolveViewId(input);
    if (!viewId) {
      return standardizeLegacyResult({
        success: false,
        error: 'viewId or crawlTabId is required',
        error_code: ToolErrorCode.INVALID_PARAMETER,
      }) as unknown as GeneratePdfOutput;
    }

    try {
      const result = await api.generate({
        viewId,
        landscape: input.landscape,
        printBackground: input.printBackground ?? true,
        pageSize: input.pageSize,
        margins: input.margins,
        savePath: input.savePath,
      });

      if (!result.success) {
        return standardizeLegacyResult({
          success: false,
          error: result.error || 'PDF generation failed',
          error_code: ToolErrorCode.UNKNOWN_ERROR,
        }) as unknown as GeneratePdfOutput;
      }

      return {
        success: true,
        data: {
          path: result.path!,
          sizeBytes: result.sizeBytes!,
          pageCount: result.pageCount,
        },
      };
    } catch (error) {
      return standardizeLegacyResult({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        error_code: ToolErrorCode.UNKNOWN_ERROR,
      }) as unknown as GeneratePdfOutput;
    }
  },
};

export const pdfTools = [generatePdfTool];
