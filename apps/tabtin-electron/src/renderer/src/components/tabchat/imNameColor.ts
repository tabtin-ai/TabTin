/**
 * imNameColor — 单列时间线昵称稳定取色（Discord 式彩色昵称处理手法）。
 *
 * 按 sender id 做稳定哈希，落到 globals.css 定义的 8 档 `--im-name-*` 色板之一。
 * 同一个人每次渲染颜色一致；色值经 CSS 变量出口，自动适配浅/深两套主题。
 * 不引入随机或纯文本可见的硬编码 hex——遵循设计系统「色彩走 token」。
 */

const NAME_COLOR_COUNT = 8

function hashString(input: string): number {
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

/** 返回该 id 对应的昵称色 CSS 值，如 `hsl(var(--im-name-3))`。 */
export function getNameColor(id: string | null | undefined): string {
  if (!id) return 'hsl(var(--foreground))'
  const index = (hashString(id) % NAME_COLOR_COUNT) + 1
  return `hsl(var(--im-name-${index}))`
}
