/**
 * Browser runtime capability matrix —— 双端 browser action 支持矩阵的「单一事实源」.
 *
 * ⚠️ 零依赖纯数据子模块：本文件**绝不** import 任何运行时
 * （不碰 electron / playwright / 两端 route / browser-core 的其它有副作用模块）。
 * 它只声明数据 + 纯投影函数，可被 Electron / Daemon / CLI 漂移检测三方安全引用。
 *
 * 「拆包缝」怎么留的：本文件自成一体（类型 + 数据 + 投影函数都在这里），
 * 仅从 `@tabtin/browser-core` 的 index 干净 re-export。将来要把这层独立成
 * `@tabtin/browser-contract` 时，直接 `git mv` 本文件到新包、把 index 的
 * re-export 改成转发即可，调用方（两端 route / 未来 CLI 校验）无需改动。
 *
 * 支持级别词表 —— 正典 `support/app/specs/runtime-capability-model.md` 的
 * 应用级 `full` / `headless` / `unavailable` 在 **action 级**的映射：
 *   - `full`        完整功能可用，两端行为一致。
 *   - `degraded`    功能裁剪（headless 弱化实现 / 默认值不同 / 动作词表别名约束等）。
 *                   对应正典的 `headless`。
 *   - `unsupported` 该 action 在此运行时不可用（route 缺失 404 / 显式 501 / 无 handler）。
 *                   对应正典的 `unavailable`。
 *
 * action id 命名：与 `tabtin browser …` CLI 命令路径一一对应——顶层命令用命令名
 * （如 `open`），子命令组用 `group.sub`（如 `tab.list` ↔ `tabtin browser tab list`）。
 * 这样 BR-6 的 `capabilities` 命令、BR-7 的 CI 漂移检测、Skill 都能拿同一份 id 对齐。
 *
 * 「如实标注、不粉饰」：daemon 列严格按当前 main 源码定级（每条 note 带原因 / BR 编号），
 * 不假装两端对齐。后续 BR-1/3/4 修复落地后回来同步上调级别。
 */

/** 已实现的两个浏览器运行时。 */
export type BrowserRuntime = 'electron' | 'daemon'

/** action 级支持级别（见文件头词表）。 */
export type SupportLevel = 'full' | 'degraded' | 'unsupported'

export interface ActionSupport {
  level: SupportLevel
  /**
   * `degraded` / `unsupported` 时**必填**：降级或不支持的具体原因（尽量带文件证据 / BR 编号）。
   * `full` 时省略。种子单测会强制这条约束。
   */
  note?: string
}

export interface BrowserActionCapability {
  /** 稳定 action id，对齐 CLI 命令路径（见文件头命名约定）。 */
  id: string
  /** 一句话说明这个 action 干什么（给 Agent / banner 看）。 */
  summary: string
  /** 该 action 在两端的支持矩阵。 */
  runtimes: Record<BrowserRuntime, ActionSupport>
}

/** 矩阵 schema 版本——投影输出带上，方便消费方判断契约是否变更。 */
export const CAPABILITY_MATRIX_VERSION = 1

const FULL: ActionSupport = { level: 'full' }

/**
 * 双端 browser action 支持矩阵（覆盖 `browser.go` 已注册的 browser action；
 * 不包含 context/capabilities 自描述命令，也不包含 doctor 诊断入口）。
 *
 * Electron = GUI 全量运行时，所有 action 全部 `full`。
 * Daemon = headless 运行时，按当前 main 源码逐条定级，degraded / unsupported 均带原因。
 */
export const BROWSER_CAPABILITY_MATRIX: readonly BrowserActionCapability[] = [
  // ── 顶层命令（17）────────────────────────────────────────────────
  {
    id: 'open',
    summary: '打开 URL（新建或复用 tab 并导航）',
    runtimes: { electron: FULL, daemon: FULL },
  },
  {
    id: 'home',
    summary: '打开浏览器入口（自定义主页或 TabWeb 工作区）',
    runtimes: {
      electron: FULL,
      daemon: {
        level: 'unsupported',
        note: '主页配置与 TabWeb 工作区都属于 Electron Renderer 的本地产品 surface，Daemon 没有对应界面。',
      },
    },
  },
  {
    id: 'act',
    summary: '执行动作序列（click/fill/scroll 等，走 browser-core）',
    runtimes: { electron: FULL, daemon: FULL },
  },
  {
    // 命令面重设计：原 observe（默认清单）+ snapshot（--tree / --screenshot）收编。
    id: 'glance',
    summary: '看交互：观察页面可交互元素（--tree 全量 a11y 树；--screenshot 截图/SoM）',
    runtimes: {
      electron: FULL,
      daemon: {
        level: 'degraded',
        note: 'glance --tree（原 snapshot 全量树）Daemon 已对齐富快照（a11y tree + DOM， BR-4(B)）；残留：daemon act 暂不能回解全量树的 eN 元素引用（无 RefCache，归 BR-8 WS-B），故保留 degraded。默认清单模式双端一致。',
      },
    },
  },
  {
    id: 'eval',
    summary: '在页面执行 JavaScript 表达式',
    runtimes: { electron: FULL, daemon: FULL },
  },
  {
    id: 'wait',
    summary: '等待选择器出现或固定时长',
    runtimes: { electron: FULL, daemon: FULL },
  },
  {
    // 命令面重设计：原 extract + markdown + pdf 收编，始终落盘。
    id: 'print',
    summary: '导出页面内容到文件（text/markdown/html/json/pdf，--save 必填）',
    runtimes: { electron: FULL, daemon: FULL },
  },
  {
    id: 'nav',
    summary: '导航 back/forward/reload/stop',
    runtimes: { electron: FULL, daemon: FULL },
  },
  {
    id: 'network',
    summary: '网络请求日志',
    // BR-8 P2：daemon 经 BrowserContext.onCDPEvent 常驻喂 CDP 事件进 browser-core
    // runtime 缓冲，/network 返回历史日志（非旧窗口快照），双端 live 实测同形 → full。
    runtimes: { electron: FULL, daemon: FULL },
  },
  {
    id: 'network.to-api',
    summary: '从网络日志生成 OpenAPI 3.1 草案',
    runtimes: {
      electron: FULL,
      daemon: {
        level: 'degraded',
        note: 'Daemon 可分析离线 NetworkLogEntry[] / network JSON；但 runtime network 缓冲通常不捕获 request/response body，schema 推断弱于 Electron。',
      },
    },
  },
  {
    id: 'console',
    summary: '控制台日志',
    // BR-8 P2：同 network，daemon /console 返回历史日志、双端 live 实测同形 → full。
    runtimes: { electron: FULL, daemon: FULL },
  },
  {
    id: 'batch',
    summary: '批量执行多个 browser 子操作',
    runtimes: { electron: FULL, daemon: FULL },
  },
  {
    id: 'clear-session',
    summary: '清除会话数据（cookie/localStorage/cache）',
    runtimes: { electron: FULL, daemon: FULL },
  },
  {
    id: 'random-ua',
    summary: '获取随机 User-Agent',
    runtimes: { electron: FULL, daemon: FULL },
  },

  // ── tab（4）─────────────────────────────────────────────────────
  {
    id: 'tab.list',
    summary: '列出当前 tab',
    runtimes: { electron: FULL, daemon: FULL },
  },
  {
    id: 'tab.switch',
    summary: '切换活跃 tab',
    runtimes: { electron: FULL, daemon: FULL },
  },
  {
    id: 'tab.close',
    summary: '关闭 tab',
    runtimes: { electron: FULL, daemon: FULL },
  },
  {
    id: 'tab.state',
    summary: 'Tab 状态（url/title/可前进后退）',
    runtimes: {
      electron: FULL,
      daemon: {
        level: 'degraded',
        note: 'Daemon 已补 isLoading + 经 CDP Page.getNavigationHistory 支持 --include-history（ BR-4(A)）；保留 degraded 待 tab-target live 复验后再上调。',
      },
    },
  },

  // ── resource（7）────────────────────────────────────────────────
  {
    id: 'resource.list',
    summary: '列出页面检测到的资源',
    runtimes: {
      electron: FULL,
      daemon: {
        level: 'degraded',
        note: 'Daemon 依赖 ResourceTracker，不可用时降级 Performance API，无 Electron 常驻资源中心的完整媒体识别。',
      },
    },
  },
  {
    id: 'resource.inspect',
    summary: '查看单个资源详情',
    runtimes: {
      electron: FULL,
      daemon: {
        level: 'degraded',
        note: 'Daemon 只能查 ResourceTracker 已捕获的条目，无常驻资源中心。',
      },
    },
  },
  {
    id: 'resource.capture',
    summary: '捕获资源',
    runtimes: {
      electron: FULL,
      daemon: {
        level: 'degraded',
        note: 'Daemon 仅能对 ResourceTracker 已追踪资源操作，能力弱于 Electron 资源中心。',
      },
    },
  },
  {
    id: 'resource.download',
    summary: '下载资源（按 url/resourceId）',
    runtimes: { electron: FULL, daemon: FULL },
  },
  {
    id: 'resource.probe',
    summary: '主动探测页面媒体元素（video/audio/blob）',
    runtimes: { electron: FULL, daemon: FULL },
  },
  {
    id: 'resource.smart-download',
    summary: '智能下载页面主要媒体资源',
    runtimes: {
      electron: FULL,
      daemon: {
        level: 'degraded',
        // BR-4：Daemon 现可从页面自动挑选媒体（ResourceTracker 网络捕获 + DOM <video>/<audio>
        // + HLS/DASH 流），与 Electron 共用 browser-core 同一选择器（selectSmartDownloadTarget）。
        // 仍 degraded 的唯一残留：页面内 MediaSource blob（page_bound_blob）无头端无法捕获，诚实 501 降级。
        note: 'Daemon 现可从页面自动挑选媒体（ResourceTracker 网络捕获 + DOM 媒体元素 + HLS/DASH 流），与 Electron 共用 browser-core 选择器；仅页面内 MediaSource blob（page_bound_blob）无头端无法捕获，诚实降级。BR-4。',
      },
    },
  },

  // ── stream（3）──────────────────────────────────────────────────
  {
    id: 'stream.parse',
    summary: '解析流媒体清单（m3u8/mpd）',
    runtimes: { electron: FULL, daemon: FULL },
  },
  {
    id: 'stream.download',
    summary: '下载流媒体',
    runtimes: { electron: FULL, daemon: FULL },
  },
  {
    id: 'stream.info',
    summary: '查看流媒体详情（画质/时长/分片）',
    runtimes: { electron: FULL, daemon: FULL },
  },

  // ── session（7）─────────────────────────────────────────────────
  {
    id: 'session.list',
    summary: '列出命名会话',
    runtimes: { electron: FULL, daemon: FULL },
  },
  {
    id: 'session.create',
    summary: '创建命名会话',
    runtimes: { electron: FULL, daemon: FULL },
  },
  {
    id: 'session.switch',
    summary: '切换命名会话',
    runtimes: { electron: FULL, daemon: FULL },
  },
  {
    id: 'session.close',
    summary: '关闭命名会话',
    runtimes: { electron: FULL, daemon: FULL },
  },
  {
    id: 'session.close-all',
    summary: '关闭所有命名会话',
    runtimes: { electron: FULL, daemon: FULL },
  },
  {
    id: 'session.save',
    summary: '保存会话状态',
    runtimes: {
      electron: FULL,
      daemon: {
        level: 'degraded',
        note: 'BW-2：Daemon 已支持 cookies/localStorage/sessionStorage 主链；但 IndexedDB 未覆盖，同 origin 多 tab 的 sessionStorage 只能按 origin 存一份，且导出登录态属于敏感数据。',
      },
    },
  },
  {
    id: 'session.load',
    summary: '加载会话状态',
    runtimes: {
      electron: FULL,
      daemon: {
        level: 'degraded',
        note: 'BW-2：Daemon 已支持 cookies/localStorage/sessionStorage 主链；默认 mode=merge，可选 mode=replace；sessionStorage 缺页默认跳过，显式 openMissingOrigins 才打开 origin 页。',
      },
    },
  },

  // ── cookies（3）─────────────────────────────────────────────────
  {
    id: 'cookies.get',
    summary: '获取 Cookie',
    runtimes: { electron: FULL, daemon: FULL },
  },
  {
    id: 'cookies.set',
    summary: '设置 Cookie',
    // BR-1 已合 main：Daemon 现收 set 作 add 别名，cookies set 双端真生效（不再 400 / 不再静默退化）。
    runtimes: { electron: FULL, daemon: FULL },
  },
  {
    id: 'cookies.clear',
    summary: '清除 Cookie',
    runtimes: { electron: FULL, daemon: FULL },
  },

  // ── record（3）──────────────────────────────────────────────────
  {
    id: 'record.start',
    summary: '开始录制',
    runtimes: {
      electron: FULL,
      daemon: {
        level: 'degraded',
        note: 'Daemon 用 RecordingManager 录动作脚本（非 Electron 逐帧截屏），--fps 被忽略。',
      },
    },
  },
  {
    id: 'record.stop',
    summary: '停止录制',
    runtimes: {
      electron: FULL,
      daemon: {
        level: 'degraded',
        note: 'Daemon 录制为动作脚本模型（非逐帧），产物与 Electron 不同。',
      },
    },
  },
  {
    id: 'record.status',
    summary: '查看录制状态',
    runtimes: {
      electron: FULL,
      daemon: {
        level: 'degraded',
        note: 'Daemon 录制为动作脚本模型，状态语义与 Electron 逐帧录制不同。',
      },
    },
  },

  // ── replay（2）──────────────────────────────────────────────────
  {
    id: 'replay.run',
    summary: '回放录制',
    runtimes: {
      electron: FULL,
      daemon: {
        level: 'degraded',
        note: 'Daemon 回放录制的动作脚本（非逐帧），底层模型与 Electron 不同。',
      },
    },
  },
  {
    id: 'replay.list',
    summary: '列出录制',
    runtimes: {
      electron: FULL,
      daemon: {
        level: 'degraded',
        note: 'Daemon 仅列出动作脚本录制，无逐帧录制产物。',
      },
    },
  },

  // ── route（3，BR-2 请求拦截）────────────────────────────────────
  {
    id: 'route',
    summary: '拦截 / 改写匹配的网络请求',
    runtimes: {
      electron: FULL,
      daemon: {
        level: 'degraded',
        note: 'Daemon page.route 为 per-page、不跨导航持久；Electron 经 FC 维护可查询规则列表。BR-2/BR-4。',
      },
    },
  },
  {
    id: 'route-list',
    summary: '列出已注册的拦截规则',
    runtimes: {
      electron: FULL,
      daemon: {
        level: 'unsupported',
        note: 'Daemon /route-list 显式 501 NOT_IMPLEMENTED（page.route 为 per-page、规则不可枚举）；仅 Electron 维护规则列表。BR-2。',
      },
    },
  },
  {
    id: 'unroute',
    summary: '取消请求拦截',
    runtimes: {
      electron: FULL,
      daemon: {
        level: 'degraded',
        note: 'Daemon 按 url-pattern 取消（page.unroute，per-page）；Electron 按 route-list 返回的 ruleId。BR-2/BR-4。',
      },
    },
  },

  // ── job（2，BR-10 长任务异步 + 取消）─────────────────────────────
  // 长任务（如 stream download）传 --async 起 job、返回 jobId；job status 轮询、job cancel 中止。
  // job 运行时（BrowserJobManager）是 browser-core 进程级共享单例，两端各注入 → 双端 full。
  {
    id: 'job.status',
    summary: '查询异步任务进度 / 结果（按 jobId）',
    runtimes: { electron: FULL, daemon: FULL },
  },
  {
    id: 'job.cancel',
    summary: '取消异步任务（按 jobId，触发引擎中止）',
    runtimes: { electron: FULL, daemon: FULL },
  },
] as const

// ── 投影 / 查询（纯函数）───────────────────────────────────────────

/** 投影后单个 action 的精简视图（只含某一端那一列）。 */
export interface CapabilityProjectionEntry {
  id: string
  summary: string
  level: SupportLevel
  /** degraded / unsupported 时的原因；full 时不带。 */
  note?: string
}

/** `tabtin browser capabilities` 返回体形状（只投影「我这一端」那一列）。 */
export interface CapabilityProjection {
  runtime: BrowserRuntime
  schemaVersion: number
  /** 各级别 action 数量统计，便于一眼看清这一端的能力轮廓。 */
  counts: Record<SupportLevel, number>
  actions: CapabilityProjectionEntry[]
}

/**
 * 把矩阵投影成「某一个运行时」那一列。
 *
 * 双端 route 都调它、只各传自己的 runtime —— 同源投影，**永不漂移**：
 * Electron route 传 'electron'，Daemon route 传 'daemon'，各拿各列。
 */
export function projectCapabilitiesForRuntime(runtime: BrowserRuntime): CapabilityProjection {
  const counts: Record<SupportLevel, number> = { full: 0, degraded: 0, unsupported: 0 }
  const actions: CapabilityProjectionEntry[] = BROWSER_CAPABILITY_MATRIX.map((cap) => {
    const support = cap.runtimes[runtime]
    counts[support.level] += 1
    return {
      id: cap.id,
      summary: cap.summary,
      level: support.level,
      ...(support.note ? { note: support.note } : {}),
    }
  })
  return {
    runtime,
    schemaVersion: CAPABILITY_MATRIX_VERSION,
    counts,
    actions,
  }
}

/** 返回所有 action id（稳定顺序 = 矩阵声明顺序）。 */
export function getBrowserActionIds(): string[] {
  return BROWSER_CAPABILITY_MATRIX.map((cap) => cap.id)
}

/** 按 id 查单个 action 能力定义；找不到返回 undefined。 */
export function getBrowserCapability(id: string): BrowserActionCapability | undefined {
  return BROWSER_CAPABILITY_MATRIX.find((cap) => cap.id === id)
}
