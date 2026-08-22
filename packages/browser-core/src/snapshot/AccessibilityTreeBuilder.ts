/**
 * AccessibilityTreeBuilder — 无障碍树文本构建
 *
 * 职责：
 * - 通过 CDP 获取完整 Accessibility Tree
 * - 将 AX 节点树转为缩进纯文本表示
 * - BR-17：为每个有对应 DOM 元素的交互节点解析出**确定性、唯一**的 XPath，
 *   并在行尾 emit 一个稳定句柄 `{b<backendDOMNodeId>}`，让 compact 快照能按句柄
 *   直接取精确 selector，绕开有损的名字字符串匹配（重复文本元素也能稳定命中）。
 */

import type { BrowserContext } from '../context/BrowserContext';

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox',
  'slider', 'switch', 'tab', 'menuitem', 'option', 'searchbox',
  'listbox', 'select', 'spinbutton', 'scrollbar',
]);

const SKIP_ROLES = new Set(['none', 'InlineTextBox', 'LineBreak']);

const AX_BOOL_PROPS = new Set(['focused', 'disabled', 'checked', 'expanded', 'required']);

/** 单次 build 的结构化产物：带句柄的 a11y 文本 + `backendDOMNodeId → 唯一 xpath` 映射。 */
export interface AccessibilityBuildResult {
  /** 缩进文本；交互节点行尾带 `{b<backendDOMNodeId>}` 句柄（仅当解析出 xpath 时）。 */
  text: string;
  /** `String(backendDOMNodeId) → 绝对 xpath`，仅含真正 emit 进文本的节点。 */
  xpathMap: Record<string, string>;
}

/** 最小 DOM 节点形状（对齐 `DOM.getDocument` 返回的 node）。 */
interface DomNode {
  backendNodeId?: number;
  nodeType?: number;
  nodeName?: string;
  localName?: string;
  children?: DomNode[];
}

export class AccessibilityTreeBuilder {
  async build(
    ctx: BrowserContext,
    options?: { maxNodes?: number; timeoutMs?: number; maxChars?: number },
  ): Promise<string> {
    return (await this.buildWithXPath(ctx, options)).text;
  }

  /**
   * 取 AX 树 + 主框架 DOM，产出带句柄的文本与 `backendDOMNodeId → xpath` 映射。
   *
   * XPath 只覆盖**主框架同文档树**（不 pierce iframe / shadow DOM）——这些 xpath 才能被
   * `document.evaluate` / `DOM.performSearch` 回解（act 的两条解析路径都基于此）。iframe /
   * shadow 内元素拿不到 xpath（不 emit 句柄），compact 会退回 id/has-text，行为不回退。
   */
  async buildWithXPath(
    ctx: BrowserContext,
    options?: { maxNodes?: number; timeoutMs?: number; maxChars?: number },
  ): Promise<AccessibilityBuildResult> {
    const { maxNodes = 2000, timeoutMs = 10000, maxChars = 30000 } = options ?? {};

    await ctx.sendCDP('Accessibility.enable');
    await ctx.sendCDP('DOM.enable');
    try {
      const [axResult, backendIdToXPath] = await Promise.all([
        Promise.race([
          ctx.sendCDP<{ nodes?: any[] }>('Accessibility.getFullAXTree', { depth: -1 }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Accessibility tree timeout')), timeoutMs),
          ),
        ]).catch((err: Error) => {
          if (err.message.includes('timeout')) return { nodes: [] as any[] };
          throw err;
        }),
        this.buildBackendIdToXPath(ctx, timeoutMs),
      ]);

      const allNodes = axResult?.nodes || [];
      const totalCount = allNodes.length;
      const truncatedByNodes = totalCount > maxNodes;
      const nodes = truncatedByNodes ? allNodes.slice(0, maxNodes) : allNodes;

      const rendered = this.render(nodes, backendIdToXPath);
      let text = rendered.text;

      if (text.length > maxChars) {
        text = text.substring(0, maxChars);
        text += `\n[... 文本已截断至 ${maxChars} 字符]`;
      }

      if (truncatedByNodes) {
        text += `\n[... 已截断，共 ${totalCount} 个节点，显示前 ${maxNodes} 个]`;
      }

      return { text, xpathMap: rendered.xpathMap };
    } finally {
      await ctx.sendCDP('Accessibility.disable').catch(() => {});
    }
  }

  toText(nodes: any[]): string {
    return this.render(nodes).text;
  }

  /**
   * 渲染 AX 树为缩进文本。传入 `backendIdToXPath` 时，给能解析出 xpath 的节点行尾追加
   * `{b<backendDOMNodeId>}` 句柄，并把命中条目收进返回的 `xpathMap`。
   */
  private render(nodes: any[], backendIdToXPath?: Map<number, string>): AccessibilityBuildResult {
    if (!nodes || nodes.length === 0) return { text: '', xpathMap: {} };

    const idToNode = new Map<string, any>();
    for (const n of nodes) {
      idToNode.set(n.nodeId, n);
    }

    const lines: string[] = [];
    const xpathMap: Record<string, string> = {};

    const walk = (nodeId: string, depth: number) => {
      const node = idToNode.get(nodeId);
      if (!node) return;

      const role: string = node.role?.value || '';
      const name: string = node.name?.value || '';
      const childIds: string[] = node.childIds || [];

      // BR-14：这些节点不值得单独显示一行（presentational / 无名包装层），但**子树必须保留**。
      // 现代页面层层 generic <div>/<span> 包裹真内容，旧实现在这里直接 return → 整棵内容子树
      // 被剪掉、a11y 文本只剩 [RootWebArea]。改为「跳过本行、但继续递归子节点并 hoist 到当前
      // 深度」，让 link/button/input 等交互元素照样出现在文本里（compact 解析的唯一来源）。
      const skipLineButKeepSubtree =
        SKIP_ROLES.has(role) || (role === 'generic' && !name);
      if (skipLineButKeepSubtree) {
        for (const cid of childIds) {
          walk(cid, depth);
        }
        return;
      }

      // 真叶子（无名、无子、非交互）：无子树可保留，直接丢。
      if (!name && childIds.length === 0 && !INTERACTIVE_ROLES.has(role)) return;

      const attrs: string[] = [];
      const props: any[] = node.properties || [];
      for (const p of props) {
        const pName: string = p.name || '';
        if (AX_BOOL_PROPS.has(pName) && p.value?.value === true) {
          attrs.push(pName);
        }
        if (pName === 'value' && p.value?.value != null && p.value.value !== '') {
          attrs.push(`value="${p.value.value}"`);
        }
      }

      const indent = '  '.repeat(depth);
      const attrStr = attrs.length > 0 ? ` [${attrs.join(', ')}]` : '';
      const nameStr = name ? ` ${name}` : '';

      let handle = '';
      const backendId: unknown = node.backendDOMNodeId;
      if (backendIdToXPath && typeof backendId === 'number') {
        const xpath = backendIdToXPath.get(backendId);
        if (xpath) {
          xpathMap[String(backendId)] = xpath;
          handle = ` {b${backendId}}`;
        }
      }

      lines.push(`${indent}[${role}]${nameStr}${attrStr}${handle}`);

      for (const cid of childIds) {
        walk(cid, depth + 1);
      }
    };

    if (nodes.length > 0) {
      walk(nodes[0].nodeId, 0);
    }

    return { text: lines.join('\n'), xpathMap };
  }

  /**
   * 一次 `DOM.getDocument(depth:-1)` 拉主框架完整 DOM，算出每个元素的唯一绝对 XPath。
   *
   * 同 `document.evaluate` 语义：index 按**同名元素兄弟**从 1 计、tag 用小写（HTML 文档里
   * XPath 名字测试匹配小写）。返回 `backendNodeId → /html[1]/body[1]/.../a[2]`。
   * 单次 round-trip + 纯遍历，适配 800+ 节点（不逐节点往返）。
   */
  private async buildBackendIdToXPath(
    ctx: BrowserContext,
    timeoutMs: number,
  ): Promise<Map<number, string>> {
    const map = new Map<number, string>();
    try {
      const doc = await Promise.race([
        ctx.sendCDP<{ root?: DomNode }>('DOM.getDocument', { depth: -1 }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('DOM.getDocument timeout')), timeoutMs),
        ),
      ]);
      const root = doc?.root;
      if (!root) return map;

      const walk = (node: DomNode, parentPath: string) => {
        const children = node.children;
        if (!children || children.length === 0) return;
        const counters: Record<string, number> = {};
        for (const child of children) {
          // 只给元素节点（nodeType 1）算 xpath；文本/注释等无 xpath、也无元素子节点。
          if (child.nodeType !== 1) continue;
          const tag = (child.localName || child.nodeName || '').toLowerCase();
          if (!tag) continue;
          counters[tag] = (counters[tag] || 0) + 1;
          const path = `${parentPath}/${tag}[${counters[tag]}]`;
          if (typeof child.backendNodeId === 'number') {
            map.set(child.backendNodeId, path);
          }
          walk(child, path);
        }
      };

      // root 是 #document（nodeType 9），其元素子节点是 <html>；不递归 contentDocument /
      // shadowRoots（未在 children 内、且跨框架/影子树 xpath 无法被 document.evaluate 回解）。
      walk(root, '');
    } catch (err) {
      console.warn('[AccessibilityTreeBuilder] ⚠️ XPath 映射构建失败（compact 将退回 id/has-text）:', err);
    }
    return map;
  }
}

let shared: AccessibilityTreeBuilder | null = null;

export function getSharedAccessibilityTreeBuilder(): AccessibilityTreeBuilder {
  if (!shared) shared = new AccessibilityTreeBuilder();
  return shared;
}
