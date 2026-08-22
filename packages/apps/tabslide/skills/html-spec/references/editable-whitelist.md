# TabSlide HTML 生成规范 · 四、可编辑白名单（推荐写法）

> 本文从主 [`../SKILL.md`](../SKILL.md) 物理拆出（内容逐字保留，未改语义）。

### 4.1 文字 ✅

任何可见容器内的文字都会被识别为 text PPTElement：

| Tag | 状态 | 备注 |
|------|------|------|
| `<p>` `<h1>`-`<h6>` | ✅ | 推荐做语义标题 / 段落 |
| `<div>` 内含直接文字 | ✅ | 作为"叶子容器"识别 |
| `<span>` `<li>` `<label>` `<a>` 内含文字 | ✅ | 作为 inline 容器识别 |
| `<strong>` `<b>` `<em>` `<i>` `<u>` | ✅ | 转为富文本 run（多 style 段落） |
| `<br>` | ✅ | 转为换行 |

支持的样式（自动写入 PPTElement.content / defaultColor / defaultFontSize 等）：

- `text-align: left / center / right / justify`
- `text-transform: uppercase / lowercase / capitalize`
- `color: #XXX / rgb() / rgba()`
- `font-size`（任意 px，自动 scale 到 pt）
- `font-weight: bold` 及数值 ≥600
- `font-family`

**⚠️ 文字标签不要写背景**：`<p>` 和 `<h*>` 内禁止 `background` / `border` / `box-shadow` —— 这些样式放在外层 `<div>` 上才会被识别为 shape。

### 4.2 简单形状 ✅

任意 `<div>` 满足以下任一条件即转为 shape PPTElement：

- 有 `background-color`（非透明）
- 有 `border`（任意宽度的边）
- 有 `box-shadow`（非 `inset`）
- 有 `border-radius` > 0

| CSS | 映射到 PPTElement |
|------|-------------------|
| `background-color: #XXX / rgba(...)` | `fill` |
| `border-radius: 12px` | `pathFormula="roundRect"` + `keypoints` |
| `border: 2px solid #XXX`（四边统一） | `outline` |
| 非均匀 `border-*-width`（如只有 border-left） | 拆为多条独立 line element |
| `box-shadow: 0 4px 12px rgba(0,0,0,0.1)` | `shadow` |

```html
<!-- 白底卡片：转为 shape PPTElement，含 fill + radius + shadow -->
<div class="bg-white rounded-xl shadow-md p-8">
  <h3 class="text-2xl font-bold">标题</h3>
  <p>内容</p>
</div>

<!-- 左侧彩色边条卡片：被拆为 fill shape + 一条左侧 line -->
<div style="background:#fff;border-left:4px solid #2563EB;border-radius:8px;padding:24px">
  <p>方案 A 推荐</p>
</div>
```

### 4.3 线段 / 分割线 ✅

用扁平 div 表达：

```html
<div class="h-[2px] w-full bg-gray-200"></div>
<div style="width:60px;height:4px;background:var(--slide-primary)"></div>
```

### 4.4 线性渐变 ✅

仅 `linear-gradient`，支持任意角度（`45deg` 或 `to right` 关键字）、多个 color stop、显式位置、rgba alpha：

```html
<div class="ppt-slide" style="background:linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)">
<div style="background:linear-gradient(to right, rgba(37,99,235,0.8) 0%, rgba(124,58,237,0.6) 100%)">
```

转为 `PPTElement.gradient`（`type=linear`），含 rotate（CSS 角度自动转 PPTX 语义）和 colors[]（pos + 含 alpha 的 hex）。

⚠️ **不支持 `radial-gradient`** —— 改用 linear 模拟，或走 §五 rasterize 兜底。

### 4.5 图片 ✅

三种写法都识别，转为 image PPTElement。`background-size: cover | contain | auto` 会透传到 `_bgImageMode`。

```html
<!-- 1. 光栅图 base64 内嵌（推荐：图数据会落到 slide 自己的存储，durable） -->
<img src="data:image/png;base64,iVBORw0KGgo..." />

<!-- 2. img 标签外链 -->
<img src="https://example.com/x.png" />

<!-- 3. background-image: url() -->
<div class="w-full h-[400px] bg-cover bg-center"
     style="background-image:url(https://example.com/x.png)"></div>
```

**外链 vs 数据内嵌（关键，决定图会不会掉）：**

| 写法 | 结果 | 是否 durable |
|------|------|-------------|
| `<img src="data:image/(png\|jpeg\|gif\|webp\|bmp);base64,...">` | 平台解码 → 落 slide 自己的存储 → src 换成平台 URL | ✅ 图数据自持久，随删 slide 自动清 |
| `<img src="https://第三方...">` | **原样引用第三方链接，不落库** | ❌ 第三方过期 / 防盗链 / 离线就掉图 |

- **要长期保留的真实图片（网页截图、产品图、logo 等）→ 必须走 base64 内嵌**：先把图下载到本地，再读成 `data:image/...;base64,...` 放进 `<img src>`。不要只贴第三方外链，更不要用文字 / 色块假装图片。
- ⚠️ 只放行**光栅图** `data:image/(png|jpeg|gif|webp|bmp)`；`data:image/svg+xml` 会被安全净化删掉（SVG 可带脚本）——SVG 图标直接写 `<svg>` 标签（见 §4.6），不要用 svg 的 data URI。
- ⚠️ 整份 HTML 有 **2MB 上限**，base64 会放大约 1/3。图多 / 图大时分页 `add-page` 逐页追加，或压缩图片后再内嵌。

### 4.6 SVG 图标 / 装饰 ✅

`<svg>` 元素整体会被序列化为 data URI，输出为 image PPTElement：

```html
<svg viewBox="0 0 24 24" width="48" height="48" fill="#2563EB">
  <path d="M12 2L2 22h20L12 2z"/>
</svg>

<!-- 装饰性波浪线、L 形角标、Bezier 路径都可以直接写 SVG -->
<svg viewBox="0 0 200 60" width="200" height="60">
  <path d="M0,30 Q50,0 100,30 T200,30" stroke="#F5A623" stroke-width="3" fill="none"/>
</svg>
```

⚠️ SVG 内带 CSS 动画 / 复杂 filter 可能视觉退化 —— 拿不准就走 rasterize。

### 4.7 图表 ✅

`<canvas>` 元素和带 `[_echarts_instance_]` 标记的元素会被自动截图为 image（@2x 清晰度）：

```html
<div id="chart-1" style="width:100%;height:400px;min-height:400px"></div>
<script>
  const chart = echarts.init(document.getElementById('chart-1'));
  chart.setOption({
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: ['Q1','Q2','Q3','Q4'] },
    yAxis: { type: 'value' },
    series: [{ type: 'bar', data: [120, 200, 150, 280] }]
  });
  requestAnimationFrame(() => chart.resize());
</script>
```

支持 ECharts、Chart.js、Plotly 任意 canvas-based 图表库。

### 4.8 表格 ✅

`<table>` 元素直接识别为 native table PPTElement（不是图片！），支持 `colspan`/`rowspan`、对齐、字号、单元格 bg：

```html
<table class="slide-table">
  <thead><tr><th>部门</th><th>Q1</th><th>合计</th></tr></thead>
  <tbody>
    <tr><td>研发</td><td>¥320万</td><td style="font-weight:700">¥1,450万</td></tr>
  </tbody>
</table>
```

`class="slide-table"` 会被识别为"带条纹行"主题。
