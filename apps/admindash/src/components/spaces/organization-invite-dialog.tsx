import { spaceAdminApi } from '@/api/space-admin'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { OrganizationInvitationItem } from '@/types/space-admin'
import { Check, Copy, Link2, Smartphone, UserPlus } from 'lucide-react'
import { useState } from 'react'

type InviteTab = 'phone' | 'link' | 'userId'

export interface OrganizationInviteDialogProps {
  open: boolean
  organizationId: string
  onOpenChange: (open: boolean) => void
  onInvited: (invitation?: OrganizationInvitationItem) => void
}

export function OrganizationInviteDialog({
  open,
  organizationId,
  onOpenChange,
  onInvited,
}: OrganizationInviteDialogProps) {
  const [tab, setTab] = useState<InviteTab>('link')
  const [phone, setPhone] = useState('')
  const [userId, setUserId] = useState('')
  const [reason, setReason] = useState('')
  const [ticketId, setTicketId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [generatedLink, setGeneratedLink] = useState('')
  const [copied, setCopied] = useState(false)

  const reset = () => {
    setPhone('')
    setUserId('')
    setReason('')
    setTicketId('')
    setError(null)
    setGeneratedLink('')
    setCopied(false)
    setTab('link')
  }

  const handleOpenChange = (next: boolean) => {
    if (!next) reset()
    onOpenChange(next)
  }

  const ensureReason = () => {
    if (!reason.trim()) {
      setError('请填写操作原因')
      return false
    }
    return true
  }

  const handlePhoneInvite = async () => {
    if (!phone.trim()) {
      setError('请输入手机号')
      return
    }
    if (!ensureReason()) return
    setLoading(true)
    setError(null)
    try {
      const invitation = await spaceAdminApi.createPhoneInvitation(organizationId, {
        phone: phone.trim(),
        role: 'editor',
        reason: reason.trim(),
        ticket_id: ticketId.trim(),
      })
      onInvited(invitation)
      handleOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : '手机号邀请失败')
    } finally {
      setLoading(false)
    }
  }

  const handleUserIdInvite = async () => {
    if (!userId.trim()) {
      setError('请输入用户 ID')
      return
    }
    if (!ensureReason()) return
    setLoading(true)
    setError(null)
    try {
      const invitation = await spaceAdminApi.createDirectInvitation(organizationId, {
        user_id: userId.trim(),
        role: 'editor',
        reason: reason.trim(),
        ticket_id: ticketId.trim(),
      })
      onInvited(invitation)
      handleOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : '用户 ID 邀请失败')
    } finally {
      setLoading(false)
    }
  }

  const handleCreateLink = async () => {
    if (!ensureReason()) return
    setLoading(true)
    setError(null)
    try {
      const invitation = await spaceAdminApi.createLinkInvitation(organizationId, {
        role: 'editor',
        reason: reason.trim(),
        ticket_id: ticketId.trim(),
      })
      const nextLink = invitation.invite_url || ''
      if (!nextLink) {
        throw new Error('已创建邀请，但未返回可复制链接，请在下方列表查看或刷新后重试')
      }
      setGeneratedLink(nextLink)
      onInvited(invitation)
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建邀请链接失败')
    } finally {
      setLoading(false)
    }
  }

  const handleCopyLink = async () => {
    if (!generatedLink) return
    try {
      await navigator.clipboard.writeText(generatedLink)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('复制失败，请手动复制')
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>邀请成员</DialogTitle>
          <DialogDescription>
            手机号 / 链接 / 用户 ID 邀请需对方接受后入组。若要跳过同意立刻拉人，请用「直接添加成员」。写操作需填写原因。
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {(
            [
              { key: 'phone' as const, label: '手机号', icon: Smartphone },
              { key: 'link' as const, label: '链接', icon: Link2 },
              { key: 'userId' as const, label: '用户 ID', icon: UserPlus },
            ] as const
          ).map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                setTab(key)
                setError(null)
                setGeneratedLink('')
                setCopied(false)
              }}
              className={`flex flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1.5 text-body transition-colors ${
                tab === key
                  ? 'bg-background font-medium shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>

        <div className="rounded-md border bg-muted/20 px-3 py-2 text-body">
          授予角色：编辑者
          <span className="ml-2 text-caption text-muted-foreground">
            当前产品仅支持邀请为编辑者
          </span>
        </div>

        <div className="space-y-2">
          <div>
            <label className="block text-body font-medium" htmlFor="org-invite-reason">
              原因 <span className="text-destructive">*</span>
            </label>
            <Textarea
              id="org-invite-reason"
              className="mt-1"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="请说明代邀原因"
              disabled={loading}
            />
          </div>
          <div>
            <label className="block text-body font-medium" htmlFor="org-invite-ticket">
              工单号
            </label>
            <Input
              id="org-invite-ticket"
              className="mt-1"
              value={ticketId}
              onChange={(e) => setTicketId(e.target.value)}
              placeholder="可选"
              disabled={loading}
            />
          </div>
        </div>

        {error ? (
          <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-body text-destructive">
            {error}
          </div>
        ) : null}

        {tab === 'phone' ? (
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-body font-medium" htmlFor="org-invite-phone">
                手机号
              </label>
              <Input
                id="org-invite-phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="已注册用户的手机号"
                disabled={loading}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" disabled={loading} onClick={() => handleOpenChange(false)}>
                取消
              </Button>
              <Button disabled={loading} onClick={() => void handlePhoneInvite()}>
                发送邀请
              </Button>
            </DialogFooter>
          </div>
        ) : null}

        {tab === 'link' ? (
          <div className="space-y-3">
            {!generatedLink ? (
              <DialogFooter>
                <Button
                  variant="outline"
                  disabled={loading}
                  onClick={() => handleOpenChange(false)}
                >
                  取消
                </Button>
                <Button disabled={loading} onClick={() => void handleCreateLink()}>
                  生成链接
                </Button>
              </DialogFooter>
            ) : (
              <>
                <div className="space-y-1.5">
                  <div className="text-body font-medium">邀请链接（可复制）</div>
                  <div className="flex items-center gap-2 rounded-lg bg-muted p-2">
                    <code className="flex-1 break-all text-body" title={generatedLink}>
                      {generatedLink}
                    </code>
                    <Button variant="ghost" size="sm" onClick={() => void handleCopyLink()}>
                      {copied ? (
                        <Check className="h-3.5 w-3.5 text-success" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    variant="outline"
                    disabled={loading}
                    onClick={() => {
                      setGeneratedLink('')
                      setCopied(false)
                    }}
                  >
                    再生成一条
                  </Button>
                  <Button onClick={() => handleOpenChange(false)}>完成</Button>
                </DialogFooter>
              </>
            )}
          </div>
        ) : null}

        {tab === 'userId' ? (
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-body font-medium" htmlFor="org-invite-user-id">
                用户 ID
              </label>
              <Input
                id="org-invite-user-id"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                placeholder="目标用户 UUID"
                disabled={loading}
                className="font-mono"
              />
            </div>
            <DialogFooter>
              <Button variant="outline" disabled={loading} onClick={() => handleOpenChange(false)}>
                取消
              </Button>
              <Button disabled={loading} onClick={() => void handleUserIdInvite()}>
                发送邀请
              </Button>
            </DialogFooter>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
