/**
 * KaTeX preview helper for the math formula dialog.
 * Matches the editor's Mathematics extension (`throwOnError: false`).
 */
import katex from 'katex'

export interface MathPreviewResult {
  html: string
  error: string | null
}

export function renderMathPreview(latex: string): MathPreviewResult {
  const source = latex.trim()
  if (!source) {
    return { html: '', error: null }
  }

  try {
    return {
      html: katex.renderToString(source, {
        throwOnError: false,
        displayMode: true,
      }),
      error: null,
    }
  } catch (err) {
    return {
      html: '',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
