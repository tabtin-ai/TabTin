import { describe, expect, it } from 'vitest'
import {
  NATIVE_VIEW_OVERLAY_ATTRIBUTE,
  countNativeViewBlockingOverlays,
} from './native-view-overlays'

describe('native-view-overlays', () => {
  it('counts custom overlays that should hide native browser views', () => {
    const root = document.createElement('div')
    const preview = document.createElement('div')
    preview.setAttribute(NATIVE_VIEW_OVERLAY_ATTRIBUTE, 'true')
    root.appendChild(preview)

    expect(countNativeViewBlockingOverlays(root)).toBe(1)
  })

  it('keeps ordinary dialogs out unless they opt into native-view blocking', () => {
    const root = document.createElement('div')
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    root.appendChild(dialog)

    expect(countNativeViewBlockingOverlays(root)).toBe(0)
  })

  it('continues to count existing open overlay selectors', () => {
    const root = document.createElement('div')
    const portal = document.createElement('div')
    portal.setAttribute('data-radix-portal', '')
    const openDialog = document.createElement('div')
    openDialog.setAttribute('role', 'dialog')
    openDialog.setAttribute('data-state', 'open')
    root.append(portal, openDialog)

    expect(countNativeViewBlockingOverlays(root)).toBe(2)
  })
})
