# @tabtin/doc-renderer

Host-agnostic markdown rendering utilities for TabTin Tabdoc.

## Scope
- configurable markdown renderer runtime adapter
- fallback basic markdown-to-html renderer
- html sanitize utility for safe preview

## Design Constraints
- No Electron-specific dependency.
- No import from `apps/tabtin-electron/**`.
- Host/UI framework can inject its own renderer implementation.

## Example
```ts
import {
  configureMarkdownRenderer,
  renderMarkdown,
} from '@tabtin/doc-renderer'

configureMarkdownRenderer({
  renderToHtml(markdown) {
    return `<article>${markdown}</article>`
  },
})

const result = await renderMarkdown('# Title')
console.log(result.html)
```

