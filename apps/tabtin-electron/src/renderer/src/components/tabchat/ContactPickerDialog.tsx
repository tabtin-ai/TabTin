/**
 * ContactPickerDialog — 选一个 organization 成员，把 TA 的名片发进当前会话。
 *
 * 数据：searchOrganizationMembers(organizationId, query)。单选 → onPick(member)，
 * 由调用方构造 contact 卡 metadata 发送（后端会以 DB 真实身份回填）。
 */

import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, User, IdCard } from 'lucide-react'
import { toast } from '@tabtin/smartsheet-ui'
import { Dialog, DialogContent, DialogTitle } from '@components/ui'
import { searchOrganizationMembers, type SearchMemberResult } from '@/services/tabchatApi'

interface Props {
  isOpen: boolean
  onClose: () => void
  organizationId: string | null
  onPick: (member: SearchMemberResult) => void | Promise<void>
}

export const ContactPickerDialog: React.FC<Props> = ({ isOpen, onClose, organizationId, onPick }) => {
  const { t } = useTranslation('tabchat')
  const [members, setMembers] = useState<SearchMemberResult[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [picking, setPicking] = useState(false)

  useEffect(() => {
    if (!isOpen || !organizationId) {
      setMembers([])
      return
    }
    let cancelled = false
    setLoading(true)
    searchOrganizationMembers(organizationId, query)
      .then((res) => {
        if (!cancelled) setMembers(res)
      })
      .catch((err) => {
        if (cancelled) return
        console.error('[TabChat] load members failed:', err)
        toast({ title: t('contactPickerLoadFailed', { defaultValue: '加载成员失败' }), variant: 'destructive' })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [isOpen, organizationId, query, t])

  const handlePick = async (member: SearchMemberResult) => {
    if (picking) return
    setPicking(true)
    try {
      await onPick(member)
      onClose()
      setQuery('')
    } catch (err) {
      console.error('[TabChat] send contact card failed:', err)
      toast({ title: t('contactShareFailed', { defaultValue: '发送名片失败' }), variant: 'destructive' })
    } finally {
      setPicking(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="w-[360px] max-w-[360px] max-h-[480px] p-0 gap-0 overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border/60">
          <IdCard className="h-4 w-4 text-muted-foreground" />
          <DialogTitle className="text-body font-medium">{t('contactPickerTitle', { defaultValue: '发送名片' })}</DialogTitle>
        </div>

        <div className="px-3 py-2 border-b border-border/30">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('contactPickerSearch', { defaultValue: '搜索成员' })}
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
          ) : members.length === 0 ? (
            <div className="flex items-center justify-center h-20 text-body text-muted-foreground">
              {t('contactPickerEmpty', { defaultValue: '没有可发送的成员' })}
            </div>
          ) : (
            members.map((member) => {
              const label = member.nickname || member.username || t('contactCardFallback', { defaultValue: '用户' })
              return (
                <button
                  key={member.id}
                  type="button"
                  disabled={picking}
                  onClick={() => handlePick(member)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-muted/40 transition-colors text-left disabled:opacity-50"
                >
                  <div className="h-8 w-8 rounded-full bg-accent/10 border border-accent/20 flex items-center justify-center flex-shrink-0 overflow-hidden">
                    {member.avatar ? (
                      <img src={member.avatar} alt={label} className="h-full w-full rounded-full object-cover" />
                    ) : label.charAt(0) ? (
                      <span className="text-accent text-body font-semibold">{label.charAt(0)}</span>
                    ) : (
                      <User className="h-4 w-4 text-accent" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-body truncate">{label}</div>
                    {member.username ? (
                      <div className="text-caption text-muted-foreground truncate">@{member.username}</div>
                    ) : null}
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
