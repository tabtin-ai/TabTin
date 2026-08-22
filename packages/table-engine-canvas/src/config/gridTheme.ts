export interface CanvasGridTheme {
  fontFamily: string
  headerFont: string
  cellFont: string
  background: string
  surface: string
  text: string
  mutedText: string
  border: string
  cellLineActive: string
  cellBg: string
  cellBgLoading: string
  cellBgHovered: string
  cellBgSelected: string
  cellBgSelectedPrimary: string
  rowHeaderBg: string
  rowHeaderBgHovered: string
  rowHeaderBgSelected: string
  rowHeaderText: string
  columnHeaderBg: string
  columnHeaderBgFrozen: string
  columnHeaderBgHovered: string
  columnHeaderBgSelected: string
  columnHeaderText: string
  columnResizeHandle: string
  columnDragPlaceholderBg: string
  specialRowBg: string
  groupHeaderBgPrimary: string
  groupHeaderBgSecondary: string
  groupHeaderBgTertiary: string
  appendRowBg: string
  appendRowBgHovered: string
  accent: string
  interactionLine: string
  freezeMask: string
  freezeHandle: string
  freezeHandleActive: string
  searchCursorBg: string
  searchCursorStroke: string
  searchTargetBg: string
  commentBadgeBg: string
  commentBadgeText: string
}

export const canvasGridTheme: CanvasGridTheme = {
  fontFamily: 'var(--table-font-family, Inter, system-ui, sans-serif)',
  headerFont: '600 12px var(--table-font-family, Inter, system-ui, sans-serif)',
  cellFont: '500 12px var(--table-font-family, Inter, system-ui, sans-serif)',
  background: 'hsl(var(--background))',
  surface: 'hsl(var(--background))',
  text: 'hsl(var(--foreground))',
  mutedText: 'hsl(var(--muted-foreground))',
  border: 'hsl(var(--border) / 0.62)',
  cellLineActive: 'hsl(var(--foreground) / 0.62)',
  cellBg: 'hsl(var(--background))',
  cellBgLoading: 'hsl(var(--accent) / 0.08)',
  cellBgHovered: 'hsl(var(--accent) / 0.08)',
  cellBgSelected: 'hsl(var(--accent) / 0.12)',
  cellBgSelectedPrimary: 'hsl(var(--accent) / 0.18)',
  rowHeaderBg: 'hsl(var(--muted) / 0.26)',
  rowHeaderBgHovered: 'hsl(var(--muted) / 0.4)',
  rowHeaderBgSelected: 'hsl(var(--accent) / 0.22)',
  rowHeaderText: 'hsl(var(--muted-foreground))',
  columnHeaderBg: 'hsl(var(--muted) / 0.35)',
  columnHeaderBgFrozen: 'hsl(var(--muted) / 0.52)',
  columnHeaderBgHovered: 'hsl(var(--muted) / 0.56)',
  columnHeaderBgSelected: 'hsl(var(--accent) / 0.2)',
  columnHeaderText: 'hsl(var(--foreground) / 0.92)',
  columnResizeHandle: 'hsl(var(--foreground) / 0.28)',
  columnDragPlaceholderBg: 'hsl(var(--accent) / 0.08)',
  specialRowBg: 'hsl(var(--accent) / 0.06)',
  groupHeaderBgPrimary: 'hsl(var(--muted) / 0.28)',
  groupHeaderBgSecondary: 'hsl(var(--muted) / 0.36)',
  groupHeaderBgTertiary: 'hsl(var(--muted) / 0.46)',
  appendRowBg: 'hsl(var(--accent) / 0.06)',
  appendRowBgHovered: 'hsl(var(--accent) / 0.12)',
  accent: 'hsl(var(--accent))',
  interactionLine: 'hsl(var(--accent))',
  freezeMask: 'hsl(var(--background) / 0.85)',
  freezeHandle: 'hsl(var(--muted-foreground) / 0.7)',
  freezeHandleActive: 'hsl(var(--accent))',
  searchCursorBg: 'hsl(41 100% 58% / 0.24)',
  searchCursorStroke: 'hsl(36 100% 50% / 0.96)',
  searchTargetBg: 'hsl(45 100% 62% / 0.26)',
  commentBadgeBg: 'hsl(24 94% 56%)',
  commentBadgeText: 'hsl(0 0% 100%)',
}
