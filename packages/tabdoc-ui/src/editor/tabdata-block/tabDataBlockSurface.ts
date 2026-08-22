export function resolveTabDataBlockSurfaceState(input: {
  inViewport: boolean
  hostVisible: boolean
  paneActive: boolean
}): { shouldRender: boolean; isInteractive: boolean } {
  const shouldRender = input.inViewport && input.hostVisible
  return {
    shouldRender,
    isInteractive: shouldRender && input.paneActive,
  }
}
