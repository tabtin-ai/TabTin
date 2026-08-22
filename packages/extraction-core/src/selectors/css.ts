import type { CheerioAPI, Cheerio } from 'cheerio';

// cheerio 1.x 不直接导出 AnyNode，用 any 做泛型参数
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CheerioEl = Cheerio<any>;

/**
 * 解析选择器（支持字符串或数组 fallback），在给定上下文中查找匹配元素。
 * context 为 null 时在整个文档中搜索。
 */
export function resolveSelector(
  $: CheerioAPI,
  context: CheerioEl | null,
  selector: string | string[],
): CheerioEl | null {
  const selectors = Array.isArray(selector) ? selector : [selector];

  for (const sel of selectors) {
    try {
      const elements = context ? context.find(sel) : $(sel);
      if (elements.length > 0) return elements;
    } catch {
      continue;
    }
  }

  return null;
}

export function textOf($: CheerioAPI, el: CheerioEl): string {
  return el.text();
}

export function attrOf(el: CheerioEl, attr: string): string | undefined {
  return el.attr(attr);
}

export function htmlOf(el: CheerioEl): string | null {
  return el.html();
}
