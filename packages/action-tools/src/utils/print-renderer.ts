/**
 * print 渲染器 — `tabtin browser print` 的共享内容渲染（双端同一份）
 *
 * 职责：把「页面 HTML + 元信息」渲染成 print 支持的文本类产物形态：
 *   - text     纯文本正文（readability 清洗后剥标签）
 *   - markdown Turndown 转换 + 后处理（默认形态）
 *   - html     clean HTML（保结构）
 *   - json     JSON Schema 结构化投影（需 schema）
 *
 * pdf 不在此渲染（依赖运行时打印引擎：Electron printToPDF / Daemon patchright），
 * 由各端 route 自行落地。
 *
 * 内容类型白名单在渲染前统一应用：print 是 CLI-only 面，
 * 不传 `include` = 剥离全部可过滤类型（只留纯正文）。
 */

import { parseContentTypeWhitelist, filterHtmlByContentTypes, type ContentType } from './content-type-filter';
import { extractMainContent, stripHtmlTags } from './html-content-extractor';
import { createTurndownInstance, postProcessMarkdown } from './html-to-markdown';
import { cleanHtml } from './html-cleaner';
import { extractStructuredFromHtml, parseJsonSchema } from './schema-extract';

/** print 的文本类产物形态（pdf 由各端运行时打印引擎处理，不经本渲染器）。 */
export const PRINT_TEXT_FORMATS = ['text', 'markdown', 'html', 'json'] as const;
export type PrintTextFormat = (typeof PRINT_TEXT_FORMATS)[number];

export interface RenderPrintInput {
  /** 页面 HTML（tab 模式为渲染后 DOM，url 模式为抓取产物）。 */
  html: string;
  title?: string;
  url?: string;
  /** `--include` 原始值；缺省 = 剥离全部可过滤类型。 */
  include?: unknown;
  /** `--as json` 的 JSON Schema（字符串或对象）。 */
  schema?: unknown;
}

export interface RenderPrintResult {
  /** 最终写入文件的内容。 */
  content: string;
  /** 推荐文件扩展名（不带点）。 */
  extension: string;
  /** json 形态的结构化投影告警。 */
  warnings?: string[];
}

const FORMAT_EXTENSIONS: Record<PrintTextFormat, string> = {
  text: 'txt',
  markdown: 'md',
  html: 'html',
  json: 'json',
};

export function isPrintTextFormat(value: unknown): value is PrintTextFormat {
  return typeof value === 'string' && (PRINT_TEXT_FORMATS as readonly string[]).includes(value);
}

/**
 * 渲染 print 文本类产物。抛错 = 入参校验失败（如 json 缺 schema），
 * 调用方按 VALIDATION_ERROR 落地。
 */
export async function renderPrintContent(
  format: PrintTextFormat,
  input: RenderPrintInput,
): Promise<RenderPrintResult> {
  const include = parseContentTypeWhitelist(input.include) ?? new Set<ContentType>();
  const filtered = filterHtmlByContentTypes(input.html ?? '', include);
  const extension = FORMAT_EXTENSIONS[format];

  switch (format) {
    case 'text': {
      const main = extractMainContent(filtered, input.url);
      return { content: stripHtmlTags(main), extension };
    }
    case 'markdown': {
      const td = await createTurndownInstance();
      return { content: postProcessMarkdown(td.turndown(filtered)), extension };
    }
    case 'html': {
      return { content: cleanHtml(filtered), extension };
    }
    case 'json': {
      if (input.schema === undefined || input.schema === null || input.schema === '') {
        throw new Error('print --as json 需要 --schema（JSON Schema 对象）');
      }
      const schema = parseJsonSchema(input.schema);
      const result = extractStructuredFromHtml({
        html: filtered,
        title: input.title,
        url: input.url,
        schema,
      });
      return {
        content: JSON.stringify(result.structured, null, 2),
        extension,
        warnings: result.warnings,
      };
    }
  }
}
