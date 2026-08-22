import React from 'react'

export const ic = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

export const PageIcon = () => <svg {...ic}><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/></svg>
export const MoveIcon = () => <svg {...ic}><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg>
export const TransformIcon = () => <svg {...ic}><path d="M21 12a9 9 0 1 1-6.219-8.56"/><polyline points="22 2 22 8 16 8"/></svg>
export const CloseIcon = () => <svg {...ic} width={14} height={14}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>

export const lic = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

export const EyeOpenIcon = () => <svg {...lic}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
export const EyeClosedIcon = () => <svg {...lic}><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
export const LockIcon = () => <svg {...lic}><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
export const UnlockIcon = () => <svg {...lic}><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>

export const BringForwardIcon = () => <svg {...lic}><rect x="8" y="8" width="12" height="12" rx="1"/><rect x="4" y="4" width="12" height="12" rx="1" opacity={0.4}/></svg>
export const SendBackwardIcon = () => <svg {...lic}><rect x="4" y="4" width="12" height="12" rx="1"/><rect x="8" y="8" width="12" height="12" rx="1" opacity={0.4}/></svg>
export const BringToFrontIcon = () => <svg {...lic}><rect x="8" y="8" width="12" height="12" rx="1"/><rect x="4" y="4" width="8" height="8" rx="1" opacity={0.3}/></svg>
export const SendToBackIcon = () => <svg {...lic}><rect x="4" y="4" width="12" height="12" rx="1" opacity={0.3}/><rect x="8" y="8" width="12" height="12" rx="1"/></svg>

export const TextLayerIcon = () => <svg {...lic}><path d="M4 7V4h16v3"/><path d="M12 4v16"/><path d="M8 20h8"/></svg>
export const ImageLayerIcon = () => <svg {...lic}><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none"/><path d="M21 15l-5-5L5 21"/></svg>
export const ShapeLayerIcon = () => <svg {...lic}><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
export const LineLayerIcon = () => <svg {...lic}><line x1="5" y1="19" x2="19" y2="5"/></svg>
export const ChartLayerIcon = () => <svg {...lic}><line x1="6" y1="20" x2="6" y2="14"/><line x1="12" y1="20" x2="12" y2="8"/><line x1="18" y1="20" x2="18" y2="12"/></svg>
export const TableLayerIcon = () => <svg {...lic}><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
export const LatexLayerIcon = () => <svg {...lic}><path d="M4 20l4-16"/><path d="M10 20l4-16"/><line x1="2" y1="14" x2="16" y2="14"/></svg>
export const VideoLayerIcon = () => <svg {...lic}><polygon points="5 3 19 12 5 21 5 3"/></svg>
export const AudioLayerIcon = () => <svg {...lic}><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
export const GroupLayerIcon = () => <svg {...lic}><rect x="2" y="10" width="8" height="8" rx="1"/><rect x="14" y="6" width="8" height="8" rx="1"/></svg>
