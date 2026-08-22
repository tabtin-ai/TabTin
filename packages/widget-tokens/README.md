# @tabtin/widget-tokens

Widget design tokens + sandbox iframe HTML wrapper — single source of truth shared between **chat preview**, **Electron offscreen render**, and **Daemon offscreen render**.

## Why this package

Widget RFC §四 4.2 risk #1: "design tokens 注入和 chat 内 RichWidget 不一致 → 用户视觉漂移". This package is the cure — three call sites import the same wrapper builder + token bundle:

1. **Chat preview** (`apps/tabtin-electron/src/renderer/src/components/chat/RichContentRenderer.tsx`'s `wrapWidgetCode`) — rendered into the chat iframe via `srcDoc`.
2. **Electron offscreen render** (`apps/tabtin-electron/src/main/services/WidgetRenderService.ts`) — written to a temp file then `loadFile`'d in a hidden BrowserWindow, then `capturePage` produces the PNG.
3. **Daemon offscreen render** (`apps/tabtin-daemon/src/browser/DaemonBrowserService.ts.captureWidget`) — `page.setContent(wrapper)` then `page.screenshot()`.

If any one of those drifts off-pattern, the user sees "chat preview is one thing, mobile fallback image is another" — not acceptable.

## Public API

```ts
import {
  themeBundle,           // { light: string; dark: string } — CSS variable bundles
  WIDGET_CSP,            // sandbox iframe Content-Security-Policy
  buildWrapper,          // (code, options?) => HTML string
  buildWrapperStyle,     // (options?) => <style> body string (for tests)
  DEFAULT_VIEWPORT,      // { width: 680, height: 400 }
} from '@tabtin/widget-tokens'

const html = buildWrapper(svgCode, { theme: 'dark', width: 680, reducedMotion: true })
```

## How tokens are sourced

`scripts/extract-tokens.mjs` reads `apps/tabtin-electron/src/renderer/src/styles/globals.css`, extracts the `:root { ... }` and `.dark { ... }` declarations whitelisted in `WIDGET_TOKEN_NAMES`, and writes `src/theme-bundle.ts`.

**Why a build step**: globals.css is the chat UI's single source of truth. We don't want a separate hand-maintained widget palette — that would silently drift the moment chat UI changes a hue.

**Pipeline**: `pnpm build` runs the extract script first, then `tsup` to compile TS → ESM dist.

If `globals.css` schema changes (selector rename, missing token, etc.), the extract script `throw`s and `pnpm build` fails — fail-loud guard against silent drift.

## CSP — hard constraint

`WIDGET_CSP` is byte-for-byte identical to the `<meta http-equiv="Content-Security-Policy">` written by `RichContentRenderer.tsx`'s `wrapWidgetCode`. **DO NOT** change one side without changing the other; tests in this package + tests in `apps/tabtin-electron/src/renderer/src/components/chat/RichWidget.test.tsx` cross-check.

## Current scope (Wave 6 / 7 已完成)

- **Wave 6** — `buildWrapper` 接受 `format: 'svg' | 'html' | 'mermaid'`。Mermaid 的编译（源码 → SVG）由 TS runtime 在 `packages/agent-runtime/src/tools/show-widget/mermaid-compiler.ts` 的 `prepareWidgetSource()` 完成，使用 `mermaid` + `jsdom` Node SDK，在工具 execute 期间一次性编译 —— wrapper 本身不承载 Mermaid runtime，保持 "no runtime script" CSP 约束。
- **Wave 7** — `buildSendPromptBootstrap(widgetId)` 注入一段 IIFE 定义全局 `window.sendPrompt(text, meta?)`：带 2s trusted gesture 窗口（用户真实交互才放行）、1000 字符 text 上限、4KB meta JSON 上限、通过 `parent.postMessage({ type: 'tabtin:sendPrompt', ... }, '*')` 通道。renderer 侧 listener 见 `apps/tabtin-electron/src/renderer/src/services/widgetSendPromptHandler.ts`，再加 `sessionId:widgetId` 限流 + audit log + `via_widget:true` user message 反馈。
