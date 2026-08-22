import { describe, it, expect } from 'vitest';
import { AccessibilityTreeBuilder } from '../AccessibilityTreeBuilder';
import { buildCompactSnapshot } from '../compact-snapshot';

// CDP Accessibility node 的最小构造器（对齐 getFullAXTree 返回的 node 形状）。
function node(
  nodeId: string,
  role: string,
  name: string,
  childIds: string[] = [],
  properties: any[] = [],
  backendDOMNodeId?: number,
) {
  return {
    nodeId,
    role: { value: role },
    name: { value: name },
    childIds,
    properties,
    ...(backendDOMNodeId != null ? { backendDOMNodeId } : {}),
  };
}

/** 最小 DOM 节点（对齐 DOM.getDocument 返回的 node 形状）。 */
function dom(
  localName: string,
  backendNodeId: number,
  children: any[] = [],
) {
  return { nodeType: 1, localName, backendNodeId, children };
}

/** 伪造一个只会回应 builder 所需 CDP 方法的 BrowserContext。 */
function mockCtx(axNodes: any[], domRoot: any) {
  return {
    sendCDP: async (method: string) => {
      if (method === 'Accessibility.getFullAXTree') return { nodes: axNodes };
      if (method === 'DOM.getDocument') return { root: domRoot };
      return {};
    },
  } as any;
}

describe('AccessibilityTreeBuilder.toText（BR-14：跳过包装节点但保留子树）', () => {
  const builder = new AccessibilityTreeBuilder();

  it('generic 无名包装层不显示自身、但其交互子节点必须 hoist 出来（修前会整棵丢）', () => {
    // RootWebArea → generic(无名 div 包装) → [link, button]
    // 现代页面真实形态：RootWebArea 的直接子节点是 generic 容器。
    const nodes = [
      node('1', 'RootWebArea', 'Example', ['2']),
      node('2', 'generic', '', ['3', '4']), // 无名包装层
      node('3', 'link', 'Home'),
      node('4', 'button', 'Submit'),
    ];
    const text = builder.toText(nodes);

    // 修前：只剩 "[RootWebArea] Example"；修后：link/button 必须出现。
    expect(text).toContain('[RootWebArea] Example');
    expect(text).toContain('[link] Home');
    expect(text).toContain('[button] Submit');
  });

  it('多层 generic 嵌套也能一路 hoist 到交互叶子', () => {
    // RootWebArea → generic → generic → textbox
    const nodes = [
      node('1', 'RootWebArea', 'Page', ['2']),
      node('2', 'generic', '', ['3']),
      node('3', 'generic', '', ['4']),
      node('4', 'textbox', 'Search'),
    ];
    const text = builder.toText(nodes);
    expect(text).toContain('[textbox] Search');
  });

  it('SKIP_ROLES（如 none/presentational）也跳行但保留子树', () => {
    const nodes = [
      node('1', 'RootWebArea', 'Page', ['2']),
      node('2', 'none', '', ['3']), // presentational 容器
      node('3', 'link', 'Docs'),
    ];
    const text = builder.toText(nodes);
    expect(text).toContain('[link] Docs');
  });

  it('真叶子（无名、无子、非交互）仍被丢弃（无子树可保留）', () => {
    const nodes = [
      node('1', 'RootWebArea', 'Page', ['2', '3']),
      node('2', 'generic', ''), // 无名无子 → 丢
      node('3', 'link', 'Keep'),
    ];
    const text = builder.toText(nodes);
    expect(text).toContain('[link] Keep');
    // 无名 generic 叶子不该产生空行噪声
    expect(text).not.toMatch(/\[generic\]\s*$/m);
  });

  it('保留命名节点的层级缩进（包装层 hoist 不缩进，命名节点正常缩进）', () => {
    const nodes = [
      node('1', 'RootWebArea', 'Page', ['2']),
      node('2', 'navigation', 'Main', ['3']), // 命名 → 显示 + 子节点缩进
      node('3', 'link', 'Home'),
    ];
    const text = builder.toText(nodes);
    const lines = text.split('\n');
    expect(lines[0]).toBe('[RootWebArea] Page');
    expect(lines[1]).toBe('  [navigation] Main');
    expect(lines[2]).toBe('    [link] Home');
  });

  it('toText（不传 xpath 映射）保持干净——不 emit 任何 {b...} 句柄（back-compat）', () => {
    const nodes = [
      node('1', 'RootWebArea', 'Page', ['2'], [], 1),
      node('2', 'link', 'Home', [], [], 10),
    ];
    const text = builder.toText(nodes);
    expect(text).not.toMatch(/\{b\d+\}/);
  });
});

describe('AccessibilityTreeBuilder.buildWithXPath（BR-17：句柄 + 唯一精确 xpath）', () => {
  const builder = new AccessibilityTreeBuilder();

  // RootWebArea → generic(无名包装) → [link, link(同名), button]
  const axNodes = [
    node('1', 'RootWebArea', 'News', ['2'], [], 1),
    node('2', 'generic', '', ['3', '4', '5'], [], 2),
    node('3', 'link', 'Hacker News', [], [], 10),
    node('4', 'link', 'Hacker News', [], [], 11), // 重复文本
    node('5', 'button', 'Submit', [], [], 12),
  ];
  const domRoot = {
    nodeType: 9,
    children: [
      dom('html', 1, [
        dom('body', 2, [
          dom('a', 10),
          dom('a', 11),
          dom('button', 12),
        ]),
      ]),
    ],
  };

  it('按 backendNodeId 算出同 document.evaluate 语义的唯一 xpath（同名 tag 用 [1]/[2] 索引）', async () => {
    const { xpathMap } = await builder.buildWithXPath(mockCtx(axNodes, domRoot));
    expect(xpathMap['10']).toBe('/html[1]/body[1]/a[1]');
    expect(xpathMap['11']).toBe('/html[1]/body[1]/a[2]');
    expect(xpathMap['12']).toBe('/html[1]/body[1]/button[1]');
    expect(xpathMap['10']).not.toBe(xpathMap['11']);
  });

  it('文本给有 xpath 的节点行尾 emit {b<backendId>} 句柄', async () => {
    const { text } = await builder.buildWithXPath(mockCtx(axNodes, domRoot));
    expect(text).toContain('[link] Hacker News {b10}');
    expect(text).toContain('[link] Hacker News {b11}');
    expect(text).toContain('[button] Submit {b12}');
  });

  it('端到端：buildWithXPath → buildCompactSnapshot，重复文本 eN 拿到不同精确 selector', async () => {
    const { text, xpathMap } = await builder.buildWithXPath(mockCtx(axNodes, domRoot));
    const snap = buildCompactSnapshot('https://news.ycombinator.com', 'HN', text, xpathMap);

    const links = snap.elements.filter((e) => e.name === 'Hacker News');
    expect(links).toHaveLength(2);
    expect(links[0].selector).toBe('xpath=/html[1]/body[1]/a[1]');
    expect(links[1].selector).toBe('xpath=/html[1]/body[1]/a[2]');
    expect(links[0].selector).not.toBe(links[1].selector);
  });

  it('DOM.getDocument 失败时降级：无 xpath、无句柄，文本仍可用（compact 退回 has-text）', async () => {
    const ctx = {
      sendCDP: async (method: string) => {
        if (method === 'Accessibility.getFullAXTree') return { nodes: axNodes };
        if (method === 'DOM.getDocument') throw new Error('boom');
        return {};
      },
    } as any;
    const { text, xpathMap } = await builder.buildWithXPath(ctx);
    expect(Object.keys(xpathMap)).toHaveLength(0);
    expect(text).not.toMatch(/\{b\d+\}/);
    expect(text).toContain('[link] Hacker News');
  });
});
