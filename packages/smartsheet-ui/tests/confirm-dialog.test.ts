import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import path from 'node:path'

test('ConfirmDialog keeps a children render slot between header and footer', () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/confirm-dialog.tsx'),
    'utf8',
  )

  assert.match(source, /children\?: React\.ReactNode/)
  assert.match(source, /\{children \? <div className="space-y-3">\{children\}<\/div> : null\}/)
})

test('ConfirmDialog can restore TabData grid focus on close', () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/confirm-dialog.tsx'),
    'utf8',
  )

  assert.match(source, /restoreFocusOnClose\?: boolean/)
  assert.match(source, /shouldManageCloseFocus/)
  assert.match(source, /variant === 'destructive'/)
  assert.match(source, /onCloseAutoFocus=\{shouldManageCloseFocus \? handleCloseAutoFocus : undefined\}/)
  assert.match(source, /data-t-grid-container/)
})
