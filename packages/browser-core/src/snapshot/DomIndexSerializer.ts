/**
 * DomIndexSerializer — DOM 索引化序列化器
 *
 * 将 SoMService 收集的可交互元素列表序列化为 BrowserUse 风格的
 * 带索引文本格式，便于 Agent 理解页面结构并通过 index 引用元素。
 *
 * 输出格式：
 *   [1]<button>Submit</button>
 *   [2]<input placeholder="Search" type="text">Search field</input>
 *       [3]<a href="/logout">Logout</a>
 */

import type { SoMElement } from './SoMService';

const TEXT_TRUNCATE_LIMIT = 100;
const INDENT_UNIT = '    ';

const DISPLAY_ATTRIBUTES = new Set([
  'href', 'placeholder', 'type', 'role',
  'aria-expanded', 'aria-selected', 'disabled',
  // class 帮 Agent 判读无文本控件（图标翻页 / 加载更多），。
  'class',
]);

export interface DomIndexResult {
  text: string;
  indexMap: Map<number, SoMElement>;
}

export function serializeToDomIndex(elements: SoMElement[]): DomIndexResult {
  const indexMap = new Map<number, SoMElement>();
  if (elements.length === 0) {
    return { text: '', indexMap };
  }

  const minDepth = elements.reduce(
    (min, el) => Math.min(min, el.depth ?? 0),
    Infinity,
  );

  const lines: string[] = [];

  for (let i = 0; i < elements.length; i++) {
    const index = i + 1;
    const el = elements[i];
    indexMap.set(index, el);

    const relativeDepth = (el.depth ?? 0) - minDepth;
    const indent = INDENT_UNIT.repeat(relativeDepth);

    const attrStr = buildAttributeString(el);
    const text = truncateText(el.name || '', TEXT_TRUNCATE_LIMIT);

    lines.push(`${indent}[${index}]<${el.tag}${attrStr}>${text}</${el.tag}>`);
  }

  return { text: lines.join('\n'), indexMap };
}

function buildAttributeString(el: SoMElement): string {
  const parts: string[] = [];
  const attrs = el.attributes;

  if (attrs) {
    for (const key of Object.keys(attrs)) {
      if (DISPLAY_ATTRIBUTES.has(key)) {
        parts.push(`${key}="${escapeAttr(attrs[key])}"`);
      }
    }
  }

  if (el.role && !attrs?.role) {
    parts.push(`role="${escapeAttr(el.role)}"`);
  }

  return parts.length > 0 ? ' ' + parts.join(' ') : '';
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function truncateText(text: string, limit: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= limit) return cleaned;
  return cleaned.slice(0, limit - 3) + '...';
}
