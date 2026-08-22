# TabSlide 主题模板库（照抄骨架，只改内容）

> **用法（硬规则）**：从下面选**一套**主题 → 整段复制它的 `<style>` → 每页从该主题的
> 页型骨架里挑一个**完整复制**，只替换文字/数据/占位符——**不要自造 CSS、不要跨主题混搭**。
> 骨架已保证：1280×720 不出画、版心垂直撑满（无下半页空白）、配色统一、白名单内可转换。

## 主题 A · Aurora（深色科技，适合技术/产品/发布会）

### A0. 主题样式（整段复制到 `<style>`）

```css
.ppt-slide { width:1280px; height:720px; position:relative; overflow:hidden; box-sizing:border-box;
  font-family:'Inter','PingFang SC','Microsoft YaHei',sans-serif;
  background:linear-gradient(135deg,#0F172A 0%,#1E1B4B 55%,#312E81 100%); color:#F8FAFC; }
.au-pad { position:absolute; inset:0; padding:64px 80px; display:flex; flex-direction:column; }
.au-eyebrow { font-size:14px; letter-spacing:4px; color:#818CF8; text-transform:uppercase; font-weight:600; }
.au-h1 { font-size:64px; font-weight:800; line-height:1.15; margin:20px 0 0; color:#FFFFFF; }
.au-h2 { font-size:40px; font-weight:700; margin:8px 0 0; color:#FFFFFF; }
.au-sub { font-size:22px; color:#C7D2FE; margin-top:16px; line-height:1.5; }
.au-accent-bar { width:72px; height:5px; border-radius:3px; background:linear-gradient(90deg,#6366F1,#A855F7); }
.au-body { flex:1; display:flex; flex-direction:column; justify-content:center; }
.au-grid { display:flex; gap:24px; }
.au-card { flex:1; background:rgba(99,102,241,0.14); border:1px solid rgba(129,140,248,0.35);
  border-radius:16px; padding:32px 28px; display:flex; flex-direction:column; }
.au-card-num { width:44px; height:44px; border-radius:12px; background:linear-gradient(135deg,#6366F1,#A855F7);
  color:#fff; font-size:20px; font-weight:700; display:flex; align-items:center; justify-content:center; }
.au-card-title { font-size:22px; font-weight:700; color:#FFFFFF; margin-top:20px; }
.au-card-text { font-size:16px; color:#C7D2FE; line-height:1.6; margin-top:10px; }
.au-kpi-value { font-size:52px; font-weight:800; color:#FFFFFF; }
.au-kpi-label { font-size:16px; color:#A5B4FC; margin-top:6px; }
.au-foot { font-size:14px; color:#818CF8; display:flex; justify-content:space-between; }
```

### A1. 封面页

```html
<div class="ppt-slide">
  <div class="au-pad">
    <div class="au-body" style="align-items:center;text-align:center">
      <p class="au-eyebrow">【场合 · 日期】</p>
      <h1 class="au-h1" style="font-size:76px">【主标题】</h1>
      <div class="au-accent-bar" style="margin:32px auto 0"></div>
      <p class="au-sub" style="font-size:26px">【一句话副标题】</p>
    </div>
    <div class="au-foot"><span>【演讲者 / 团队】</span><span>【品牌名】</span></div>
  </div>
</div>
```

### A2. 目录页

```html
<div class="ppt-slide">
  <div class="au-pad">
    <p class="au-eyebrow">Agenda</p>
    <h2 class="au-h2">目录</h2>
    <div class="au-accent-bar" style="margin-top:20px"></div>
    <div class="au-body">
      <div class="au-grid">
        <div class="au-card"><div class="au-card-num">1</div><div class="au-card-title">【章节一】</div><div class="au-card-text">【一句话说明】</div></div>
        <div class="au-card"><div class="au-card-num">2</div><div class="au-card-title">【章节二】</div><div class="au-card-text">【一句话说明】</div></div>
        <div class="au-card"><div class="au-card-num">3</div><div class="au-card-title">【章节三】</div><div class="au-card-text">【一句话说明】</div></div>
      </div>
    </div>
  </div>
</div>
```

### A3. 要点卡片页（2–4 个要点）

```html
<div class="ppt-slide">
  <div class="au-pad">
    <p class="au-eyebrow">【小节标签】</p>
    <h2 class="au-h2">【本页标题】</h2>
    <div class="au-accent-bar" style="margin-top:20px"></div>
    <div class="au-body">
      <div class="au-grid" style="align-items:stretch">
        <div class="au-card"><div class="au-card-num">1</div><div class="au-card-title">【要点】</div><div class="au-card-text">【两行内说明，不超过 40 字】</div></div>
        <div class="au-card"><div class="au-card-num">2</div><div class="au-card-title">【要点】</div><div class="au-card-text">【两行内说明】</div></div>
        <div class="au-card"><div class="au-card-num">3</div><div class="au-card-title">【要点】</div><div class="au-card-text">【两行内说明】</div></div>
      </div>
    </div>
    <div class="au-foot"><span>【页脚备注】</span><span>【页码】</span></div>
  </div>
</div>
```

### A4. 流程 / 步骤页（横向 3–4 步）

```html
<div class="ppt-slide">
  <div class="au-pad">
    <p class="au-eyebrow">【小节标签】</p>
    <h2 class="au-h2">【流程标题】</h2>
    <div class="au-accent-bar" style="margin-top:20px"></div>
    <div class="au-body">
      <div style="display:flex;align-items:stretch;gap:16px">
        <div class="au-card" style="text-align:center;align-items:center"><div class="au-card-num">1</div><div class="au-card-title" style="font-size:20px">【步骤名】</div><div class="au-card-text">【说明 ≤30 字】</div></div>
        <div style="display:flex;align-items:center;color:#818CF8;font-size:28px">→</div>
        <div class="au-card" style="text-align:center;align-items:center"><div class="au-card-num">2</div><div class="au-card-title" style="font-size:20px">【步骤名】</div><div class="au-card-text">【说明】</div></div>
        <div style="display:flex;align-items:center;color:#818CF8;font-size:28px">→</div>
        <div class="au-card" style="text-align:center;align-items:center"><div class="au-card-num">3</div><div class="au-card-title" style="font-size:20px">【步骤名】</div><div class="au-card-text">【说明】</div></div>
      </div>
    </div>
  </div>
</div>
```

### A5. 数据 / KPI 页

```html
<div class="ppt-slide">
  <div class="au-pad">
    <p class="au-eyebrow">【小节标签】</p>
    <h2 class="au-h2">【数据主题】</h2>
    <div class="au-accent-bar" style="margin-top:20px"></div>
    <div class="au-body">
      <div class="au-grid">
        <div class="au-card" style="align-items:center;justify-content:center;text-align:center"><div class="au-kpi-value">【128 万】</div><div class="au-kpi-label">【指标名】</div></div>
        <div class="au-card" style="align-items:center;justify-content:center;text-align:center"><div class="au-kpi-value">【+23%】</div><div class="au-kpi-label">【指标名】</div></div>
        <div class="au-card" style="align-items:center;justify-content:center;text-align:center"><div class="au-kpi-value">【4.9】</div><div class="au-kpi-label">【指标名】</div></div>
      </div>
    </div>
    <div class="au-foot"><span>【数据来源】</span><span>【页码】</span></div>
  </div>
</div>
```

### A6. 总结页

```html
<div class="ppt-slide">
  <div class="au-pad">
    <div class="au-body" style="align-items:center;text-align:center">
      <p class="au-eyebrow">Takeaway</p>
      <h2 class="au-h2" style="font-size:48px">【一句话核心结论】</h2>
      <div class="au-accent-bar" style="margin:28px auto 0"></div>
      <p class="au-sub" style="max-width:820px">【行动号召或下一步，两行以内】</p>
    </div>
    <div class="au-foot"><span>【联系方式 / 团队】</span><span>【品牌名】</span></div>
  </div>
</div>
```

## 主题 B · Journal（浅色杂志风，适合汇报/知识分享/复盘）

### B0. 主题样式（整段复制到 `<style>`）

```css
.ppt-slide { width:1280px; height:720px; position:relative; overflow:hidden; box-sizing:border-box;
  font-family:'Inter','PingFang SC','Microsoft YaHei',sans-serif; background:#FAF7F2; color:#1C1917; }
.jn-pad { position:absolute; inset:0; padding:60px 76px; display:flex; flex-direction:column; }
.jn-eyebrow { font-size:14px; letter-spacing:4px; color:#C2410C; text-transform:uppercase; font-weight:700; }
.jn-h1 { font-size:64px; font-weight:800; line-height:1.15; margin:20px 0 0; color:#1C1917; }
.jn-h2 { font-size:40px; font-weight:800; margin:8px 0 0; color:#1C1917; }
.jn-sub { font-size:22px; color:#57534E; margin-top:14px; line-height:1.5; }
.jn-rule { width:72px; height:5px; border-radius:3px; background:#EA580C; }
.jn-body { flex:1; display:flex; flex-direction:column; justify-content:center; }
.jn-grid { display:flex; gap:24px; }
.jn-card { flex:1; background:#FFFFFF; border-radius:14px; padding:30px 28px;
  border-top:5px solid #EA580C; box-shadow:0 6px 20px rgba(28,25,23,0.08);
  display:flex; flex-direction:column; }
.jn-card:nth-child(2) { border-top-color:#0D9488; }
.jn-card:nth-child(3) { border-top-color:#4F46E5; }
.jn-card:nth-child(4) { border-top-color:#CA8A04; }
.jn-card-label { font-size:14px; font-weight:700; letter-spacing:2px; color:#A8A29E; text-transform:uppercase; }
.jn-card-title { font-size:22px; font-weight:700; color:#1C1917; margin-top:12px; }
.jn-card-text { font-size:16px; color:#57534E; line-height:1.65; margin-top:10px; }
.jn-kpi-value { font-size:52px; font-weight:800; color:#1C1917; }
.jn-quote { background:#FFFFFF; border-left:6px solid #EA580C; border-radius:12px;
  padding:28px 32px; font-size:22px; line-height:1.6; color:#292524;
  box-shadow:0 6px 20px rgba(28,25,23,0.08); }
.jn-foot { font-size:14px; color:#A8A29E; display:flex; justify-content:space-between; }
```

### B1. 封面页

```html
<div class="ppt-slide">
  <div style="position:absolute;right:-120px;top:-120px;width:420px;height:420px;border-radius:50%;background:#FDE8D7"></div>
  <div style="position:absolute;right:60px;bottom:80px;width:140px;height:140px;border-radius:50%;background:#EA580C;opacity:0.9"></div>
  <div class="jn-pad">
    <div class="jn-body" style="max-width:760px">
      <p class="jn-eyebrow">【场合 · 日期】</p>
      <h1 class="jn-h1" style="font-size:72px">【主标题】</h1>
      <div class="jn-rule" style="margin-top:28px"></div>
      <p class="jn-sub" style="font-size:24px">【一句话副标题】</p>
    </div>
    <div class="jn-foot"><span>【演讲者 / 团队】</span><span>【品牌名】</span></div>
  </div>
</div>
```

### B2. 目录页

```html
<div class="ppt-slide">
  <div class="jn-pad">
    <p class="jn-eyebrow">Contents</p>
    <h2 class="jn-h2">目录</h2>
    <div class="jn-rule" style="margin-top:18px"></div>
    <div class="jn-body">
      <div class="jn-grid">
        <div class="jn-card"><div class="jn-card-label">01</div><div class="jn-card-title">【章节一】</div><div class="jn-card-text">【一句话说明】</div></div>
        <div class="jn-card"><div class="jn-card-label">02</div><div class="jn-card-title">【章节二】</div><div class="jn-card-text">【一句话说明】</div></div>
        <div class="jn-card"><div class="jn-card-label">03</div><div class="jn-card-title">【章节三】</div><div class="jn-card-text">【一句话说明】</div></div>
      </div>
    </div>
  </div>
</div>
```

### B3. 要点卡片页

```html
<div class="ppt-slide">
  <div class="jn-pad">
    <p class="jn-eyebrow">【小节标签】</p>
    <h2 class="jn-h2">【本页标题】</h2>
    <div class="jn-rule" style="margin-top:18px"></div>
    <div class="jn-body">
      <div class="jn-grid" style="align-items:stretch">
        <div class="jn-card"><div class="jn-card-label">【标签】</div><div class="jn-card-title">【要点】</div><div class="jn-card-text">【两行内说明，不超过 40 字】</div></div>
        <div class="jn-card"><div class="jn-card-label">【标签】</div><div class="jn-card-title">【要点】</div><div class="jn-card-text">【两行内说明】</div></div>
        <div class="jn-card"><div class="jn-card-label">【标签】</div><div class="jn-card-title">【要点】</div><div class="jn-card-text">【两行内说明】</div></div>
      </div>
    </div>
    <div class="jn-foot"><span>【页脚备注】</span><span>【页码】</span></div>
  </div>
</div>
```

### B4. 引用 / 定义页（适合概念定义、金句）

```html
<div class="ppt-slide">
  <div class="jn-pad">
    <p class="jn-eyebrow">【小节标签】</p>
    <h2 class="jn-h2">【本页标题】</h2>
    <div class="jn-rule" style="margin-top:18px"></div>
    <div class="jn-body" style="gap:28px">
      <div class="jn-quote">【核心定义或引用，两到三行，60 字以内】</div>
      <div class="jn-grid">
        <div class="jn-card"><div class="jn-card-label">【维度】</div><div class="jn-card-text">【补充点 ≤30 字】</div></div>
        <div class="jn-card"><div class="jn-card-label">【维度】</div><div class="jn-card-text">【补充点】</div></div>
        <div class="jn-card"><div class="jn-card-label">【维度】</div><div class="jn-card-text">【补充点】</div></div>
      </div>
    </div>
  </div>
</div>
```

### B5. 数据 / KPI 页

```html
<div class="ppt-slide">
  <div class="jn-pad">
    <p class="jn-eyebrow">【小节标签】</p>
    <h2 class="jn-h2">【数据主题】</h2>
    <div class="jn-rule" style="margin-top:18px"></div>
    <div class="jn-body">
      <div class="jn-grid">
        <div class="jn-card" style="align-items:center;justify-content:center;text-align:center"><div class="jn-kpi-value">【128 万】</div><div class="jn-card-text">【指标名】</div></div>
        <div class="jn-card" style="align-items:center;justify-content:center;text-align:center"><div class="jn-kpi-value">【+23%】</div><div class="jn-card-text">【指标名】</div></div>
        <div class="jn-card" style="align-items:center;justify-content:center;text-align:center"><div class="jn-kpi-value">【4.9】</div><div class="jn-card-text">【指标名】</div></div>
      </div>
    </div>
    <div class="jn-foot"><span>【数据来源】</span><span>【页码】</span></div>
  </div>
</div>
```

### B6. 总结页

```html
<div class="ppt-slide">
  <div style="position:absolute;left:-100px;bottom:-140px;width:380px;height:380px;border-radius:50%;background:#FDE8D7"></div>
  <div class="jn-pad">
    <div class="jn-body" style="align-items:center;text-align:center">
      <p class="jn-eyebrow">Takeaway</p>
      <h2 class="jn-h2" style="font-size:48px;max-width:900px">【一句话核心结论】</h2>
      <div class="jn-rule" style="margin:26px auto 0"></div>
      <p class="jn-sub" style="max-width:820px">【行动号召或下一步，两行以内】</p>
    </div>
    <div class="jn-foot"><span>【联系方式 / 团队】</span><span>【品牌名】</span></div>
  </div>
</div>
```

## 使用检查（render 前自查 10 秒）

- [ ] 只用了**一套**主题的 class，没混搭、没自造新 CSS class
- [ ] 所有【占位符】都已替换成真实内容，没有残留
- [ ] 卡片文字没超预算（title ≤ 12 字、text ≤ 40 字）——超了就删词或拆页，**不要**缩字号硬塞
- [ ] 每页用了 `*-pad` + `*-body` 骨架（flex 撑满版心，避免下半页空白）
- [ ] 真实图片按 html-spec 以 `data:image/*;base64` 内嵌；图表/复杂视觉按 html-spec 走 rasterize
