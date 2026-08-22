# Browser Operator · 页面交互（Open-Act）

> 讲动态页面交互（表单、SPA、分页列表）的 open → act → act… 循环与详情钻取。

## Open-Act 交互循环

用于动态页面交互（表单、SPA、分页列表）：

```bash
tabtin browser open --url "https://example.com/form"
tabtin browser act --actions '[{"type":"fill","ref":"e2","value":"张三"},{"type":"click","ref":"e5"}]'
tabtin browser act --actions '[{"type":"click","ref":"e8"}]'   # 用上一步返回的 observed_elements 继续
```

主路径 **`open → act → act…`**：`open`/`act` 默认内嵌 compact `observed_elements`，可直接链式 `act --ref eN`。
仅当 `observe_status` 为 `empty`/`error`、清单可疑、或需要 `--tree`/`--screenshot` 时再 `glance`。

> **怎么引用元素喂给 `act`**：`open`/`act`/`glance` 输出的每个元素带 `ref`（`eN`，如 `e1`）和 `selector`。`act` 接受两种引用：
> - `{"type":"click","ref":"e1"}`——用 glance 给的 `ref`（**推荐**）；
> - `{"type":"click","selector":"#submit"}`——直接用**唯一** selector（`#id` / 唯一 `aria-label` / glance 给出的 `xpath=...`）。**禁止**手写不唯一的弱 CSS（如 `li > button`、`ul li:nth-child(2) button`、`p > a`）——多匹配时会点到错误元素却仍可能 `status: success`。
>
> ⚠ `open`/`act`/`glance` 输出的 `index` **只是展示序号**（= `eN` 里的 N），**不是** `act` 的 ref——不要写 `"ref":"1"`，要写 `"ref":"e1"`（或用唯一 `selector`）。

### `act` 成功 ≠ 业务目标达成

`executed_actions[].status: "success"` 只表示**这次点击/填表动作做完了**，不表示翻页、提交、列表刷新已生效。

可选观测字段（排障用，不改变 success 含义）：

- `selector_source`: `initial`（首次 selector）| `semantic_relocate`（失效后按语义指纹重定位）
- `relocated_from`: 重定位前的原 selector（仅 `semantic_relocate` 时有）
- `resolved_text` / `resolved_role`：本次 `ref` 回解时缓存里的语义（点完对照：若你以为点的是「3」却看到文章标题，说明用了过期 eN）

### 表单填写与提交前核验

填写文本框、选择控件后，先查看 `act` 返回的 `executed_actions`，再决定是否提交。`value` 是 `fill` 的正式字段；若返回了 `compatibility_warnings`，说明使用了旧兼容写法，后续动作改用 `value`。

```bash
tabtin browser act --actions '[
  {"type":"fill","ref":"e1","value":"张三"},
  {"type":"click","ref":"e6"}
]'
```

点击提交前，逐项核对填写动作的 `actual_value`、勾选控件的 `checked` 与选择控件的 `control_value` 是否符合预期；缺字段、值不符或页面可能异步回填时，先看 `act` 返回的 `observe_status`——`empty`/`error` 再 `glance`，否则用内嵌 `observed_elements` 确认表单当前状态后再提交。提交动作返回 `status: success` 仍只代表点击已执行：业务结果必须继续读取提交后的返回页、成功提示、错误提示或其他页面信号来验收。

## 翻页 / 列表换页（硬规则）

无 `href` 的页码按钮（常见于 SPA / Algolia 类站点）只能 `act --ref`，**不要**自己拼 `?page=` / `?start=` 去 `open`——会撞 `UNVERIFIED_NAVIGATION_URL`。

```bash
# 1. 打开或从上一步 act 的 observed_elements 取分页 ref（记下列表首条 title/href）
tabtin browser open --url "https://example.com/list" --format json

# 2. 从【最近一次 open/act 返回】里按 text 找页码按钮的 ref（如 text "2" → e203），禁止沿用上一轮记忆的 eN
tabtin browser act --actions '[{"type":"click","ref":"e203"}]' --format json

# 3. 验收（见下方三信号）——优先看 act 内嵌 observed_elements；observe_status=empty/error 时再 glance
```

### 翻页验收（三信号，满足任一即可；URL 非必须）

许多站点只局部刷新列表、**URL 不变**。不得把「`page_url` 变了」当成唯一门禁。

1. **列表指纹变了**（首选、最通用）：列表首条 title/href，或前几条集合与点击前不同。
2. **分页控件状态变了**：当前页码选中态 / `aria-current` / 「第 N 页」文案变了。
3. **`page_url` 变了**（加分项）：有 query/path 分页时可用；没有变化**不能**据此判失败。

未满足任一信号 → 不得宣称翻页成功；`observe_status` 为 `empty`/`error` 时 `glance` 补观察，或如实说明未翻页。

硬规则：

1. **禁止**仅凭 `executed_actions[].status: "success"` 宣称已翻到第 N 页。
2. `act` 后按「三信号」验收；可对照 `resolved_text` 确认点到的是不是页码。默认用 `act` 内嵌 `observed_elements`；`observe_status=empty`/`error` 时再 `glance`。
3. **每次要点页码前**：必须从**最近一次** `open`/`act`/`glance` 的 `observed_elements` 里用 `text`（如 `"3"`）定位 button 的 `ref`。**禁止**沿用对话记忆里的「e78=第3页」——同一 `eN` 在下一页观察后常指向完全不同的元素。
4. 分页按钮无 `href` 时：**禁止**拼接 / 改写 query 打开下一页；继续 `act --ref`。
5. 需要 20 条跨页数据时：每一页都走「取 ref → act → 三信号验收 → 再 act」，不要中途改打站点 API 却仍声称「浏览器翻页成功」。

## 看不懂默认清单时（重感知，显式加参）

- `glance --tree`：全量 a11y 树 + DOM index（重输出；树里行尾的 `{bN}` 句柄也可直接 `act --ref bN`）。
- `glance --screenshot [--som] [--full-page] [--save <path>]`：视觉截图 / SoM 标注，落盘后按需查看。

## 点进详情页 / 跟进链接（详情钻取）

这是「轨 A · 模拟操作」的核心动作，**别用 `print` 读完正文再从 id 拼 URL**——print 产物默认剥 links、拼链丢签名参（如小红书 `xsec_token`）会撞风控 / 被 `UNVERIFIED_NAVIGATION_URL` 守卫拦。

标准流程：先从 `open`/`act`/`glance` 拿页面**真实存在**的链接，再二选一：

```bash
# 1. 在列表页观测（open 或上一步 act 默认已含 observed_elements）
tabtin browser open --url "https://example.com/list" --tab-id <listTabId> --format json

# 2a. 直接点击（当前 tab 内跳转，最像真人）
tabtin browser act --tab-id <listTabId> --actions '[{"type":"click","ref":"e12"}]'

# 2b. 用真实 href 开新 tab（保留列表页、可并行）——href 原样复制，勿改写/拼接
tabtin browser open --url "<observed_elements 里的真实 href>"
```

- **优先 2b `open <真 href>`** 做详情钻取：新 tab、保留列表页、可并行；`href` 直接抄 `observed_elements`，别自己改 query。
- 用 2a `act click` 时注意 `ref` 会随 DOM 变化过期——`observe_status=empty`/`error` 或页面已变时再 `glance` 刷新。
- `open` 有反幻觉守卫：只放行**当前页面真实存在**的链接（会实时对 DOM 求证）；凭空拼的 URL 会被 `UNVERIFIED_NAVIGATION_URL` 拦，报错里会带同 path 的已验证 href 供照抄。
