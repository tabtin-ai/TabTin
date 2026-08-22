# TabSlide HTML 生成规范 · 八、页面模板

> 本文从主 [`../SKILL.md`](../SKILL.md) 物理拆出（内容逐字保留，未改语义）。

### 8.1 封面页

```html
<div class="ppt-slide slide-cover" style="width:1280px;height:720px;background:linear-gradient(135deg,#2563EB,#7C3AED)">
  <div style="width:80px;height:4px;background:#fff;margin-bottom:32px"></div>
  <h1 class="slide-title-lg" style="color:#fff">项目名称</h1>
  <p class="slide-subtitle" style="color:rgba(255,255,255,0.8);margin-top:16px">副标题 · 2026 年第一季度</p>
</div>
```

### 8.2 KPI 仪表盘页

```html
<div class="ppt-slide slide-content" style="width:1280px;height:720px;background:var(--slide-bg-subtle)">
  <div>
    <p class="slide-label">核心指标</p>
    <h2 class="slide-heading">业务增长概览</h2>
  </div>
  <div class="slide-grid-4" style="flex:1">
    <div class="slide-kpi">
      <div class="kpi-label">月活用户</div>
      <div class="kpi-value">128 万</div>
      <div class="kpi-change up">↑ 23.5%</div>
    </div>
    <div class="slide-kpi">
      <div class="kpi-label">营收</div>
      <div class="kpi-value">¥4.2 亿</div>
      <div class="kpi-change up">↑ 18.2%</div>
    </div>
    <div class="slide-kpi">
      <div class="kpi-label">转化率</div>
      <div class="kpi-value">6.8%</div>
      <div class="kpi-change down">↓ 1.2%</div>
    </div>
    <div class="slide-kpi">
      <div class="kpi-label">NPS</div>
      <div class="kpi-value">72</div>
      <div class="kpi-change up">↑ 5</div>
    </div>
  </div>
</div>
```

### 8.3 图表页

```html
<div class="ppt-slide slide-content" style="width:1280px;height:720px">
  <div>
    <p class="slide-label">趋势分析</p>
    <h2 class="slide-heading">季度营收变化</h2>
  </div>
  <!-- 图表必须有确定高度；仅写 flex:1 / height:100% 会让 ECharts 可能在 0 高度时初始化。 -->
  <div id="chart-1" style="width:100%;height:400px;flex:1 1 400px;min-height:400px"></div>
  <script>
    const chart = echarts.init(document.getElementById('chart-1'));
    chart.setOption({
      color: ['#2563EB', '#0F766E', '#F59E0B'],
      tooltip: { trigger: 'axis' },
      legend: { top: 0 },
      grid: { top: 40, bottom: 30, left: 60, right: 20 },
      xAxis: { type: 'category', data: ['Q1','Q2','Q3','Q4'] },
      yAxis: { type: 'value', axisLabel: { formatter: '¥{value}万' } },
      series: [
        { name: '产品 A', type: 'bar', data: [120, 200, 150, 280] },
        { name: '产品 B', type: 'bar', data: [80, 130, 110, 190] }
      ]
    });
    requestAnimationFrame(() => chart.resize());
  </script>
</div>
```

### 8.4 对比分析页（含图标兜底示范）

```html
<div class="ppt-slide slide-split" style="width:1280px;height:720px">
  <div>
    <p class="slide-label" style="color:var(--slide-success)">方案 A</p>
    <h2 class="slide-heading" style="margin-bottom:24px">自研方案</h2>
    <div style="display:flex;flex-direction:column;gap:12px">
      <div style="font-size:20px">完全可控</div>
      <div style="font-size:20px">深度定制</div>
      <div style="font-size:20px">长期成本低</div>
    </div>
  </div>
  <div>
    <p class="slide-label" style="color:var(--slide-warning)">方案 B</p>
    <h2 class="slide-heading" style="margin-bottom:24px">第三方集成</h2>
    <div style="display:flex;flex-direction:column;gap:12px">
      <div style="font-size:20px">快速上线</div>
      <div style="font-size:20px">成熟生态</div>
      <div style="font-size:20px">运维省心</div>
    </div>
  </div>
</div>
```

### 8.5 表格页

```html
<div class="ppt-slide slide-content" style="width:1280px;height:720px">
  <div>
    <p class="slide-label">财务概览</p>
    <h2 class="slide-heading">2025 年度预算分配</h2>
  </div>
  <table class="slide-table" style="flex:1">
    <thead>
      <tr><th>部门</th><th>Q1</th><th>Q2</th><th>Q3</th><th>Q4</th><th>合计</th></tr>
    </thead>
    <tbody>
      <tr><td>研发</td><td>¥320 万</td><td>¥350 万</td><td>¥380 万</td><td>¥400 万</td><td style="font-weight:700">¥1,450 万</td></tr>
      <tr><td>市场</td><td>¥180 万</td><td>¥220 万</td><td>¥200 万</td><td>¥260 万</td><td style="font-weight:700">¥860 万</td></tr>
      <tr><td>运营</td><td>¥120 万</td><td>¥130 万</td><td>¥140 万</td><td>¥150 万</td><td style="font-weight:700">¥540 万</td></tr>
    </tbody>
  </table>
</div>
```

### 8.6 总结 / 结尾页（图标走 rasterize）

```html
<div class="ppt-slide slide-cover" style="width:1280px;height:720px;background:linear-gradient(135deg,#2563EB,#0F766E)">
  <div style="width:80px;height:4px;background:#fff;margin-bottom:32px"></div>
  <h1 class="slide-title-lg" style="color:#fff">谢谢</h1>
  <p class="slide-subtitle" style="color:rgba(255,255,255,0.8);margin-top:16px">如有问题，欢迎随时交流</p>
  <div style="display:flex;gap:24px;margin-top:48px">
    <!-- 图标必须包 rasterize；徽章文字独立写 -->
    <div style="display:flex;align-items:center;gap:8px;padding:8px 16px;background:rgba(255,255,255,0.2);border-radius:9999px;color:#fff">
      <div data-tabslide-rasterize style="width:18px;height:18px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px">
        <i class="fa-solid fa-envelope"></i>
      </div>
      <span>contact@example.com</span>
    </div>
    <div style="display:flex;align-items:center;gap:8px;padding:8px 16px;background:rgba(255,255,255,0.2);border-radius:9999px;color:#fff">
      <div data-tabslide-rasterize style="width:18px;height:18px;display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px">
        <i class="fa-solid fa-globe"></i>
      </div>
      <span>example.com</span>
    </div>
  </div>
</div>
```
