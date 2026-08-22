---
name: html-spec
description: >
  转换 HTML 为 PPT 元素——把 HTML 转成可编辑 PPT
  元素的契约：白名单决定可编辑范围，data-tabslide-rasterize
  兜底复杂视觉。
metadata:
  version: 0.4.0
  tabtin:
    category: doc
    displayName: "TabSlide HTML 生成规范"
    autoActivateFor: [tabslide]
---

# TabSlide HTML 生成规范

TabSlide 的 HTML 转页能力（`tabtin slide create --html` / `tabtin slide add-page --html`；整份覆盖才用 `tabtin slide generate --replace`）会把你写的 HTML 转成可编辑的 PPTElement。这份文档定义两件事：

1. **哪些 HTML 模式我们能完整解析为可编辑 PPTElement**（用户能拖、能改文字、能改色）
2. **超出白名单的视觉怎么用 `data-tabslide-rasterize` 兜底**（截图为 image，视觉对但整块拖）

## 一、设计哲学：白名单 + SVG/栅格化兜底

我们不是 Chrome，只能识别 HTML 表现力的一个子集。约定如下：

- **白名单内** → 可编辑 PPTElement（text / shape / image / line / table / chart）
- **白名单外的矢量视觉** → 用 `<svg>` 画（转成清晰图片，视觉稳定）
- **白名单外的复杂视觉** → 用 `<div data-tabslide-rasterize>...</div>` 主动包起来，整块截图为 image

这是契约：你写白名单内的内容，我保证可编辑；你写复杂装饰，主动标 rasterize，我保证视觉对。**不要写"差不多能识别但又拿不准"的东西** —— 拿不准就 rasterize，宁可降级一块为图片，也别让整页错位。

> **⚠️ HTML 能做的样式，PPT 不一定能还原。** PPT 的元素模型比 CSS 窄得多——很多纯 CSS 装饰（径向渐变、滤镜、毛玻璃、裁剪形状、异形/曲线、复杂阴影、伪元素画的图形、CSS 画的图标/箭头/连接线等）在转成 PPTElement 时会丢失或走样。**这类"用 CSS 硬凑的图形"应当改用 `<svg>` 画**：SVG 会被转成一张清晰的图片元素，视觉在任何机器 / 导出的 .pptx 里都稳定一致，不受 CSS→PPT 能力差异影响。
>
> 原则：**能进白名单的用白名单（可编辑）；做不进白名单的矢量图形优先用 `<svg>`（视觉稳定）；再不行才 `data-tabslide-rasterize` 截图兜底。** 代价是 SVG / 栅格化产物是整块图片，不能在编辑器里改文字改色——所以正文、标题、可编辑数据不要塞进 SVG。

## 二、画布容器（**必须**）

每页用一个 `.ppt-slide` div 包裹，宽高固定 1280×720：

```html
<div class="ppt-slide" style="width:1280px;height:720px;position:relative;overflow:hidden">
  <!-- 页面内容 -->
</div>
```

多页幻灯片在 `<body>` 中依次排列多个 `.ppt-slide`。

## 三、可用资源（自动注入）

- **样式：只用原生 CSS** — 用 `<style>` 写 class 或元素上写 `style="..."`。**不提供 Tailwind**，不要写 `class="bg-blue-500 p-8"` / `bg-[#2563EB]` 这类工具类（不会生效）。也**不要用与常见框架同名的 class**（如 `list-item`/`grid`/`flex`/`block`/`table`/`hidden`），用语义化命名（如 `.bullet-row`）。
- **Font Awesome 6** — `<i class="fa-solid fa-...">`（⚠️ 必须 rasterize 才能出现在 PPT 里，详见 §五）
- **ECharts** — `echarts.init(dom).setOption({...})`（图表容器必须同时声明确定的 `width` 和 `height`；不要只依赖 `flex:1` 或百分比高度）
- **Chart.js** — `new Chart(ctx, {...})`
- **MathJax** — `$$E=mc^2$$`
- **字体** — Inter（英文）、Noto Sans SC（中文），自动应用

## 四、可编辑白名单（推荐写法）

> 8 类可编辑元素（文字 / 简单形状 / 线段 / 线性渐变 / 图片 / SVG 图标 / 图表 / 表格）的逐项推荐写法与示例见 [`references/editable-whitelist.md`](references/editable-whitelist.md)。

**真实图片必须内嵌数据，别只贴外链（重要）**：把网页 / 素材里的真实图片（截图、产品图、logo）放进 PPT 时，先把图**下载到本地**，再读成 `data:image/(png|jpeg|gif|webp|bmp);base64,...` 写进 `<img src>`——这样图数据会落到 slide 自己的存储、长期不掉。`<img src="https://第三方...">` 是原样引用第三方链接，会过期 / 防盗链 / 离线掉图。**绝不要用文字 / 色块假装图片。** 细节见 `references/editable-whitelist.md §4.5`。

## 资源导航（按需读取）

- `references/editable-whitelist.md`：当你要判断某个元素是否可编辑、以及该怎么写成稳定白名单形态时读取。
- `examples/page-templates.md`：仅在需要快速起草整页结构或复用模板时读取；示例用于套版，不默认整份注入上下文。

## 五、栅格化兜底（⚠️ 写法）

### 5.1 何时用

**主动选择 rasterize 的场景：**

| 视觉效果 | 为什么走 rasterize |
|---|---|
| **Font Awesome 图标**（`<i class="fa-*">`） | dom_extractor 会把 FA 元素 `display:none` 隐藏，**直接写不会出现在 PPT 里** |
| **径向渐变**（`radial-gradient`） | 仅支持 linear |
| **毛玻璃**（`backdrop-filter: blur`） | PPT 无对应能力 |
| **裁剪形状**（`clip-path`、`mask-image`） | PPT 无对应能力 |
| **混合模式**（`mix-blend-mode`） | PPT 无对应能力 |
| **复杂 filter**（`drop-shadow`、多个 filter 叠加） | 转换不稳定 |
| **复杂 SVG**（含动画 / 滤镜 / 渐变填充） | 序列化后可能视觉退化 |
| **拿不准能不能识别的复杂视觉** | 主动声明意图，避免错位 |

### 5.2 怎么写

把要整块截图的内容包在 `<div data-tabslide-rasterize>` 里：

```html
<!-- Font Awesome 图标兜底（极其常用） -->
<div data-tabslide-rasterize
     style="position:absolute;top:80px;left:80px;width:48px;height:48px;
            display:flex;align-items:center;justify-content:center;
            color:#2563EB;font-size:32px">
  <i class="fa-solid fa-chart-line"></i>
</div>

<!-- 复杂 SVG 装饰兜底 -->
<div data-tabslide-rasterize
     style="position:absolute;top:80px;left:80px;width:200px;height:60px">
  <svg viewBox="0 0 200 60">
    <defs>
      <linearGradient id="g">
        <stop offset="0" stop-color="#2563EB"/>
        <stop offset="1" stop-color="#7C3AED"/>
      </linearGradient>
    </defs>
    <path d="M0,30 Q50,0 100,30 T200,30" stroke="url(#g)" stroke-width="3" fill="none"/>
  </svg>
</div>

<!-- 径向渐变兜底 -->
<div data-tabslide-rasterize
     style="width:300px;height:300px;border-radius:50%;
            background:radial-gradient(circle at 30% 30%, #FFD700, #FF8C00)"></div>
```

dom_extractor 看到 `data-tabslide-rasterize` 属性后：

1. 截图整个 div（含所有子元素，@2x 分辨率）
2. 上传到 OSS
3. 当一个 image PPTElement 输出
4. 子元素**不再被其他识别函数提取**（不会有"图片 + 文字"双重提取）

### 5.3 规则

- ✅ rasterize 区域**必须**有明确的 `width` / `height`（截图 clip 来自 getBoundingClientRect，无尺寸截不出来）
- ✅ 在编辑器里 rasterize 出的 image 只能整块拖动、缩放，**不能改文字 / 颜色**
- ❌ 别用 rasterize 包裹本来就能识别的简单卡片 / 文字 —— 浪费，且失去可编辑性
- ❌ rasterize 内不要再嵌套 rasterize（只截最外层）

## 六、明确禁止 / 不识别

以下用法即使写了也会被忽略或导致异常 —— 看到下表的视觉需求**第一反应应该是走 rasterize**：

| 用法 | 后果 |
|------|------|
| `<i class="fa-*">` 不包 rasterize | 图标被 `display:none` 隐藏，PPT 里看不到 |
| `radial-gradient` 不包 rasterize | 形状仍输出但渐变丢失（保留 bg / 边框） |
| `backdrop-filter` 不包 rasterize | 毛玻璃丢失 |
| `clip-path` / `mask-image` / `mix-blend-mode` 不包 rasterize | 视觉丢失 |
| `<p>` / `<h*>` 上写 `background` / `border` / `box-shadow` | 文字识别成功，但背景边框丢失 |
| `position: fixed` | 坐标计算异常（相对视口而非 `.ppt-slide`） |
| CSS `animation` / `transition` / `@keyframes` | PPT 不支持，渲染期被忽略 |
| `<iframe>` `<video>` `<audio>` | 不识别（slide generate 不输出此类元素） |
| `<ul>` / `<ol>` 嵌套结构（多层） | 识别不稳；改用 `<div>` 排列 |

## 七、配色与样式约定

### 7.1 颜色写法（任选其一，能识别）

- ✅ CSS 变量：`var(--slide-primary)`（保证全局一致，推荐多页演示统一用）
- ✅ 直接写 hex / rgb / rgba：`style="background:#2563EB"` / `style="color:rgba(255,255,255,0.7)"`
- ✅ 自定义 class 里写原生 CSS：`.title{color:#1F2937}`

**优先使用 CSS 变量** —— 主题切换时统一更新。多页演示混着用容易出现某页跳色。**不要用 Tailwind 工具类**（`bg-blue-500`/`bg-[#2563EB]` 等不会生效）。

### 7.2 CSS 变量速查

| 变量 | 默认值 | 用途 |
|------|--------|------|
| `--slide-primary` | #2563EB | 主色 |
| `--slide-accent` | #DC2626 | 强调色 |
| `--slide-text` / `--slide-text-secondary` | #1F2937 / #64748B | 正文 / 辅助文字 |
| `--slide-bg` / `--slide-bg-subtle` | #FFFFFF / #F8FAFC | 背景白 / 浅底 |
| `--slide-border` | #E2E8F0 | 边框色 |
| `--slide-success/warning/error/info` | 绿/橙/红/蓝 | 状态色 |
| `--slide-blue/teal/green/orange/red/purple` | — | 六色板（图表 / 卡片配色） |
| `--slide-radius-sm/md/lg/xl/full` | 8 / 12 / 16 / 24 / 9999 px | 圆角 |
| `--slide-shadow-sm/md/lg/xl` | — | 阴影 |

### 7.3 组件 class 速查

| class | 说明 |
|------|------|
| `.slide-cover` | 居中封面页（flex column center） |
| `.slide-content` | 标准内容页（纵向 + 60/80 px 内边距） |
| `.slide-split` / `.slide-split-40-60` | 1:1 / 2:3 分栏 |
| `.slide-grid-2/3/4` | 等宽网格 |
| `.slide-title` / `.slide-title-lg` / `.slide-subtitle` | 48 / 64 / 28 px |
| `.slide-heading` / `.slide-body` / `.slide-caption` / `.slide-label` | 36 / 20 / 14 / 14 px |
| `.slide-number` | 56 px 数字高亮 |
| `.slide-card` / `.slide-card-bordered` / `.slide-card-accent` / `.slide-card-filled` | 卡片变体 |
| `.slide-card-glass` | ⚠️ 含 backdrop-filter，毛玻璃效果**必须 rasterize** |
| `.slide-kpi`（内含 `.kpi-label / .kpi-value / .kpi-change.up/.down`） | KPI 指标卡 |
| `.slide-table` / `.slide-table-minimal` | 表格主题 |
| `.slide-badge` / `-primary/success/warning/error` | 标签（不要塞 FA 图标） |
| `.slide-list` | 带圆点列表（CSS `::before` 实现，识别为 div 文字） |
| `.slide-divider` / `.slide-divider-accent` / `.slide-accent-bar` | 装饰线 / 条 |
| `.slide-step-number` | 数字圆圈（识别为 shape + text） |
| `.slide-timeline` + `.slide-timeline-item` | 时间线 |

## 八、页面模板

> 6 套可直接套用的整页 HTML 模板（封面 / KPI 仪表盘 / 图表页 / 对比分析 / 表格页 / 总结页）见 [`examples/page-templates.md`](examples/page-templates.md)。

## 九、自查清单（生成前过一遍）

- [ ] 复杂装饰 / 图标 / 示意图 / 渐变描边优先用内联 `<svg>` 矢量，而不是 CSS 硬凑再 rasterize
- [ ] 自定义 class 没有与 Tailwind 工具类同名（`list-item` / `grid` / `flex` / `block` / `hidden` / `table` / `container` 等）
- [ ] 每个 `<i class="fa-*">` 都包在 `data-tabslide-rasterize` 容器内
- [ ] 没有用到 `radial-gradient` / `backdrop-filter` / `clip-path` / `mask-image` / `mix-blend-mode`（除非包 rasterize）
- [ ] `<p>` / `<h*>` 上没有 `background` / `border` / `box-shadow`（搬到外层 div）
- [ ] 渐变只用 `linear-gradient`，stop 位置和颜色清晰
- [ ] rasterize 容器都有明确的 `width` / `height`
- [ ] 没有 CSS `animation` / `transition` / `@keyframes`
- [ ] 元素不超出 1280×720 边界（遵守 design-guide 容量预算；`slide render` 对 `html_overflow` 默认拒绝导出）
- [ ] 图表用 ECharts / Chart.js canvas，不是手画的 div 柱状图
- [ ] 每个图表容器都有非零的显式 `width` / `height`；初始化放在布局完成后，并在需要时调用 `chart.resize()`
- [ ] 表格用 `<table>` 而不是 div 网格模拟
- [ ] 真实图片走 `data:image/*;base64` 内嵌（不是只贴第三方外链，更不是用文字/色块假装）
