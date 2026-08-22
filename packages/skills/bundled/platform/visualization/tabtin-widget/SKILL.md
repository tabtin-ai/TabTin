---
name: tabtin-widget
description: >
  渲染可视化组件——用 show_widget 编译 SVG / HTML(no-script)
  / Mermaid 图做自由可视化。内容能落 present_to_user
  4 类 kind → 不用 widget；长期可编辑产物 → TabData/
  TabDoc/TabSlide。
metadata:
  version: 1.0.0
  tabtin:
    category: media
    autoActivateFor: []
    tags:
      - widget
      - visualization
      - svg
      - html
      - mermaid
      - chart
      - diagram
      - mockup
    tools:
      - show_widget
---

# tabtin-widget

`show_widget` 用来在 chat 内画一次性视觉内容：安全、美观、可下钻；不是文件、表格、文档或小应用。

## 资源导航

本 Skill 带有 `examples/` 目录。遇到具体样式不确定、需要复用成熟图形模式，或用户要求“给我一个图/流程/架构/UI mockup”时，先按需读取对应示例：

- Mermaid / SVG 图：参考 `examples/git-rebase-merge-mermaid.md`、`examples/sales-q3-mermaid-or-svg.md`、`examples/mermaid-er.md`、`examples/k8s-architecture-svg.md`
- HTML no-script mockup：参考 `examples/settings-page-html.md`、`examples/html-stepper.md`
- 可点击追问：参考 `examples/purchase-journey-sendprompt.md`

## 先判定

1. 现成 image/table_preview/resource_ref/file 能表达 → 用 `present_to_user`。
2. 用户要长期编辑/复用 → 用 TabData / TabDoc / TabSlide。
3. 一两段文字说得清 → 直接答。
4. 空间关系、流程、数据洞察、UI mockup、可点击下钻 → 用 `show_widget`。详见 `decision-tree.md`。

装饰图、普通总结、原始表格、已有图片 URL 不用 widget。

## 选格式

| format | 用它 | 别用它 |
|---|---|---|
| `svg` | 架构图、柱状图、几何图、需要 `sendPrompt` 的节点 | 大量规则节点图 |
| `html` | 静态设置页、stepper、卡片/网格 mockup | 脚本、真实表单、复杂滚动页 |
| `mermaid` | flowchart / sequence / ER / Gantt | 像素级 UI、点击交互 |

Mermaid 传源码，工具执行时编译成 SVG；不要自己加载 runtime。

## 工具输入

```ts
show_widget({
  title?: string,
  summary: string,              // 必填：移动端 fallback + a11y
  format: "svg" | "html" | "mermaid",
  loading_message?: string,     // 推荐放在 code 前输出
  code: string,                 // ≤8KB
  group_id?: string,
  group_title?: string,
})
```

`summary` 不是标题，写成无图也能懂的一句话：`Q3 区域销售柱状图：华东 320 万领先，华南 280 万次之，西部最低。` 不要写 `销售图`。`loading_message` 写用户看得懂的短句：`正在生成 Q3 销售对比图...`。

## sendPrompt

只有“点了会开启新一轮对话”的元素能用 `sendPrompt(text, meta?)`。`text` 是用户会说的话，建议 ≤200 字、硬上限 1000；`meta` 只放小 JSON，硬上限 4KB。必须有 `cursor:pointer` + hover/focus 反馈；不可点元素禁止装成交互。详见 `sendPrompt-usage.md`。

## 沙箱红线

HTML no-script；不要外链脚本/CDN、`javascript:`、iframe/object/embed、form、非 sendPrompt 事件、`allow-same-origin`。Mermaid 不用 `click` directive。SVG/HTML 一次写完整，不要多次调工具拼同一张图。

## Tokens 速查

颜色只写 `hsl(var(--token))`，自动适配 light/dark：`--background`、`--foreground`、`--muted-foreground`、`--primary`、`--border`、`--accent`、`--success`、`--warning`、`--destructive`。字体用 system stack：`-apple-system,BlinkMacSystemFont,system-ui,"PingFang SC","Microsoft YaHei",sans-serif`。SVG 推荐 `viewBox="0 0 680 H"`、`width="100%"`、H≤480。

更多：`design-tokens.md`、`sandbox.md`、`failure-patterns.md`、`examples/`。
