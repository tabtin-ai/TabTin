/**
 * Turndown 统一工厂 + HTML → Markdown 转换
 *
 * 核心导出：
 * 1. createConfiguredTurndown — 统一的 Turndown 实例工厂
 * 2. htmlToMarkdown — HTML → Markdown（自动获取 Turndown，不可用时降级纯文本）
 * 3. postProcessMarkdown — Markdown 后处理（借鉴 Firecrawl）
 *
 * Turndown + joplin-turndown-plugin-gfm 均为 action-tools 的直接依赖，
 * 通过延迟 import + Promise 单例消除并发竞态和启动开销。
 */

// ── Turndown 工厂 ───────────────────────────────────────────

export interface TurndownOptions {
  /** 移除所有 img 标签（默认保留） */
  removeImages?: boolean;
  /** 移除链接只保留文本 */
  removeLinks?: boolean;
  /** 移除音视频等媒体标签（默认保留） */
  removeMedia?: boolean;
  /** 移除表格（默认保留；剥离后表格内容不再出现在 markdown） */
  removeTables?: boolean;
  /** GFM 插件（传入 joplin-turndown-plugin-gfm 的 gfm 导出） */
  gfm?: any;
}

/**
 * 创建一个预配置的 Turndown 实例。
 * 调用方需传入 Turndown 构造函数（支持外部控制 import 时机）。
 */
export function createConfiguredTurndown(
  TurndownConstructor: any,
  options?: TurndownOptions,
): any {
  const td = new TurndownConstructor({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });

  // 非正文 / 不可见节点：必须剥离，否则 Turndown 默认会把它们的文本内容
  // （如 <style> 的 CSS、<script> 的 JS）当作正文输出，污染 markdown。
  // 该工厂被 browser markdown / page_to_markdown 直接喂整页 outerHTML，
  // 其中 <head>（含 title/style/meta/link）与 body 内联 <style>/<script> 都会触发此问题。
  const removeElements = [
    'svg', 'button', 'input', 'select', 'form', 'textarea',
    'style', 'script', 'noscript', 'template',
    'head', 'title', 'link', 'meta', 'base',
    'iframe', 'object', 'embed', 'applet',
  ];
  if (options?.removeImages) removeElements.push('img', 'picture');
  if (options?.removeMedia) removeElements.push('video', 'audio', 'source', 'track');
  if (options?.removeTables) removeElements.push('table');
  td.remove(removeElements);

  if (options?.removeLinks) {
    td.addRule('stripLinks', {
      filter: 'a',
      replacement: (_content: string, node: any) => node.textContent || '',
    });
  }

  if (options?.gfm) {
    td.use(options.gfm);
  }

  td.addRule('codeLineNumberTable', {
    filter: (node: any) => {
      if (node.nodeName !== 'TABLE') return false;
      const rows = node.querySelectorAll('tr');
      if (rows.length < 2) return false;
      for (let i = 0; i < Math.min(rows.length, 5); i++) {
        const firstCell = rows[i].querySelector('td');
        if (!firstCell || !/^\s*\d+\s*$/.test(firstCell.textContent || '')) return false;
      }
      return true;
    },
    replacement: (_content: string, node: any) => {
      const lines: string[] = [];
      node.querySelectorAll('tr').forEach((row: any) => {
        const cells = row.querySelectorAll('td');
        const codeCell = cells.length >= 2 ? cells[1] : cells[0];
        if (codeCell) lines.push(codeCell.textContent || '');
      });
      return '\n```\n' + lines.join('\n') + '\n```\n';
    },
  });

  return td;
}

// ── Promise 单例（延迟 import，消除并发竞态）─────────────────

let _turndownPromise: Promise<any> | null = null;

function getOrCreateTurndown(): Promise<any> {
  if (!_turndownPromise) {
    _turndownPromise = (async () => {
      const turndownModule: any = await import('turndown');
      const TurndownService = turndownModule.default ?? turndownModule;
      const gfmModule: any = await import('joplin-turndown-plugin-gfm');
      const gfmPlugin = gfmModule.gfm ?? gfmModule.default?.gfm;
      return createConfiguredTurndown(TurndownService, { gfm: gfmPlugin });
    })().catch((err) => {
      _turndownPromise = null;
      throw err;
    });
  }
  return _turndownPromise;
}

// ── HTML → Markdown ─────────────────────────────────────────

/**
 * 将 HTML 转为 Markdown。自动获取内部 Turndown 单例，
 * 加载失败时降级为纯文本（剥离标签）。
 */
export async function htmlToMarkdown(html: string): Promise<string> {
  try {
    const td = await getOrCreateTurndown();
    return td.turndown(html);
  } catch (err) {
    console.warn('[html-to-markdown] Turndown unavailable, falling back to plain text:', err);
    return html
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
}

/**
 * 异步工厂：创建一个带自定义选项的 Turndown 实例。
 * 内部处理 turndown + joplin-turndown-plugin-gfm 的延迟 import，
 * 调用方无需自行管理 import。
 *
 * 用于 page_to_markdown / browser markdown 等需要按参数控制
 * removeImages / removeLinks 的场景。
 */
export async function createTurndownInstance(options?: TurndownOptions): Promise<any> {
  const turndownModule: any = await import('turndown');
  const TurndownService = turndownModule.default ?? turndownModule;
  const gfmModule: any = await import('joplin-turndown-plugin-gfm');
  const gfmPlugin = gfmModule.gfm ?? gfmModule.default?.gfm;
  return createConfiguredTurndown(TurndownService, { gfm: gfmPlugin, ...options });
}

// ── Markdown 后处理（借鉴 Firecrawl）────────────────────────

export function postProcessMarkdown(md: string): string {
  let result = md;

  // 循环修复多行链接：[text\nmore](url) → [text more](url)
  let prev = '';
  while (prev !== result) {
    prev = result;
    result = result.replace(/\[([^\]]*)\n([^\]]*)\]/g, '[$1 $2]');
  }

  // 移除 "Skip to content" 链接
  result = result.replace(/\[Skip to (?:main )?content\]\([^)]*\)/gi, '');

  // 压缩连续空行（4+ → 3）
  result = result.replace(/\n{4,}/g, '\n\n\n');

  // 去掉行尾空白
  result = result.replace(/[ \t]+$/gm, '');

  return result;
}
