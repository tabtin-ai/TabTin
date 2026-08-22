import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface OrganizationOption {
  id: string
  name: string
  is_default?: boolean
}

interface SpaceOption {
  id: string
  name: string
  is_archived?: boolean
}

export interface TableHostContextCardProps {
  hasAccessToken: boolean
  currentPathname: string
  organizationIdInput: string
  spaceIdInput: string
  activeOrganizationId: string
  activeSpaceId: string
  isApplying: boolean
  contextOptionsLoading: boolean
  organizationOptions: OrganizationOption[]
  spaceOptions: SpaceOption[]
  onOrganizationIdInputChange: (value: string) => void
  onSpaceIdInputChange: (value: string) => void
  onOrganizationSelect: (organizationId: string) => void
  onSpaceSelect: (spaceId: string) => void
  onApplyContext: () => void
  onNavigateToLogin?: (fromPathname: string) => void
}

export function TableHostContextCard({
  hasAccessToken,
  currentPathname,
  organizationIdInput,
  spaceIdInput,
  activeOrganizationId,
  activeSpaceId,
  isApplying,
  contextOptionsLoading,
  organizationOptions,
  spaceOptions,
  onOrganizationIdInputChange,
  onSpaceIdInputChange,
  onOrganizationSelect,
  onSpaceSelect,
  onApplyContext,
  onNavigateToLogin,
}: TableHostContextCardProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-subtitle">运行上下文</CardTitle>
        <CardDescription>
          这里是 M4 Web 宿主壳层：通过 runtime ports 注入 `table-core`，并消费 `table-ui`
          controller。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!hasAccessToken && (
          <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-body text-warning">
            <div>未检测到 access_token，当前页面无法请求表格数据。</div>
            <div className="mt-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => onNavigateToLogin?.(currentPathname)}
              >
                前往登录
              </Button>
            </div>
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <div className="text-body text-muted-foreground">选择 organization</div>
            <Select
              value={organizationIdInput || undefined}
              onValueChange={onOrganizationSelect}
              disabled={!hasAccessToken || contextOptionsLoading || organizationOptions.length === 0}
            >
              <SelectTrigger>
                <SelectValue placeholder="请选择 organization" />
              </SelectTrigger>
              <SelectContent>
                {organizationOptions.map((organization) => (
                  <SelectItem key={organization.id} value={organization.id}>
                    {organization.name}
                    {organization.is_default ? '（默认）' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <div className="text-body text-muted-foreground">选择 Space</div>
            <Select
              value={spaceIdInput || undefined}
              onValueChange={onSpaceSelect}
              disabled={
                !hasAccessToken ||
                !organizationIdInput ||
                contextOptionsLoading ||
                spaceOptions.length === 0
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="请选择 Space" />
              </SelectTrigger>
              <SelectContent>
                {spaceOptions.map((space) => (
                  <SelectItem key={space.id} value={space.id}>
                    {space.name}
                    {space.is_archived ? '（已归档）' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="text-body text-muted-foreground">高级调试：也可手动输入 ID</div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <div className="text-body text-muted-foreground">organizationId</div>
            <Input
              value={organizationIdInput}
              onChange={(event) => onOrganizationIdInputChange(event.target.value)}
              placeholder="输入 organizationId"
              disabled={!hasAccessToken}
            />
          </div>
          <div className="space-y-1">
            <div className="text-body text-muted-foreground">spaceId</div>
            <Input
              value={spaceIdInput}
              onChange={(event) => onSpaceIdInputChange(event.target.value)}
              placeholder="输入 spaceId"
              disabled={!hasAccessToken}
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={onApplyContext} disabled={isApplying || !hasAccessToken}>
            加载 Space 表格
          </Button>
          <div className="text-body text-muted-foreground">
            active: {activeOrganizationId || '-'} / {activeSpaceId || '-'}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
