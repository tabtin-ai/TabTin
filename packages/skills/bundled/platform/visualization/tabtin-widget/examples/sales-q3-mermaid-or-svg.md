# Q3 Sales: Mermaid or SVG

## 为什么用 widget

如果用户要“看 Q3 销售明细表”，用 `present_to_user.table_preview`。如果用户问“哪个区域增长最快 / Q3 对比结论是什么”，Agent 已经做了分析，适合用 widget 画小型柱状图并支持下钻。

本例用 SVG，因为柱状图需要比例、标签和点击柱子；Mermaid 不适合精确数据图。

## show_widget input

```ts
show_widget({
  title: "Q3 区域销售增长",
  summary: "Q3 区域销售增长柱状图：华东 32% 最高，华南 24% 第二，华北 18%，西部 9%；华东柱可点击查看明细。",
  format: "svg",
  loading_message: "正在生成 Q3 销售对比图...",
  code: `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 360" width="100%" role="img">
  <title>Q3 区域销售增长</title>
  <desc>华东 32% 增长最快，华南 24%，华北 18%，西部 9%。</desc>
  <style>
    .txt{font-family:-apple-system,BlinkMacSystemFont,system-ui,"PingFang SC","Microsoft YaHei",sans-serif;fill:hsl(var(--foreground))}
    .muted{fill:hsl(var(--muted-foreground))}
    .axis{stroke:hsl(var(--border));stroke-width:1}
    .bar{fill:hsl(var(--primary));rx:8}
    .bar-soft{fill:hsl(var(--primary) / .42)}
    .click{cursor:pointer;outline:none}
    .click rect{transition:fill .12s ease,filter .12s ease,transform .12s ease}
    .click:hover rect,.click:focus rect{fill:hsl(var(--primary));filter:drop-shadow(0 6px 14px hsl(var(--primary) / .20));transform:translateY(-2px)}
  </style>
  <text class="txt" x="44" y="40" font-size="20" font-weight="700">Q3 区域销售增长率</text>
  <text class="txt muted" x="44" y="64" font-size="13">原始明细用 table_preview；这里展示分析结论</text>
  <line class="axis" x1="76" y1="300" x2="620" y2="300"/>
  <line class="axis" x1="76" y1="92" x2="76" y2="300"/>

  <a class="click" href="#q3-east" aria-label="展开 Q3 华东销售增长明细" onclick="sendPrompt('展开 Q3 华东销售增长 32% 的明细和主要原因', { quarter:'Q3', region:'east', growth:32 })">
    <rect class="bar" x="128" y="108" width="74" height="192"/>
    <text class="txt" x="142" y="94" font-size="14" font-weight="700">32%</text>
  </a>
  <rect class="bar-soft" x="258" y="156" width="74" height="144"/>
  <text class="txt" x="272" y="142" font-size="14" font-weight="700">24%</text>
  <rect class="bar-soft" x="388" y="192" width="74" height="108"/>
  <text class="txt" x="402" y="178" font-size="14" font-weight="700">18%</text>
  <rect class="bar-soft" x="518" y="246" width="74" height="54"/>
  <text class="txt" x="536" y="232" font-size="14" font-weight="700">9%</text>

  <text class="txt" x="140" y="328" font-size="13">华东</text>
  <text class="txt" x="270" y="328" font-size="13">华南</text>
  <text class="txt" x="400" y="328" font-size="13">华北</text>
  <text class="txt" x="530" y="328" font-size="13">西部</text>
</svg>`
})
```

## 注意点

不要把完整销售表画成 SVG 表格；先用数据工具/TabData 得出结论，再画少量关键指标。可点击只给最高增长柱，避免每根柱子都诱导下钻。
