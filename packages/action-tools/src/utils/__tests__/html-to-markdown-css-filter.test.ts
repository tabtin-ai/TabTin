/**
 * BR-26 回归：browser markdown / page_to_markdown 提取不得混入 CSS / JS。
 *
 * 现象（dogfood Case 2）：对 https://example.com/ 的 markdown 以
 * `Example Domainbody{background:#eee;width:60vw;...}` 开头——页面 <style> 里的
 * CSS 文本被拼进了正文。根因是共享工厂 createConfiguredTurndown 的 removeElements
 * 未剥离 <style>/<script>/<head> 等非正文节点，Turndown 默认输出其文本内容。
 *
 * 这里直接走 createTurndownInstance（与双端 browser markdown 完全同一条转换链路），
 * 喂整页 outerHTML，断言输出 markdown 不含 CSS / JS 片段、但保留正文。
 */

import { describe, it, expect } from 'vitest';
import { createTurndownInstance } from '../html-to-markdown';

// 模拟 example.com 的完整文档：head 里有 <title> + <style>，body 是正文
const EXAMPLE_COM_HTML = `<!doctype html>
<html>
<head>
  <title>Example Domain</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="stylesheet" href="/styles.css" />
  <style type="text/css">
  body { background-color: #f0f0f2; margin: 0; padding: 0; width: 60vw; }
  div { width: 600px; margin: 5em auto; }
  a:link, a:visited { color: #38488f; text-decoration: none; }
  </style>
</head>
<body>
<div>
  <h1>Example Domain</h1>
  <p>This domain is for use in illustrative examples in documents.</p>
  <p><a href="https://www.iana.org/domains/example">More information...</a></p>
</div>
</body>
</html>`;

// body 内联 <style> / <script> / <noscript> 的脏页面（很多站点这么写）
const INLINE_NOISE_HTML = `<html><body>
  <h1>Real Title</h1>
  <style>.ad{display:none}.banner{background:#eee;height:50px}</style>
  <p>Body paragraph one.</p>
  <script>window.__data={a:1};console.log("tracking pixel");</script>
  <noscript>Please enable JavaScript to view this site.</noscript>
  <p>Body paragraph two.</p>
</body></html>`;

describe('createTurndownInstance — BR-26 CSS/JS 过滤', () => {
  it('整页 outerHTML（example.com 形态）不得把 <head> 的 CSS 混入正文', async () => {
    const td = await createTurndownInstance();
    const markdown = td.turndown(EXAMPLE_COM_HTML);

    // CSS 片段一律不得出现
    expect(markdown).not.toContain('body {');
    expect(markdown).not.toContain('body{');
    expect(markdown).not.toContain('background-color');
    expect(markdown).not.toContain('#f0f0f2');
    expect(markdown).not.toContain('60vw');
    expect(markdown).not.toContain('text-decoration');
    // <style>/<head> 的原始标签噪音也不应残留
    expect(markdown).not.toContain('type="text/css"');

    // 正文必须保留
    expect(markdown).toContain('Example Domain');
    expect(markdown).toContain('This domain is for use in illustrative examples');
    expect(markdown).toContain('More information');
  });

  it('body 内联 <style>/<script>/<noscript> 不得混入正文', async () => {
    const td = await createTurndownInstance();
    const markdown = td.turndown(INLINE_NOISE_HTML);

    // CSS
    expect(markdown).not.toContain('.ad{');
    expect(markdown).not.toContain('.banner');
    expect(markdown).not.toContain('display:none');
    // JS
    expect(markdown).not.toContain('window.__data');
    expect(markdown).not.toContain('console.log');
    expect(markdown).not.toContain('tracking pixel');
    // noscript 噪音
    expect(markdown).not.toContain('Please enable JavaScript');

    // 正文必须保留
    expect(markdown).toContain('Real Title');
    expect(markdown).toContain('Body paragraph one.');
    expect(markdown).toContain('Body paragraph two.');
  });
});
