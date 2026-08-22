import React from 'react'
import { IconImport, IconExport, IconPDF } from './icons'
import { PanelWrapper, PanelMenuItem, PanelDivider } from './shared'

type Translate = (key: string, options?: Record<string, unknown>) => string

const IconHistory = () => (
  <svg width={24} height={24} viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="14" cy="14" r="10" />
    <polyline points="14,8 14,14 18,16" />
  </svg>
)

export const FileMenu: React.FC<{
  onImportPPTX?: () => void
  onExportPPTX?: () => void
  onExportPDF?: () => void
  onOpenVersionHistory?: () => void
  translate: Translate
}> = ({ onImportPPTX, onExportPPTX, onExportPDF, onOpenVersionHistory, translate }) => (
  <PanelWrapper width={200} style={{ padding: '4px 0' }}>
    <div style={{ padding: '0 8px' }}>
      {onImportPPTX && (
        <PanelMenuItem icon={<IconImport />} label={translate('file.importPptx')} onClick={onImportPPTX} />
      )}
      {onImportPPTX && (onExportPPTX || onExportPDF) && <PanelDivider />}
      {onExportPPTX && (
        <PanelMenuItem icon={<IconExport />} label={translate('file.exportPptx')} onClick={onExportPPTX} />
      )}
      {onExportPDF && (
        <PanelMenuItem icon={<IconPDF />} label={translate('file.exportPdf')} onClick={onExportPDF} />
      )}
      {onOpenVersionHistory && (
        <>
          <PanelDivider />
          <PanelMenuItem icon={<IconHistory />} label={translate('file.versionHistory')} onClick={onOpenVersionHistory} />
        </>
      )}
    </div>
  </PanelWrapper>
)
