import { ElectronAPI } from '@electron-toolkit/preload'
import { TabTinAPI } from '../../../preload/index'
import type { Root } from 'react-dom/client'

declare global {
  interface Window {
    electron: ElectronAPI
    tabtin: TabTinAPI

    // ── 调试开关（开发时在控制台手动设置） ──
    __TABTIN_DEBUG_VIEW_RELOAD__?: boolean
    __TABTIN_DEBUG_TAB_SWITCH__?: boolean
    __TABTIN_DEBUG_DRAG_BOUNDS__?: boolean
    __TABTIN_DEBUG_CRAWL_BOUNDS__?: boolean

    // ── 调试快照/遥测 ──
    __TABTIN_DRAG_DEBUG_SNAPSHOT__?: () => unknown
    __TABTIN_DRAG_DEBUG_PRINT__?: () => string
    __TABTIN_DRAG_DEBUG_TEXT__?: string
    __TABTIN_DRAG_DEBUG_COPY__?: () => Promise<void>
    __TABTIN_DRAG_DEBUG_LAST__?: unknown
    __TABTIN_CHAT_TELEMETRY__?: { events: unknown[]; counters?: Record<string, number> }
    __TABTIN_CHAT_TELEMETRY_VERBOSE__?: boolean
    __TABTIN_CHAT_VIEWPORT_PROBE__?: {
      start(options: {
        scopeKey: string
        scroller: HTMLElement
        anchor?: HTMLElement | null
        anchorMessageKey?: string
      }): void
      stop(): void
      reset(): void
      sampleNow(): void
      snapshot(): {
        frames: import('@/components/chat/viewport/types').ConversationViewportFrame[]
        sampleErrorCount: number
        lastSampleErrorName?: string
      }
    }
    /** DEV：活的 useChatStore（避免 CDP 动态 import 命中 HMR 空实例；CDP 只读 getState） */
    __TABTIN_CHAT_STORE__?: { getState: () => unknown }
    /** DEV：活的 useChatRuntimeStore（ 等同约束：禁止 CDP 动态 import） */
    __TABTIN_CHAT_RUNTIME_STORE__?: { getState: () => unknown }
    /**
     * DEV：活的 useSubagentLiveStore（ dogfood；禁止 CDP 动态 import）。
     * 类型放宽为 unknown——Zustand setState 重载无法安全映射到 Window。
     */
    __TABTIN_SUBAGENT_LIVE_STORE__?: unknown
    /** DEV：活的 useSubagentSessionStore（ dogfood；禁止 CDP 动态 import） */
    __TABTIN_SUBAGENT_SESSION_STORE__?: unknown
    /** DEV：与 live store 同实例的 rAF flush（ dogfood） */
    __TABTIN_FLUSH_SUBAGENT_LIVE__?: () => void
    /** DEV： endSessionRun 停表契约 live 探针 */
    __TABTIN_PROBE_6529_END_SESSION_RUN__?: (sessionId?: string) => {
      ok: boolean
      reason?: string
      sid?: string
      bugStillReproducibleViaRemoveOnly?: boolean
      fixStopsTimer?: boolean
      afterRemoveOnly?: { busy: boolean; startedAt: number | null; endedAt: number | null }
      afterEnd?: {
        busy: boolean
        startedAt: number | null
        endedAt: number | null
        phase: string | null
      }
    }
    /** DEV：模拟 DONE 终止（默认 text_loop_terminated）以验证异常停止气泡 */
    __TABTIN_MOCK_RUN_TERMINATION__?: (
      payload?: Record<string, unknown>,
      options?: import('@/stores/chat/dev/mockRunTerminationProbe').MockRunTerminationOptions,
    ) => import('@/stores/chat/dev/mockRunTerminationProbe').MockRunTerminationResult
    /** DEV：全部终止反馈 live case 目录 */
    __TABTIN_RUN_TERMINATION_LIVE_CASES__?: Array<{
      id: string
      payload: Record<string, unknown>
      expectTitle: string | null
      expectUnknown: boolean
      expectInterruptedBadge: boolean
      note?: string
    }>
    __TABTIN_WIDGET_SEND_PROMPT_EVENTS__?: unknown[]
    __TABTIN_LAYOUT_TELEMETRY__?: { events: unknown[]; counters?: Record<string, number> }
    __TABTIN_LAYOUT_TELEMETRY_VERBOSE__?: boolean
    __TABTIN_FS_WATCH_TELEMETRY__?: { events: unknown[]; counters?: Record<string, number> }
    __TABTIN_TABLE_ENGINE_METRICS__?: unknown
    __TABTIN_TABLE_ENGINE_METRICS_PRINT__?: () => unknown

    // ── 运行时/错误追踪 ──
    __TABTIN_LAST_REACT_ERROR__?: { message: string; stack?: string; componentStack?: string }
    __TABTIN_LOG_FILTER__?: string
    __lastSnapshotCount?: number
    __lastPartializeSeeds?: number
    __tabtin_auth_logout_event_bound__?: boolean
    __tabtin_report_offline?: () => void
    currentRunId?: string | null

    /** 部分构建/宿主在无 Vite 注入时由 main 写入的 API base */
    __TABTIN_API_BASE_URL__?: string

    // ── main.tsx 注入的共享实例 ──
    i18n?: { t: (key: string, opts?: Record<string, unknown>) => string; [k: string]: unknown }
    __useUIStore?: { getState: () => unknown; subscribe: (fn: () => void) => () => void }
    __tabtinNotify?: (typeof import('@/utils/notify'))['notify']
    __COLOR_SCHEMES?: Record<string, unknown>
    __TABTIN_REACT_ROOT__?: Root
  }

  // globalThis 上的调试变量
  var __TABTIN_DEBUG_VIEW_RELOAD__: boolean | undefined
  var __TABTIN_DEBUG_TAB_SWITCH__: boolean | undefined
  var __TABTIN_DEBUG_CRAWL_BOUNDS__: boolean | undefined
  var __TABTIN_LOG_FILTER__: string | undefined
  var __TABTIN_LAST_REACT_ERROR__: { message: string; stack?: string; componentStack?: string } | undefined
  var __lastPartializeSeeds: number | undefined
  var __lastSnapshotCount: number | undefined
  var __TABTIN_REACT_ROOT__: Root | undefined
}

// 扩展 CSS 模块类型
declare module '*.module.css' {
  const classes: { [key: string]: string }
  export default classes
}

declare module '*.module.scss' {
  const classes: { [key: string]: string }
  export default classes
}

// 扩展图片资源类型
declare module '*.png' {
  const src: string
  export default src
}

declare module '*.jpg' {
  const src: string
  export default src
}

declare module '*.jpeg' {
  const src: string
  export default src
}

declare module '*.svg' {
  const src: string
  export default src
}

declare module '*.svg?url' {
  const src: string
  export default src
}

declare module '*.gif' {
  const src: string
  export default src
}

// 扩展 Vite 环境变量
declare global {
  interface ImportMetaEnv {
    readonly VITE_APP_TITLE: string
    readonly VITE_APP_VERSION: string
    /** 构建期 git 短 SHA；须与 src/types/import-meta-env.d.ts 一致。 */
    readonly VITE_GIT_COMMIT: string
    /** 构建期 git 分支名；须与 src/types/import-meta-env.d.ts 一致。 */
    readonly VITE_GIT_BRANCH: string
    readonly VITE_API_BASE_URL?: string
    readonly VITE_DAEMON_CONTROL_API_BASE_URL?: string
    readonly VITE_PUBLIC_WEB_BASE_URL?: string
    readonly VITE_WEBSITE_BASE_URL?: string
    readonly VITE_USER_AGREEMENT_URL?: string
    readonly VITE_PRIVACY_POLICY_URL?: string
    readonly VITE_API_TIMEOUT?: string
    readonly VITE_CHAT_API_URL?: string
    readonly VITE_DEBUG_LOGS?: string
    readonly VITE_ALLOW_TEMP_TAB_UI?: string
    readonly VITE_ALLOW_ORPHAN_RECONCILE?: string
    readonly VITE_ALLOW_PERSISTED_VIEW_RESTORE?: string
    readonly VITE_LAYOUT_USE_RRPV4?: string
    readonly VITE_LAYOUT_USE_RRPV4_TABVIDEO?: string
    readonly VITE_LAYOUT_USE_RRPV4_FILE_EXPLORER?: string
    readonly VITE_LAYOUT_USE_RRPV4_TABCODE?: string
    readonly VITE_LAYOUT_USE_RRPV4_CRAWLSPACE?: string
    readonly VITE_LAYOUT_USE_RRPV4_CHAT_RAIL?: string
    readonly VITE_LAYOUT_USE_RRPV4_CHAT_SPLIT?: string
    readonly VITE_LAYOUT_USE_RRPV4_CANVAS_SPLIT?: string
    readonly VITE_CENTRIFUGO_WS_URL?: string
    readonly VITE_COLLAB_WS_BASE?: string
    readonly VITE_COLLAB_WS_URL?: string
    readonly VITE_TABLE_COLLAB_WS_URL?: string
    readonly VITE_SLIDE_COLLAB_WS_URL?: string
    readonly VITE_VIDEO_COLLAB_WS_URL?: string
    readonly VITE_CANVAS_COLLAB_WS_URL?: string
    /** Sentry DSN：空/未配置 = 不启用错误上报。
     *  类型须与 src/types/import-meta-env.d.ts 完全一致（declaration merging）。 */
    readonly VITE_SENTRY_DSN: string
    readonly DEV: boolean
    readonly PROD: boolean
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv
    readonly hot?: {
      accept: (...args: unknown[]) => void
      dispose: (callback: () => void) => void
    }
  }
}
