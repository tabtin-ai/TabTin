import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { OrganizationResourceItem, SpaceSummary } from '@/types/space-admin'
import { ExternalLink } from 'lucide-react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  displayPerson,
  formatDateTime,
  itemTypeLabel,
  spaceStatusLabel,
  spaceTypeLabel,
} from './organization-data-shared'

export type ResourcePreviewTarget =
  | { kind: 'space'; space: SpaceSummary }
  | { kind: 'content'; item: OrganizationResourceItem }

function PreviewField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid grid-cols-[108px_1fr] gap-3 border-b border-border/60 py-2.5 text-body last:border-0">
      <div className="text-muted-foreground">{label}</div>
      <div className="min-w-0 break-words">{value || '—'}</div>
    </div>
  )
}

export function contentDetailHref(item: OrganizationResourceItem, organizationId: string): string {
  const orgQuery = `organization_id=${encodeURIComponent(organizationId)}`
  switch (item.item_type) {
    case 'tabdoc':
    case 'document':
      return `/docs?${orgQuery}`
    case 'tabdata':
      return `/tables?${orgQuery}`
    case 'tabslide':
      return `/slides?${orgQuery}`
    case 'tabfiles':
    case 'file':
    case 'cloud_file':
      return `/assets?${orgQuery}`
    default:
      return item.space_id
        ? `/spaces/${item.space_id}`
        : `/spaces?organizationId=${encodeURIComponent(organizationId)}`
  }
}

export interface OrganizationResourcePreviewDialogProps {
  organizationId: string
  preview: ResourcePreviewTarget | null
  onClose: () => void
}

export function OrganizationResourcePreviewDialog({
  organizationId,
  preview,
  onClose,
}: OrganizationResourcePreviewDialogProps) {
  const navigate = useNavigate()

  return (
    <Dialog open={Boolean(preview)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {preview?.kind === 'space'
              ? preview.space.name?.trim() || '（无名称）'
              : preview?.item.title?.trim() || '（无标题）'}
          </DialogTitle>
          <DialogDescription>资源详情预览（运维只读）</DialogDescription>
        </DialogHeader>
        {preview?.kind === 'space' ? (
          <div className="rounded-md border bg-muted/20 px-3">
            <PreviewField
              label="类型"
              value={<Badge variant="outline">{spaceTypeLabel(preview.space.type)}</Badge>}
            />
            <PreviewField label="状态" value={spaceStatusLabel(preview.space.status)} />
            <PreviewField
              label="成员 / 资源"
              value={`${preview.space.member_count ?? '—'} / ${preview.space.resource_count ?? '—'}`}
            />
            <PreviewField label="空间 ID" value={preview.space.id} />
            <PreviewField label="创建时间" value={formatDateTime(preview.space.created_at)} />
            <PreviewField
              label="最近修改"
              value={formatDateTime(preview.space.last_activity_at || preview.space.updated_at)}
            />
            {preview.space.description ? (
              <PreviewField label="说明" value={preview.space.description} />
            ) : null}
          </div>
        ) : preview?.kind === 'content' ? (
          <div className="rounded-md border bg-muted/20 px-3">
            <PreviewField
              label="类型"
              value={<Badge variant="outline">{itemTypeLabel(preview.item.item_type)}</Badge>}
            />
            <PreviewField
              label="所属空间"
              value={preview.item.space_name?.trim() || preview.item.space_id || '—'}
            />
            <PreviewField
              label="创建人"
              value={displayPerson(preview.item.created_by_name, preview.item.created_by)}
            />
            <PreviewField
              label="最近修改人"
              value={displayPerson(preview.item.updated_by_name, preview.item.updated_by)}
            />
            <PreviewField label="创建时间" value={formatDateTime(preview.item.created_at)} />
            <PreviewField label="最近修改" value={formatDateTime(preview.item.updated_at)} />
            <PreviewField label="状态" value={preview.item.status || '—'} />
            <PreviewField label="条目 ID" value={preview.item.id} />
            <PreviewField label="资源 ID" value={preview.item.resource_id || '—'} />
          </div>
        ) : null}
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
          {preview?.kind === 'space' ? (
            <Button
              variant="outline"
              onClick={() => {
                const id = preview.space.id
                onClose()
                navigate(`/spaces/${id}`)
              }}
            >
              <ExternalLink className="mr-2 h-3.5 w-3.5" />
              打开空间页
            </Button>
          ) : preview?.kind === 'content' ? (
            <Button
              variant="outline"
              onClick={() => {
                const href = contentDetailHref(preview.item, organizationId)
                onClose()
                navigate(href)
              }}
            >
              <ExternalLink className="mr-2 h-3.5 w-3.5" />
              打开管理页
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
