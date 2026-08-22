// 优先用 SSoT 的 BASE 拼接（VITE_COLLAB_WS_BASE + 路径）。
// 老的 VITE_SLIDE_COLLAB_WS_URL 仍透传支持，保留给 self-host / 紧急 override 场景。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SLIDE_COLLAB_BASE = (import.meta as any).env?.VITE_COLLAB_WS_BASE

export const SLIDE_COLLAB_WS_URL =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (import.meta as any).env?.VITE_SLIDE_COLLAB_WS_URL
  || (SLIDE_COLLAB_BASE ? `${SLIDE_COLLAB_BASE}/slide-collaboration` : 'ws://localhost:4100/slide-collaboration')

/** TabSlide 协作 — Y.js 已成为默认链路，Feature Flag 仅用于紧急禁用 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const SLIDE_COLLAB_ENABLED = (import.meta as any).env?.VITE_SLIDE_COLLAB_DISABLED !== 'true'
