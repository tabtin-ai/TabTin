/**
 * SnapshotService — 页面快照组合器
 *
 * 职责：按 include_* 标志按需组合各种格式的页面快照：
 * - raw_html / clean_html / skeleton_html
 * - accessibility_tree
 * - screenshot_base64
 * - som (Set-of-Mark 标注 + 截图)
 */

import type { RequestSnapshotInput } from '../types/browser';
import type { BrowserContext } from '../context/BrowserContext';
import { getSharedSoMService } from './SoMService';
import { getSharedAccessibilityTreeBuilder } from './AccessibilityTreeBuilder';
import { resolveHtmlCleanerAPI } from '../bridge';

export interface SnapshotData {
  url: string;
  title: string;
  raw_html?: string;
  clean_html?: string;
  skeleton_html?: string;
  accessibility_tree?: string;
  /** BR-17：`backendDOMNodeId → 唯一 xpath`，供 compact 快照按行尾句柄取精确 selector。 */
  xpath_map?: Record<string, string>;
  screenshot_base64?: string;
  som_screenshot_base64?: string;
  som_elements?: any[];
  dom_index?: string;
}

export class SnapshotService {
  async capture(ctx: BrowserContext, input: RequestSnapshotInput): Promise<SnapshotData> {
    const snapshot: SnapshotData = {
      url: ctx.getCurrentURL(),
      title: await ctx.getTitle(),
    };

    const needRawForCleaning = !!(input.include_clean_html || input.include_dom);
    const needRawHtml = !!(input.include_raw_html || needRawForCleaning);

    // 内容类型白名单（browser --include，）：仅作用于 HTML 内容输出，不碰 a11y 交互树。
    // undefined = 不过滤（内部调用方默认）；定义了（含空数组）才走过滤。宿主未注入过滤器则跳过。
    const htmlCleanerForFilter = resolveHtmlCleanerAPI();
    const includeTypes = input.include_content_types;
    const filterContent = (html: string | undefined): string | undefined => {
      if (html == null) return html;
      if (includeTypes === undefined) return html;
      if (!htmlCleanerForFilter?.filterHtmlByContentTypes) return html;
      return htmlCleanerForFilter.filterHtmlByContentTypes(html, includeTypes);
    };

    let rawHtml: string | undefined;
    if (needRawHtml) {
      try {
        rawHtml = await ctx.executeScript<string>(`document.documentElement.outerHTML`);
        if (input.include_raw_html) {
          snapshot.raw_html = filterContent(rawHtml);
        }
        console.log(`[SnapshotService] ✅ Raw HTML 已获取: ${rawHtml!.length} 字符`);
      } catch (htmlError) {
        console.error(`[SnapshotService] ⚠️ HTML 获取失败:`, htmlError);
      }
    }

    if (needRawForCleaning && rawHtml) {
      try {
        const htmlCleaner = htmlCleanerForFilter;
        if (!htmlCleaner) {
          console.warn('[SnapshotService] ⚠️ HtmlCleaner 未注入，跳过 clean/skeleton 生成');
        } else {
          const cleaned = htmlCleaner.cleanHtml(rawHtml);
          if (input.include_clean_html) {
            snapshot.clean_html = filterContent(cleaned);
            console.log(`[SnapshotService] ✅ Clean HTML 已生成: ${cleaned.length} 字符`);
          }
          if (input.include_dom === true) {
            // skeleton 在过滤后的 clean 基础上生成，保证被剥类型不残留在骨架里。
            const baseForSkeleton = filterContent(cleaned) ?? cleaned;
            const skeleton = htmlCleaner.generateSkeletonHtml(baseForSkeleton);
            snapshot.skeleton_html = skeleton;
            console.log(`[SnapshotService] ✅ Skeleton HTML 已生成: ${skeleton.length} 字符`);
          }
        }
      } catch (cleanError) {
        console.error('[SnapshotService] ⚠️ HTML 清洗/骨架生成失败:', cleanError);
      }
    }

    const includeA11y = input.include_accessibility_tree === true;
    const includeScreenshot = !!input.include_screenshot;

    const [a11yResult, screenshotResult] = await Promise.all([
      includeA11y ? (async () => {
        try {
          const builder = getSharedAccessibilityTreeBuilder();
          const result = await builder.buildWithXPath(ctx);
          return result.text ? result : undefined;
        } catch (atError) {
          console.error('[SnapshotService] ⚠️ Accessibility Tree 生成失败:', atError);
          return undefined;
        }
      })() : Promise.resolve(undefined),
      includeScreenshot ? (async () => {
        try {
          const buffer = await ctx.captureScreenshot({
            fullPage: input.full_page_screenshot,
            width: input.screenshot_width,
            format: 'jpeg',
            quality: 70,
          });
          return buffer;
        } catch (screenshotError) {
          console.error('[SnapshotService] ❌ 截图失败:', screenshotError);
          return undefined;
        }
      })() : Promise.resolve(undefined),
    ]);

    if (a11yResult) {
      snapshot.accessibility_tree = a11yResult.text;
      if (Object.keys(a11yResult.xpathMap).length > 0) {
        snapshot.xpath_map = a11yResult.xpathMap;
      }
      console.log(
        `[SnapshotService] ✅ Accessibility Tree 已生成: ${a11yResult.text.length} 字符，` +
        `${Object.keys(a11yResult.xpathMap).length} 个精确 xpath`,
      );
    }
    if (screenshotResult) {
      snapshot.screenshot_base64 = screenshotResult.toString('base64');
      console.log(`[SnapshotService] ✅ 截图完成 (${screenshotResult.length} bytes)`);
    }

    if (input.include_som === true) {
      try {
        const somService = getSharedSoMService();
        const somResult = await somService.captureAnnotated(ctx, {
          selector: input.selector,
          limit: input.limit ?? 100,
          fullPage: input.full_page_screenshot,
          width: input.screenshot_width,
        });
        if (somResult.elements.length > 0) {
          snapshot.som_elements = somResult.elements;
          snapshot.som_screenshot_base64 = somResult.screenshotBase64;
          console.log(`[SnapshotService] ✅ SoM 标注完成: ${somResult.elements.length} 个元素`);
        }
      } catch (somError) {
        console.error('[SnapshotService] ⚠️ SoM 标注失败:', somError);
      }
    }

    return snapshot;
  }
}

let shared: SnapshotService | null = null;

export function getSharedSnapshotService(): SnapshotService {
  if (!shared) shared = new SnapshotService();
  return shared;
}
