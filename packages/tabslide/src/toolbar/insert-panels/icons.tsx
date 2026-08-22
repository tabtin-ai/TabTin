import React from 'react'

export const iconProps = {
  width: 24, height: 24, viewBox: '0 0 28 28',
  fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
}

export const IconText = () => (
  <svg {...iconProps}>
    <path d="M6 6H22V10" />
    <line x1="14" y1="6" x2="14" y2="22" />
    <line x1="10" y1="22" x2="18" y2="22" />
  </svg>
)

export const IconImage = () => (
  <svg {...iconProps}>
    <rect x="3" y="5" width="22" height="18" rx="2" fill="currentColor" fillOpacity={0.05} />
    <circle cx="10" cy="12" r="2.5" fill="currentColor" opacity={0.4} stroke="none" />
    <path d="M3 19l6-5 4 3 5-4 7 6" />
  </svg>
)

export const IconShape = () => (
  <svg {...iconProps}>
    <rect x="4" y="5" rx="2" width="20" height="18" fill="currentColor" fillOpacity={0.08} />
  </svg>
)

export const IconLine = () => (
  <svg {...iconProps}>
    <line x1="5" y1="23" x2="23" y2="5" />
    <circle cx="5" cy="23" r="2" fill="currentColor" stroke="none" />
    <circle cx="23" cy="5" r="2" fill="currentColor" stroke="none" />
  </svg>
)

export const IconTable = () => (
  <svg {...iconProps}>
    <rect x="3" y="5" width="22" height="18" rx="2" fill="currentColor" fillOpacity={0.05} />
    <line x1="3" y1="11" x2="25" y2="11" />
    <line x1="3" y1="17" x2="25" y2="17" />
    <line x1="10.33" y1="5" x2="10.33" y2="23" />
    <line x1="17.66" y1="5" x2="17.66" y2="23" />
  </svg>
)

export const IconChart = () => (
  <svg {...iconProps}>
    <line x1="7" y1="22" x2="7" y2="12" />
    <line x1="14" y1="22" x2="14" y2="6" />
    <line x1="21" y1="22" x2="21" y2="14" />
    <line x1="3" y1="22" x2="25" y2="22" />
  </svg>
)

export const IconLatex = () => (
  <svg {...iconProps}>
    <path d="M6 22l4-16" />
    <path d="M14 22l4-16" />
    <line x1="4" y1="14" x2="18" y2="14" />
    <line x1="8" y1="8" x2="22" y2="8" />
  </svg>
)

export const IconPlay = () => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
    <polygon points="5 3 19 12 5 21 5 3" />
  </svg>
)

export const IconFile = () => (
  <svg {...iconProps}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </svg>
)

export const IconImport = () => (
  <svg {...iconProps}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
)

export const IconExport = () => (
  <svg {...iconProps}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
)

export const IconPDF = () => (
  <svg {...iconProps}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="9" y1="15" x2="15" y2="15" />
    <line x1="9" y1="11" x2="15" y2="11" />
  </svg>
)
