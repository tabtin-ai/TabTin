import type { EditorView } from '@tiptap/pm/view'
import { DOMParser as ProseMirrorDOMParser } from '@tiptap/pm/model'

interface PasteHandlerOptions {
  getDocId: () => string | undefined
  getEditorInstance: () => {
    storage: { markdown?: { parser?: { parse: (text: string) => string } } } }
  | null
  createUploadFn: (docId: string) => (file: File, view: EditorView, pos: number) => void
  uploadFn: (file: File, view: EditorView, pos: number) => void
  handleImagePaste: (
    view: EditorView,
    event: ClipboardEvent,
    upload: (file: File, view: EditorView, pos: number) => void,
  ) => boolean
}

function insertAsMarkdown(
  text: string,
  view: EditorView,
  event: ClipboardEvent,
  getEditorInstance: PasteHandlerOptions['getEditorInstance'],
): boolean {
  try {
    if (!text) return false
    const editor = getEditorInstance()
    if (!editor) return false
    const mdParser = editor.storage.markdown?.parser
    const parsedHtml = mdParser?.parse(text)
    if (!parsedHtml) return false
    const el = document.createElement('div')
    el.innerHTML = parsedHtml
    // BIZ-008: 清除事件处理器属性防止 XSS
    el.querySelectorAll('*').forEach(node => {
      const attrs = node.attributes
      for (let i = attrs.length - 1; i >= 0; i--) {
        if (attrs[i].name.startsWith('on')) {
          node.removeAttribute(attrs[i].name)
        }
      }
      if (node.tagName === 'SCRIPT' || node.tagName === 'IFRAME') {
        node.remove()
      }
    })
    const pmParser = ProseMirrorDOMParser.fromSchema(view.state.schema)
    const slice = pmParser.parseSlice(el, { preserveWhitespace: false })
    if (slice.content.childCount > 0) {
      event.preventDefault()
      const tr = view.state.tr.replaceSelection(slice)
      view.dispatch(tr.setMeta('paste', true))
      return true
    }
    return false
  } catch (e) {
    console.warn('[TabDoc] markdown paste failed:', e)
    return false
  }
}

function countMarkdownSignals(text: string): number {
  const sample = text.length > 2000 ? text.slice(0, 2000) : text
  return [
    /^#{1,6}\s/m,
    /^\s*[-*+]\s/m,
    /^\s*\d+\.\s/m,
    /^\s*>\s/m,
    /```/m,
    /\*\*[^*]+\*\*/m,
    /^\s*---\s*$/m,
    /\[.+?\]\(.+?\)/m,
    /^\|.+\|$/m,
    /!\[.*?\]\(.+?\)/m,
    /^\s*-\s\[[ x]\]/m,
  ].filter(re => re.test(sample)).length
}

export function createPasteHandler(options: PasteHandlerOptions) {
  const { getDocId, getEditorInstance, createUploadFn, uploadFn, handleImagePaste } = options

  return (view: EditorView, event: ClipboardEvent): boolean => {
    const files = event.clipboardData?.files
    if (files?.length) {
      const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'))
      if (imageFiles.length) {
        const docId = getDocId()
        const upload = docId ? createUploadFn(docId) : uploadFn
        if (imageFiles.length === 1) {
          return handleImagePaste(view, event, upload)
        }
        event.preventDefault()
        const pos = view.state.selection.from
        const docSize = view.state.doc.content.size
        for (let i = 0; i < imageFiles.length; i++) {
          upload(imageFiles[i], view, Math.min(pos + i, docSize))
        }
        return true
      }
    }

    const plainText = event.clipboardData?.getData('text/plain') || ''

    // ⓪ VS Code / code-editor detection:
    //    VS Code sets 'vscode-editor-data' with {mode:"markdown"}.
    //    Its HTML uses <div style="white-space:pre"> (NOT <pre>),
    //    so the <pre>-based detection below never fires.
    const vscodeMeta = event.clipboardData?.getData('vscode-editor-data')
    if (vscodeMeta) {
      try {
        const meta = JSON.parse(vscodeMeta) as { mode?: string }
        const mdModes = ['markdown', 'md', 'mdx', 'rmarkdown', 'quarto']
        if (meta.mode && mdModes.includes(meta.mode)) {
          if (insertAsMarkdown(plainText, view, event, getEditorInstance)) return true
        }
      } catch { /* ignore parse errors */ }
    }

    // Also handle code-editor HTML that uses styled <div> (not <pre>)
    // and the plain text looks like markdown source.
    const html = event.clipboardData?.getData('text/html')
    if (html && plainText) {
      const parsed = new DOMParser().parseFromString(html, 'text/html')
      const tempDiv = parsed.body
      const preElements = tempDiv.querySelectorAll('pre')

      if (preElements.length === 0) {
        // No <pre> — check if the HTML looks like code-editor output
        // (styled container with white-space:pre, no semantic HTML like <h1>/<p>/<ul>)
        const topEl = tempDiv.firstElementChild as HTMLElement | null
        if (topEl) {
          const styleAttr = topEl.getAttribute('style') || ''
          const wsMatch = styleAttr.match(/white-space\s*:\s*(pre(?:-wrap)?)\b/)
          const hasSemanticBlocks = tempDiv.querySelector('h1,h2,h3,h4,h5,h6,p,ul,ol,blockquote,table')
          if (wsMatch && !hasSemanticBlocks && countMarkdownSignals(plainText) >= 2) {
            if (insertAsMarkdown(plainText, view, event, getEditorInstance)) return true
          }
        }
      }

      if (preElements.length > 0) {
        const totalLength = tempDiv.textContent?.length || 0
        const preLength = Array.from(preElements).reduce(
          (sum, pre) => sum + (pre.textContent?.length || 0), 0
        )
        const preDominant = totalLength > 0 && preLength / totalLength > 0.5

        // ① If <pre> wraps markdown source (e.g., copied from VS Code .md),
        //    parse clipboard text/plain as markdown instead of inserting as code block.
        if (preDominant) {
          const hasMarkdownLang = Array.from(preElements).some(pre => {
            const code = pre.querySelector('code')
            if (!code) return false
            return Array.from(code.classList).some(cls =>
              cls === 'language-markdown' || cls === 'language-md'
            )
          })

          if ((hasMarkdownLang || countMarkdownSignals(plainText) >= 2) && plainText) {
            if (insertAsMarkdown(plainText, view, event, getEditorInstance)) return true
          }
        }

        // ② Check for syntax-highlighted code blocks (language-*, hljs, token classes)
        const hasCodeSignals = Array.from(preElements).some(pre => {
          const code = pre.querySelector('code')
          if (code) {
            const hasLangClass = Array.from(code.classList).some(cls =>
              (cls.startsWith('language-') && cls !== 'language-markdown' && cls !== 'language-md')
              || cls.startsWith('hljs')
            )
            if (hasLangClass) return true
          }
          return !!pre.querySelector(
            '[class*="hljs-"], [class*="token"], [class*="syntax-"]'
          )
        })

        // ③ Non-code <pre> taking most of content → convert to paragraphs
        if (!hasCodeSignals && preDominant) {
          preElements.forEach(pre => {
            const text = pre.textContent || ''
            const lines = text.split('\n')
            const fragment = document.createDocumentFragment()
            lines.forEach(line => {
              const p = document.createElement('p')
              if (line.trim() === '') {
                p.innerHTML = '<br>'
              } else {
                p.textContent = line
              }
              fragment.appendChild(p)
            })
            pre.replaceWith(fragment)
          })

          const parser = ProseMirrorDOMParser.fromSchema(view.state.schema)
          const slice = parser.parseSlice(tempDiv, {
            preserveWhitespace: false,
          })

          if (slice.content.childCount > 0) {
            event.preventDefault()
            const tr = view.state.tr.replaceSelection(slice)
            view.dispatch(tr.setMeta('paste', true))
            return true
          }
        }
      }
    }

    return false
  }
}
