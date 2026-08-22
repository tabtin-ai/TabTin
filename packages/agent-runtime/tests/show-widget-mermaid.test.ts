/**
 * mermaid-compiler 测试（P0 波修复 2026-04-30）
 *
 * 覆盖 P0-4 信任边界分层：
 *   - 真实 Mermaid 源码编译后 label 文字保留
 *   - 编译产物 defense-in-depth：即使理论上 Mermaid 吐 script 也仍会被 scrub 清掉
 */

import { describe, it, expect } from 'vitest'
import { prepareWidgetSource } from '../src/tools/show-widget/mermaid-compiler.js'

function readViewBoxSize(svg: string): { width: number; height: number } {
  const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1]
  const [, , width = Number.NaN, height = Number.NaN] = viewBox?.split(/\s+/).map(Number) ?? []
  return { width, height }
}

function expectRenderableViewport(svg: string): void {
  const { width, height } = readViewBoxSize(svg)
  expect(svg).not.toContain('translate(undefined, NaN)')
  expect(svg).not.toMatch(/max-width\s*:\s*96px/i)
  expect(width).toBeGreaterThan(0)
  expect(height).toBeGreaterThan(0)
}

describe('prepareWidgetSource — Mermaid 编译 + P0-4 trustedOrigin 集成', () => {
  it('真实 Mermaid flowchart 编译后保留节点 label 文字', async () => {
    const source = 'graph TD; A[登录] --> B[支付]'
    const prepared = await prepareWidgetSource('mermaid', source)

    expect(prepared.renderFormat).toBe('svg')
    expect(prepared.renderCode).toContain('<svg')
    // **核心断言**：label 文字真的保留下来，用户不能只看到空框 + 连线。
    expect(prepared.renderCode).toContain('登录')
    expect(prepared.renderCode).toContain('支付')
    expectRenderableViewport(prepared.renderCode)
    expect(prepared.sourceCode).toBe(source)
  })

  it('Mermaid sequence 图编译后保留节点 + 消息 label', async () => {
    const source = 'sequenceDiagram\n  Alice->>Bob: 请求\n  Bob-->>Alice: 响应'
    const prepared = await prepareWidgetSource('mermaid', source)
    expect(prepared.renderFormat).toBe('svg')
    expect(prepared.renderCode).toContain('Alice')
    expect(prepared.renderCode).toContain('Bob')
    expect(prepared.renderCode).toContain('请求')
    expect(prepared.renderCode).toContain('响应')
    expectRenderableViewport(prepared.renderCode)
  })

  it('Mermaid ER 图编译后保留实体名', async () => {
    const source = 'erDiagram\n  USER ||--o{ ORDER : places\n  ORDER ||--|{ ITEM : contains'
    const prepared = await prepareWidgetSource('mermaid', source)
    expect(prepared.renderCode).toContain('<svg')
    expect(prepared.renderCode).toContain('USER')
    expect(prepared.renderCode).toContain('ORDER')
    expect(prepared.renderCode).toContain('ITEM')
    expectRenderableViewport(prepared.renderCode)
  })

  // **反向安全断言**（独立验证 Agent 视角）：
  //
  // 假设 Mermaid 编译器未来升级引入 bug 直接吐 `<script>`（securityLevel:strict
  // + hasDangerousMermaidSource 理论上拦截，但 defense-in-depth 仍守）——
  // scrubSvg 的 script 清洗应该**即使 trustedOrigin=true 仍然生效**。
  //
  // 单独验证 mermaid-compiler 通过 scrubSvg 调 `{ trustedOrigin: true }` 时，
  // script 仍被清——这个验证在 show-widget-sanitizer.test.ts 已经做过端到端
  // （直接调 scrubSvg 传 trustedOrigin:true 验证 script 被清）。这里补一个
  // "mermaid 编译后产出不含 script" 的断言作为集成测试。
  it('Mermaid 编译产物不含 <script>（securityLevel:strict 前置 + scrub 兜底）', async () => {
    const source = 'graph TD; A[安全节点] --> B[另一节点]'
    const prepared = await prepareWidgetSource('mermaid', source)
    expect(prepared.renderCode.toLowerCase()).not.toContain('<script')
    expect(prepared.renderCode.toLowerCase()).not.toContain('javascript:')
    expect(prepared.renderCode).not.toMatch(/\son[a-z]+=/i)
  })

  it('Mermaid 源码被 hasDangerousMermaidSource 前置拦住 → prepare 抛错不 compile', async () => {
    await expect(
      prepareWidgetSource('mermaid', 'graph TD; A-->B; click A "javascript:alert(1)"'),
    ).rejects.toThrow(/javascript|click/i)
  })

  it('复杂 flowchart 不应产出裁空画布（viewBox 覆盖实际节点/边）', async () => {
    const source = `flowchart TD
    A["美国联邦政府\\nFederal Government"] --> L["立法分支\\nLegislative Branch"]
    A --> E["行政分支\\nExecutive Branch"]
    A --> J["司法分支\\nJudicial Branch"]

    L --> L1["参议院 Senate\\n100席"]
    L --> L2["众议院 House\\n435席"]

    E --> E1["总统 President"]
    E --> E2["副总统 Vice President"]
    E --> E3["内阁 Cabinet"]

    J --> J1["最高法院 Supreme Court\\n9位大法官"]
    J --> J2["联邦上诉法院 Circuit Courts"]
    J --> J3["联邦地区法院 District Courts"]

    L -.立法/拨款/弹劾.-> E
    L -.参议院确认法官.-> J
    E -.否决法案.-> L
    E -.提名法官.-> J
    J -.司法审查/裁定违宪.-> L
    J -.司法审查/裁定违宪.-> E

    classDef fed fill:#1a365d,stroke:none,color:#fff,font-weight:bold
    classDef leg fill:#c53030,stroke:none,color:#fff,font-weight:bold
    classDef exec fill:#2b6cb0,stroke:none,color:#fff,font-weight:bold
    classDef jud fill:#276749,stroke:none,color:#fff,font-weight:bold

    class A fed
    class L,L1,L2 leg
    class E,E1,E2,E3 exec
    class J,J1,J2,J3 jud`

    const prepared = await prepareWidgetSource('mermaid', source)
    const { width, height } = readViewBoxSize(prepared.renderCode)

    expect(prepared.renderCode).toContain('美国联邦政府')
    expectRenderableViewport(prepared.renderCode)
    expect(width).toBeGreaterThan(600)
    expect(height).toBeGreaterThan(300)
  })
})
