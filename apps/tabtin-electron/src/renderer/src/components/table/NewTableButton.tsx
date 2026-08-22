/**
 * 新建表格按钮组件
 * ：表格直属 Organization，不要求 Space
 */

import React, { useState } from 'react'
import { Plus } from 'lucide-react'
import { motion } from 'framer-motion'
import { CreateTableDialog, toast } from '@tabtin/smartsheet-ui'
import { useCreateTable, useTableStore } from '@/stores/useTableStore'
import { useResolvedOrganizationId } from '@/hooks/useResolvedOrganizationId'
import { useTranslation } from 'react-i18next'
import { prefillNewTableRows } from './utils/prefillNewTableRows'

export const NewTableButton: React.FC = () => {
  const { t } = useTranslation('table')
  const [isOpen, setIsOpen] = useState(false)
  const createTable = useCreateTable()
  const isLoading = useTableStore((state) => state.isLoading)
  const error = useTableStore((state) => state.error)

  const organizationId = useResolvedOrganizationId()
  const canCreateTable = Boolean(organizationId)

  const handleSubmit = async (data: {
    name: string
    description?: string
    icon?: string
  }) => {
    if (!organizationId) {
      console.error('未选中组织')
      return
    }

    try {
      const table = await createTable({
        organization_id: organizationId,
        ...data,
      })
      if (!table) {
        return
      }
      try {
        await prefillNewTableRows(table.id)
      } catch (seedError) {
        console.warn('[NewTableButton] 新建表格后预填空白行失败:', seedError)
        toast({
          title: t('newTable.prefillRowsFailed', {
            defaultValue: 'Table created, but failed to add initial rows. You can add records manually later.',
          }),
          description: seedError instanceof Error ? seedError.message : undefined,
          variant: 'destructive',
        })
      }
      setIsOpen(false)
    } catch (err) {
      console.error('创建表格失败:', err)
      toast({
        title: t('apiErrors.createFailed'),
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    }
  }

  if (!canCreateTable) {
    return (
      <motion.button
        disabled
        className="w-full flex items-center gap-2 px-3 py-2 text-body text-muted-foreground bg-muted rounded-md cursor-not-allowed opacity-50"
        title={t('newTable.disabledTitle')}
      >
        <Plus className="h-4 w-4" />
        {t('newTable.button')}
      </motion.button>
    )
  }

  return (
    <>
      <motion.button
        onClick={() => setIsOpen(true)}
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        className="w-full flex items-center gap-2 px-3 py-2 text-body bg-accent hover:bg-accent/90 text-accent-foreground rounded-md transition-colors"
      >
        <Plus className="h-4 w-4" />
        {t('newTable.button')}
      </motion.button>

      {organizationId && (
        <CreateTableDialog
          isOpen={isOpen}
          onClose={() => setIsOpen(false)}
          isLoading={isLoading}
          error={error}
          onSubmit={handleSubmit}
          organizationId={organizationId}
        />
      )}
    </>
  )
}
