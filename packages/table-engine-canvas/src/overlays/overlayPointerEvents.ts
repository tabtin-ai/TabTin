import type { SyntheticEvent } from 'react'

/** Prevent grid InteractionLayer from intercepting overlay menu pointer events. */
export const stopOverlayPointerEvent = (event: SyntheticEvent) => {
  event.stopPropagation()
  event.nativeEvent.stopImmediatePropagation()
}

export const isPrimaryMouseButton = (event: { button: number }) => event.button === 0
