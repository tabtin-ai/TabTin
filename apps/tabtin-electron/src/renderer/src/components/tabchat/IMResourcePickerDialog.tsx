/**
 * IMResourcePickerDialog — 选一个 TabData 表 / TabDoc 文档发进当前私信会话（TC-5 入口①）。
 *
 * 数据：按 conversation.organization_id 拉当前团队下可访问的表/文档，不再需要
 * Conversation.space_id 作为影子 Space anchor。单选 → onPick(ref)，由调用方决定暂存或直接分享。
 *
 * 必须走 Dialog Portal（与 ContactPickerDialog 同口径）：聊天 rail 带 isolate，
 * 手写 fixed 蒙层会被困在 rail stacking context，画布 ContextTabs 会露在蒙层之上。
 */

import React, { useState, useMemo, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, FileText, Table2, Plus } from 'lucide-react'
import { toast } from '@tabtin/smartsheet-ui'
import { Dialog, DialogContent, DialogTitle } from '@components/ui'
import type { SpaceContextItem } from '@/services/spaceApi'
import { contextItemToCardRef, type ImResourceCardRef } from '@/lib/imResourceCard'
import { loadResourcePickerItems } from './imResourcePickerData'

interface Props {
  isOpen: boolean
  onClose: () => void
  /** 当前 IM 会话所属团队；缺失时显示明确空态，不发起资源查询。 */
  organizationId: string | null
  onPick: (ref: ImResourceCardRef) => void | Promise<void>
}

export const IMResourcePickerDialog: React.FC<Props> = ({ isOpen, onClose, organizationId, onPick }) => {
  const { t } = useTranslation('tabchat')
  const [items, setItems] = useState<SpaceContextItem[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [picking, setPicking] = useState(false)
  const missingOrganization = !organizationId

  useEffect(() => {
    if (!isOpen) return
    if (!organizationId) {
      setItems([])
      setLoading(false)
      return
    }
    let cancelled = false
    setItems([])
    setLoading(true)
    loadResourcePickerItems(organizationId)
      .then((nextItems) => {
        if (cancelled) return
        setItems(nextItems)
      })
      .catch((err) => {
        if (cancelled) return
        setItems([])
        console.error('[TabChat] load resources failed:', err)
        toast({ title: t('resourcePickerLoadFailed', { defaultValue: '加载资源失败' }), variant: 'destructive' })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [isOpen, organizationId, t])

  const filtered = useMemo(() => {
    if (!query.trim()) return items
    const q = query.toLowerCase()
    return items.filter((it) => (it.title || '').toLowerCase().includes(q))
  }, [items, query])

  const handlePick = async (item: SpaceContextItem) => {
    if (picking) return
    const ref = contextItemToCardRef(item)
    if (!ref) return
    setPicking(true)
    try {
      await onPick(ref)
      onClose()
      setQuery('')
    } catch (err) {
      console.error('[TabChat] share resource failed:', err)
      toast({ title: t('resourceShareFailed', { defaultValue: '分享资源失败' }), variant: 'destructive' })
    } finally {
      setPicking(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="w-[360px] max-w-[360px] max-h-[480px] p-0 gap-0 overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border/60">
          <Plus className="h-4 w-4 text-muted-foreground" />
          <DialogTitle className="text-body font-medium">
            {t('resourcePickerTitle', { defaultValue: '分享资源' })}
          </DialogTitle>
        </div>

        <div className="px-3 py-2 border-b border-border/30">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('resourcePickerSearch', { defaultValue: '搜索表格 / 文档' })}
              className="w-full h-8 pl-8 pr-3 text-body bg-muted/30 border border-border/40 rounded-lg outline-none focus:border-accent/60 placeholder:text-muted-foreground/60 transition-colors"
              autoFocus
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto py-1">
          {loading ? (
            <div className="flex items-center justify-center h-20 text-body text-muted-foreground">
              {t('loading', { defaultValue: '加载中…' })}
            </div>
          ) : missingOrganization ? (
            <div className="flex items-center justify-center h-20 px-4 text-body text-muted-foreground text-center">
              {t('resourcePickerMissingOrganization', { defaultValue: '无法确定当前组织，暂不能加载资源' })}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center justify-center h-20 text-body text-muted-foreground">
              {t('resourcePickerEmpty', { defaultValue: '没有可分享的表格或文档' })}
            </div>
          ) : (
            filtered.map((item) => {
              const resourceRef = contextItemToCardRef(item)
              if (!resourceRef) return null

              const isTable = item.item_type === 'tabdata'
              const Icon = isTable ? Table2 : FileText
              return (
                <button
                  key={`${resourceRef.type}:${resourceRef.resourceId}`}
                  type="button"
                  disabled={picking}
                  onClick={() => handlePick(item)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-muted/40 transition-colors text-left disabled:opacity-50"
                >
                  <div className="h-8 w-8 rounded-lg bg-accent/10 border border-accent/20 flex items-center justify-center flex-shrink-0">
                    <Icon className="h-4 w-4 text-accent" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-body truncate">{item.title || (isTable ? t('resourceCardTable', { defaultValue: '表格' }) : t('resourceCardDocument', { defaultValue: '文档' }))}</div>
                    <div className="text-caption text-muted-foreground truncate">
                      {isTable ? t('resourceCardTable', { defaultValue: '表格' }) : t('resourceCardDocument', { defaultValue: '文档' })}
                      {item.space_name ? ` · ${item.space_name}` : ''}
                    </div>
                  </div>
                </button>
              )
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
