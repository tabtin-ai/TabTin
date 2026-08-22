# Browser Operator · CLI 命令参考

> 本文从主 [`../SKILL.md`](../SKILL.md) 物理拆出（内容逐字保留，未改语义）。

### 标签管理

```bash
tabtin browser open --url <url>                     # 打开 URL
tabtin browser open --url <url> --tab-id <id>      # 在指定 tab 中导航
tabtin browser context                              # 当前 runtime / 活跃 tab / workspace
tabtin browser capabilities                         # 当前 runtime 支持矩阵
tabtin browser doctor                               # 浏览器健康自检
tabtin browser tab list                            # 列出所有 tab
tabtin browser tab switch --tab-id <id>            # 切换 tab
tabtin browser tab close --tab-id <id>             # 关闭 tab
tabtin browser tab state --include-history         # 查看当前 tab 状态
tabtin browser nav --direction back                # 导航控制 (back/forward/reload/stop)
```

### 页面交互与观察（glance / act）

```bash
tabtin browser act --actions '<json>'               # 执行操作序列（默认内嵌 observed_elements）
tabtin browser act --actions '<json>' --observe=false  # 只要动作结果，不要内嵌观察
tabtin browser glance                              # 观察可交互元素（默认最轻：ref/role/text/href）
tabtin browser glance --selector "form"            # 限定范围观察
tabtin browser glance --tree                       # 全量 a11y 树 + DOM index（重输出）
tabtin browser eval --expression "<js>"             # 执行 JavaScript
tabtin browser wait --selector "<selector>"        # 等待元素出现
tabtin browser wait --timeout 3000                 # 等待毫秒数
```

浏览器的 `open` / `act`（默认观察）/ `glance` 结果使用统一结构：可交互元素在 `observed_elements[]`，每个元素的
`ref` 可交给 `browser act`，`href` 是页面返回的原始链接。`act` 另带 `observe_status`：

| `observe_status` | 含义 | `observed_elements` |
|------------------|------|---------------------|
| `ok` | 采到 ≥1 个元素 | 有，非空 |
| `empty` | 观察成功但 0 元素 | 有，`[]` |
| `skipped` | `--observe=false` | 无此字段 |
| `error` | 观察超时 / 失败 | 无此字段（动作仍可能 success） |

大 JSON 输出落盘后，`file_ref.path` 指向完整 envelope，业务数据位于 `.data`；优先用 CLI 自带 `--jq` 过滤，避免把整份元素清单读回上下文。

### 截图（glance --screenshot）

```bash
tabtin browser glance --screenshot --save <path>          # 截图落盘
tabtin browser glance --screenshot --full-page --save <path>  # 全页截图
tabtin browser glance --screenshot --som --save <path>    # SoM 标注截图
```

### 资源管理

```bash
tabtin browser resource list                       # 检测页面媒体资源（subcommand 是单数 resource list）
tabtin browser resource list --category video      # 按类型过滤
tabtin browser resource probe                      # 只读探测 video/audio/blob
tabtin browser resource inspect --resource-id <id> # 查看资源详情
tabtin browser resource capture --url <url>        # 捕获页面绑定资源
tabtin browser resource download --url <url>       # 通过 URL 下载单个资源（Daemon/Electron 通用）
tabtin browser resource smart-download             # 智能批量下载
tabtin browser job status --job-id <id>            # 查询异步下载 / 回放 job
tabtin browser job cancel --job-id <id>            # 取消异步 job
tabtin browser stream parse --url <url>            # 解析 HLS/DASH
tabtin browser stream info --url <url>             # 查看流媒体画质 / 分片信息
tabtin browser stream download --url <url> --filename video.mp4  # 下载流媒体
tabtin browser batch --actions '<json>'            # 批量执行动作（必须用 --actions 传 JSON）
```

`stream download --output <path>` 是显式保存路径；Electron 端只允许系统下载目录内路径。
日常用 `--filename <name>` 让运行时保存到默认下载目录更稳。

### 内容导出（print，始终落盘、--save 必填）

```bash
tabtin browser print --save <path>                 # 当前 tab → markdown（默认；共享会话）
tabtin browser print --url <url> --save <path>     # 临时隐藏 Tab 抓取（不共享会话）
tabtin browser print --as text --save <path>       # 纯文本正文
tabtin browser print --as html --save <path>       # clean HTML
tabtin browser print --as json --schema '<JSON Schema>' --save <path>  # 结构化投影
tabtin browser print --as pdf --save <path>        # PDF（仅当前 tab）
tabtin browser print --include links,images --save <path>  # 内容类型白名单：保留链接+图片
```

> **内容类型白名单 `--include`（print 专属）**：逗号分隔 `images,links,media,tables,forms`；
> 不传 = 剥离全部可过滤类型只留正文，`--include all` = 全保留。作用于 text/markdown/html 产物与
> `--as json` 投影；不影响 `glance` 的元素清单 / a11y 树。
> **响应只回 `{path, format, title, url, bytes, word_count}` 元信息**——读内容用 `grep` / 分段 `read` 该文件。

### 反检测与会话

```bash
tabtin browser random-ua                           # 随机 User-Agent
tabtin browser cookies get|set|clear               # Cookie 管理
tabtin browser clear-session                       # 清空缓存/会话
tabtin browser session create|list|switch|close    # 命名会话管理
tabtin browser session save|load|close-all         # 保存 / 加载 / 关闭会话
```

### 网络调试

```bash
tabtin browser network                             # 网络请求日志
tabtin browser network --filter "api.example.com"  # 过滤
tabtin browser network --filter "api|graphql|list" --include-request-body --include-response-body --tab-id <viewId>
tabtin browser network --include-response-body --format json --output /tmp/network.json  # 落盘（全局 --output，与 --jq 互斥）
tabtin browser network to-api --input @network.json  # 生成 OpenAPI 3.1 草案
tabtin browser console                             # 控制台日志
tabtin browser route --url-pattern "**/*.png"      # 拦截 / 改写请求
tabtin browser route-list                          # 列出拦截规则（Daemon 返回 501）
tabtin browser unroute --rule-id <id>              # Electron 取消拦截
tabtin browser unroute --url-pattern "**/*.png"    # 按注册模式取消拦截
tabtin browser record start|stop|status            # 录制（Electron 完整支持）
tabtin browser replay run|list                     # 回放录制
```

> **network 输出纪律**：带 `--include-response-body` 的输出可能非常大，**不要裸跑**把全量刷进终端。
> 二选一：① 管道过滤只取字段（`--format json | jq -r '...'`）；② 全局 `--output <path>` 先落盘、
> 再对文件做 jq。`--output` 与 `--jq` 互斥，别同时传。

> 运行时差异：`route-list`、逐帧录制等能力主要面向 Electron。
> Daemon 会通过 `capabilities` 标注 degraded / unsupported；不确定时先执行
> `tabtin browser capabilities --format json`。

### 常见误猜 flag 对照表

以下 flag 不存在，猜错一次就浪费一轮工具调用：

| 误猜 | 正确用法 |
|------|----------|
| `nav --url` | 打开 URL 用 `open --url <url>`；`nav` 只有 `--direction`（back/forward/reload/stop） |
| `eval --script` / `eval --code` | `eval --expression "<js>"` |
| `wait --until` | `wait --selector "<css>"` + `--timeout <ms>` |
| `observe` / `snapshot` / `capture` / `screenshot` | 已收编为 `glance`（默认清单；`--tree` 全量树；`--screenshot` 截图） |
| `extract` / `markdown` / `pdf` | 已收编为 `print`（`--as text\|markdown\|html\|json\|pdf`） |
| `print` 不带 `--save` | `--save <path>` 必填（保存路径只允许 `~/.tabtin` 和 `/tmp`） |
| `print --selector` | `print` 整页导出无 selector；按元素定位用 `glance --selector` |
| `--jq '.data.foo'` | `--jq` 已自动解包 envelope.data，直接写 `.foo` |

### 打开列表页里的二级页（详情页钻取）

强签名站点（如小红书）的详情链接带签名参数（`xsec_token` 等），**改写或拼接 URL 会丢签名 → 撞风控 404**；`open` 还有反幻觉守卫（`UNVERIFIED_NAVIGATION_URL`）会拦截未在页面证据中观测到的 URL。标准流程：

```bash
# 1. 在列表页观测，拿页面上真实存在的链接（含签名参数）
tabtin browser glance --tab-id <id> --format json --jq '.observed_elements[] | {text, href}'

# 2. 照抄 href 原文去 open——一个字符都不要改
tabtin browser open --url "<observed_elements[].href 原文>"
```

- 守卫以**当前页面 DOM 真相**为事实源：`print` 源页面里出现过的链接同样进导航证据；未命中时守卫会实时抓当前 tab 的 `a[href]` 求证。
- 被守卫拦截时，错误 message 会直接给出同 path 的已验证链接——照抄它重试。
- **不要**用 `eval` 改 `window.location.href` 绕过守卫：绕过后丢签名参数，大概率撞 300031 风控 404。

### 网页批量抓结构化数据

「从网页 / 列表页 / 搜索结果批量抓结构化数据」有专属 skill：五阶段链路（侦察 → 选路（接口爬取 / 模拟操作）→ 链路测试 → 脚本扩量 → 校验交付，产出 JSON/JSONL + manifest）见 `skills_read("app:tabweb/browser-collect")`。
