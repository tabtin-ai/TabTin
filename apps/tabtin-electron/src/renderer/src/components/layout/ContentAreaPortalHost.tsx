import React from 'react'
import { TablePanePortalProvider } from '@components/table/portal/TablePanePortalContext'
import { TablePanePortalLayer } from '@components/table/portal/TablePanePortalLayer'
import { TerminalPanePortalProvider } from '@components/terminal/portal/TerminalPanePortalContext'
import { TerminalPanePortalLayer } from '@components/terminal/portal/TerminalPanePortalLayer'
import { CrawlViewPortalProvider } from '@components/crawl/portal/CrawlViewPortalContext'
import { CrawlViewPortalLayer } from '@components/crawl/portal/CrawlViewPortalLayer'

interface ContentAreaPortalHostProps {
  enabled: boolean
  tableIds: string[]
  retentionTableIds?: string[]
  terminalSessionIds: string[]
  children: React.ReactNode
}

export const ContentAreaPortalHost: React.FC<ContentAreaPortalHostProps> = ({
  enabled,
  tableIds,
  retentionTableIds,
  terminalSessionIds,
  children,
}) => {
  if (!enabled) {
    return <>{children}</>
  }

  return (
    <TerminalPanePortalProvider>
      <TablePanePortalProvider>
        <CrawlViewPortalProvider>
          {children}
          <TablePanePortalLayer tableIds={tableIds} retentionTableIds={retentionTableIds} />
          <TerminalPanePortalLayer sessionIds={terminalSessionIds} />
          <CrawlViewPortalLayer />
        </CrawlViewPortalProvider>
      </TablePanePortalProvider>
    </TerminalPanePortalProvider>
  )
}
