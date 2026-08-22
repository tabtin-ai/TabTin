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
import { Smartphone, UserPlus } from 'lucide-react'
import { useState } from 'react'

type AddTab = 'phone' | 'userId'

export interface OrganizationDirectAddDialogProps {
  open: boolean
  organizationId: string
  onOpenChange: (open: boolean) => void
  onAdded: () => void
}

/**
 * 后台直接拉人入组织：仅已注册用户，无需对方同意。
 * 与「邀请链接」入口分离。
 */
export function OrganizationDirectAddDialog({
  open,
  organizationId,
  onOpenChange,
  onAdded,
}: OrganizationDirectAddDialogProps) {
  const [tab, setTab] = useState<AddTab>('phone')
  const [phone, setPhone] = useState('')
  const [userId, setUserId] = useState('')
  const [reason, setReason] = useState('')
  const [ticketId, setTicketId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setPhone('')
    setUserId('')
    setReason('')
    setTicketId('')
    setError(null)
    setTab('phone')
  }

  const handleOpenChange = (next: boolean) => {
    if (!next) reset()
    onOpenChange(next)
  }

  const submit = async () => {
    if (!reason.trim()) {
      setError('请填写操作原因')
      return
    }
    if (tab === 'phone' && !phone.trim()) {
      setError('请输入已注册用户的手机号')
      return
    }
    if (tab === 'userId' && !userId.trim()) {
      setError('请输入用户 ID')
      return
    }

    setLoading(true)
    setError(null)
    try {
      await spaceAdminApi.addOrganizationMember(organizationId, {
        ...(tab === 'phone'
          ? { phone: phone.trim() }
          : { user_id: userId.trim() }),
        role: 'editor',
        reason: reason.trim(),
        ticket_id: ticketId.trim() || undefined,
      })
      onAdded()
      handleOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : '直接添加失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>直接添加成员</DialogTitle>
          <DialogDescription>
            仅支持已注册用户；提交后立即成为组织成员，无需对方同意。未注册手机号将失败，不会创建邀请。
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {(
            [
              { key: 'phone' as const, label: '手机号', icon: Smartphone },
              { key: 'userId' as const, label: '用户 ID', icon: UserPlus },
            ] as const
          ).map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                setTab(key)
                setError(null)
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
            与客户端可分配角色一致
          </span>
        </div>

        <div className="space-y-2">
          <div>
            <label className="block text-body font-medium" htmlFor="org-direct-add-reason">
              原因 <span className="text-destructive">*</span>
            </label>
            <Textarea
              id="org-direct-add-reason"
              className="mt-1"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="请说明直接添加原因"
              disabled={loading}
            />
          </div>
          <div>
            <label className="block text-body font-medium" htmlFor="org-direct-add-ticket">
              工单号
            </label>
            <Input
              id="org-direct-add-ticket"
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
          <div>
            <label className="mb-1 block text-body font-medium" htmlFor="org-direct-add-phone">
              手机号
            </label>
            <Input
              id="org-direct-add-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="已注册用户的手机号"
              disabled={loading}
            />
          </div>
        ) : (
          <div>
            <label className="mb-1 block text-body font-medium" htmlFor="org-direct-add-user-id">
              用户 ID
            </label>
            <Input
              id="org-direct-add-user-id"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="目标用户 UUID"
              disabled={loading}
              className="font-mono"
            />
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" disabled={loading} onClick={() => handleOpenChange(false)}>
            取消
          </Button>
          <Button disabled={loading} onClick={() => void submit()}>
            直接添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
