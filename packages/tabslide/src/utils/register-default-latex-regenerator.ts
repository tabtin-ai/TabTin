import { renderLatexToSvg } from './latex'
import { setLatexVisualRegenerator } from './latex-shared'

let registered = false

export function ensureDefaultLatexRendererRegistered(): void {
  if (registered) return

  setLatexVisualRegenerator((latexSource, color) => {
    const source = latexSource.trim()
    if (!source) return null

    try {
      const rendered = renderLatexToSvg(source, { display: true, color })
      return {
        svg: rendered.svg,
        ...(rendered.path ? { path: rendered.path } : {}),
        viewBox: rendered.viewBox,
      }
    } catch {
      return null
    }
  })

  registered = true
}
