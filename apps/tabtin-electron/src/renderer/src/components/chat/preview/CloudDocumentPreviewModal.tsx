import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@tabtin/smartsheet-ui'
import TabdocPanelApp from '@/components/context-space/tabdoc/TabdocPanelApp'
import { useCloudDocumentPreviewStore } from './useCloudDocumentPreviewStore'

export function CloudDocumentPreviewModal() {
  const target = useCloudDocumentPreviewStore(state => state.target)
  const close = useCloudDocumentPreviewStore(state => state.close)

  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) close() }}>
      <DialogContent className="flex h-[min(92vh,56rem)] w-[min(94vw,90rem)] max-w-none flex-col gap-0 overflow-hidden p-0">
        {target ? (
          <>
            <DialogHeader className="shrink-0 border-b border-border/60 px-5 py-3 pr-12">
              <DialogTitle className="truncate">{target.title || '在线文档'}</DialogTitle>
              <DialogDescription className="sr-only">
                在当前 Project 内预览并编辑任务生成的在线文档
              </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 flex-1">
              <TabdocPanelApp
                key={`${target.resourceSpaceId}:${target.documentId}:${target.openVersionHistory ? 'vh' : 'view'}`}
                appId="tabdoc"
                spaceId={target.resourceSpaceId}
                documentId={target.documentId}
                isPaneActive
                isVisible
                organizationIdOverride={target.organizationId}
                initialShowVersionHistory={Boolean(target.openVersionHistory)}
              />
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
