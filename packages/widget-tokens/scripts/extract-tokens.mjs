#!/usr/bin/env node
/**
 * extract-tokens.mjs — 从 `apps/tabtin-electron/src/renderer/src/styles/globals.css`
 * 自动抽出 widget 烤图 / chat iframe 共用的 light + dark CSS 变量块，生成
 * `src/theme-bundle.ts`，导出：
 *
 *   - `themeBundle: { light: string; dark: string }`
 *   - `LIGHT_TOKEN_KEYS` / `DARK_TOKEN_KEYS`：用于测试守住"globals.css 的
 *     :root / .dark 段加新 token 后必须重跑 extract"
 *
 * **设计取舍**：
 *
 *   - **只抽 :root 和 .dark**——`[data-color-scheme="..."]` 是 chat UI 主题
 *     切换的多 scheme（blue/teal/...），widget 沿用主 scheme 即可，不为每
 *     scheme 各烤一份图（OffscreenWindowPool 资源 × N scheme 不可取）。
 *   - **过滤 widget 不需要的变量**：z-index / shadow / tabslide-* / type-*
 *     / table-font-* 这些是 chat UI / 其他模块专用，widget 烤图用不上，移除
 *     避免 wrapper CSS 体积无谓膨胀。**保留**核心色板 + 辅色 + radius，
 *     widget SVG 内 `hsl(var(--foreground))` / `hsl(var(--accent))` 等都依赖。
 *   - **构建时跑**：`pnpm build` 时跑 `node ./scripts/extract-tokens.mjs &&
 *     tsup`，确保 globals.css 改了之后 dist 也跟着更新。
 *
 * **失败 fail-loud**：globals.css 路径错 / :root 段缺失 / .dark 段缺失 →
 * 直接 throw 让构建失败。**绝对不留 silent 默认值**——否则 globals.css
 * 重构时 widget 跟着出 stale token 而无人察觉。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..', '..')
const GLOBALS_CSS = join(
  ROOT,
  'apps/tabtin-electron/src/renderer/src/styles/globals.css',
)
const OUTPUT_TS = join(__dirname, '..', 'src', 'theme-bundle.ts')

// widget 烤图需要的 token whitelist。改动需要同步 design-system.md 与 RichWidget。
// 维护原则：**保留**所有 chat UI 用到的"语义色"（background/foreground/muted/
// border/primary/accent/destructive/success/warning/info + 各自 -foreground +
// ring + input + radius）。widget SVG 内默认用 `hsl(var(--foreground))` /
// `hsl(var(--accent))`，缺这些 token 会让烤图丢色 → 与 chat 内 iframe 视觉漂移。
const WIDGET_TOKEN_NAMES = new Set([
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'success',
  'success-foreground',
  'warning',
  'warning-foreground',
  'info',
  'info-foreground',
  'border',
  'input',
  'ring',
  'radius',
])

/**
 * 提取一个 CSS selector 段（如 `:root { ... }`）的全部 `--foo: value` 声明。
 * 简单 brace counter：从 `selector {` 起跑到匹配 `}` 为止。
 *
 * 不调外部 PostCSS 等依赖——extract 是构建期跑的小脚本，依赖最小化。
 */
function extractBlock(css, selector) {
  const idx = css.indexOf(selector)
  if (idx < 0) return null
  // 找到 selector 后第一个 `{`
  const braceStart = css.indexOf('{', idx)
  if (braceStart < 0) return null
  let depth = 1
  let i = braceStart + 1
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth++
    else if (css[i] === '}') depth--
    i++
  }
  if (depth !== 0) return null
  return css.slice(braceStart + 1, i - 1)
}

/**
 * 从 block 内容里抽 widget whitelist 的 declarations，返回 `--name:value;`
 * 串（无换行无空格，直接可注入 `:root{ ... }`）。
 */
function extractWidgetTokens(blockBody) {
  const lines = blockBody.split(/\r?\n/)
  const out = []
  const keys = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('--')) continue
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx < 0) continue
    const name = trimmed.slice(2, colonIdx).trim() // 跳过 `--`
    if (!WIDGET_TOKEN_NAMES.has(name)) continue
    let value = trimmed.slice(colonIdx + 1).trim()
    if (value.endsWith(';')) value = value.slice(0, -1).trim()
    if (value.endsWith(',')) value = value.slice(0, -1).trim()
    out.push(`--${name}:${value};`)
    keys.push(name)
  }
  return { tokens: out.join(''), keys }
}

function main() {
  const css = readFileSync(GLOBALS_CSS, 'utf-8')
  const lightBody = extractBlock(css, ':root')
  if (!lightBody) {
    throw new Error(
      `[widget-tokens] :root block not found in ${GLOBALS_CSS}. ` +
      `globals.css schema changed? Re-check selector and fix this script.`,
    )
  }
  const darkBody = extractBlock(css, '.dark')
  if (!darkBody) {
    throw new Error(
      `[widget-tokens] .dark block not found in ${GLOBALS_CSS}. ` +
      `globals.css schema changed? Re-check selector and fix this script.`,
    )
  }
  const { tokens: light, keys: lightKeys } = extractWidgetTokens(lightBody)
  const { tokens: dark, keys: darkKeys } = extractWidgetTokens(darkBody)

  // light/dark 必须能匹配上一组 token——globals.css 漏写 dark 某 token
  // 必须立刻报警（widget 暗色烤图会缺色）。允许 dark 比 light 少 radius
  // 一类纯结构 token，但不允许少颜色 token。
  const colorOnly = (key) => key !== 'radius'
  const lightColors = lightKeys.filter(colorOnly)
  const darkColors = darkKeys.filter(colorOnly)
  const missing = lightColors.filter((k) => !darkColors.includes(k))
  if (missing.length > 0) {
    throw new Error(
      `[widget-tokens] light has color tokens not present in dark: ${missing.join(', ')}. ` +
      `Add these to .dark in globals.css or remove from WIDGET_TOKEN_NAMES.`,
    )
  }

  // light 必须含 foreground / background / border / accent 等核心 token，否则
  // 是抽错了或 globals.css 出了问题
  const required = ['background', 'foreground', 'border', 'accent']
  for (const r of required) {
    if (!lightKeys.includes(r)) {
      throw new Error(
        `[widget-tokens] required token "--${r}" missing from extracted light bundle. ` +
        `Check globals.css :root.`,
      )
    }
    if (!darkKeys.includes(r) && colorOnly(r)) {
      throw new Error(
        `[widget-tokens] required token "--${r}" missing from extracted dark bundle. ` +
        `Check globals.css .dark.`,
      )
    }
  }

  const ts = `/**
 * theme-bundle.ts — auto-generated by \`scripts/extract-tokens.mjs\` from
 * \`apps/tabtin-electron/src/renderer/src/styles/globals.css\`.
 *
 * **DO NOT EDIT BY HAND**. Regenerate with:
 *
 *   pnpm --filter @tabtin/widget-tokens run extract:tokens
 *
 * The widget rendering pipeline (Electron WidgetRenderService, Daemon
 * DaemonBrowserService.captureWidget, and chat-iframe RichWidget wrapper)
 * all import this module to keep design tokens in lock-step with the chat
 * UI. If you see widget visual drift from chat UI after a globals.css edit,
 * it means this file is stale — re-run extract.
 */

/** Tokens scoped under \`:root\` in globals.css (light theme baseline). */
export const LIGHT_TOKEN_BUNDLE = ${JSON.stringify(light)} as const

/** Tokens scoped under \`.dark\` in globals.css (dark theme override). */
export const DARK_TOKEN_BUNDLE = ${JSON.stringify(dark)} as const

/** Whitelisted token names extracted into the light bundle (for tests). */
export const LIGHT_TOKEN_KEYS: ReadonlyArray<string> = ${JSON.stringify(lightKeys)}

/** Whitelisted token names extracted into the dark bundle (for tests). */
export const DARK_TOKEN_KEYS: ReadonlyArray<string> = ${JSON.stringify(darkKeys)}

/**
 * Public bundle consumed by the renderer / main / daemon wrapper builders.
 *
 * Shape lets callers do \`tokens.light\` or \`tokens.dark\` with the same
 * string-concat ergonomics as the legacy hand-written const blocks.
 */
export const themeBundle = {
  light: LIGHT_TOKEN_BUNDLE,
  dark: DARK_TOKEN_BUNDLE,
} as const

export type ThemeBundle = typeof themeBundle
`

  writeFileSync(OUTPUT_TS, ts, 'utf-8')
  console.log(
    `[widget-tokens] extracted ${lightKeys.length} light tokens + ${darkKeys.length} dark tokens → ${OUTPUT_TS}`,
  )
}

main()
