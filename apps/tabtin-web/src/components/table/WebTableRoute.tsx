/**
 * WebTableRoute — 表格路由页面
 *
 * 负责从 URL params 解析 tableId，配置 runtime context，
 * 然后将 tableId 传给 TablePaneView。
 */

import { useEffect } from 'react'
import { useTableLaunchContext } from '@/features/table/useTableLaunchContext'
import { configureWebTableRuntime } from '@/features/table/bootstrap'
import { isValidTableId } from '@/features/table/tableId'
import { TablePaneView } from './TablePaneView'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

export function WebTableRoute() {
  const { organizationId, spaceId, tableId, buildHomePath } = useTableLaunchContext()
  const { t } = useTranslation('table')

  useEffect(() => {
    configureWebTableRuntime({ organizationId, spaceId })
  }, [organizationId, spaceId])

  if (!tableId || !isValidTableId(tableId)) {
    return (
      <div className="h-full flex items-center justify-center px-6">
        <div className="w-full max-w-xl rounded-2xl border border-border bg-background p-6 shadow-sm">
          <div className="text-title font-semibold text-foreground">
            {t('pane.invalidTableId', { defaultValue: 'Invalid table ID' })}
          </div>
          <div className="mt-2 text-body text-muted-foreground">
            {t('pane.invalidTableIdDesc', { defaultValue: 'Please select a table from the space list.' })}
          </div>
          <Link className="mt-4 inline-flex text-body text-primary hover:underline" to={buildHomePath()}>
            {t('pane.backHome', { defaultValue: 'Back to home' })}
          </Link>
        </div>
      </div>
    )
  }

  return <TablePaneView tableId={tableId} />
}
