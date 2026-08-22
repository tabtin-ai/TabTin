import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const webRoot = new URL('../../..', import.meta.url)

test('mobile document keeps browser pan and pinch zoom available', () => {
  const html = readFileSync(new URL('index.html', webRoot), 'utf8')
  const mobileStyles = readFileSync(new URL(
    'src/components/doc/web-doc-mobile.css',
    webRoot,
  ), 'utf8')

  const viewport = html.match(/<meta\s+name="viewport"\s+content="([^"]+)"/i)?.[1] ?? ''
  assert.match(viewport, /user-scalable=yes/i)
  assert.match(viewport, /maximum-scale=(?:[3-9]|\d{2,})(?:\.\d+)?/i)
  assert.match(
    mobileStyles,
    /\.web-doc-surface--phone,\s*\.web-doc-surface--tablet\s*\{[^}]*touch-action:\s*pan-x pan-y pinch-zoom;/s,
  )
  assert.match(
    mobileStyles,
    /\.web-doc-surface--phone \.ProseMirror \.tableWrapper,\s*\.web-doc-surface--tablet \.ProseMirror \.tableWrapper\s*\{[^}]*overflow-x:\s*auto;[^}]*touch-action:\s*pan-x pan-y pinch-zoom;/s,
  )
  assert.match(
    mobileStyles,
    /\.web-doc-surface--phone \.ProseMirror table,\s*\.web-doc-surface--tablet \.ProseMirror table\s*\{[^}]*table-layout:\s*auto;[^}]*width:\s*max-content;[^}]*min-width:\s*100%;/s,
  )
  assert.match(
    mobileStyles,
    /\.web-doc-surface--phone \.ProseMirror table :is\(th, td\),\s*\.web-doc-surface--tablet \.ProseMirror table :is\(th, td\)\s*\{[^}]*min-width:\s*8rem;/s,
  )
})
