import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useEffect, useState } from 'react'
import { type BulkBindingCandidateModel, scenesApi } from '../../api/scenes'
import { DOMAIN_LABELS } from './SceneTable'
import {
  type SceneBulkBindingGroup,
  areAllGroupsConfigured,
  buildBulkBindingUpdates,
  buildBulkCandidateSceneKeys,
  getInitialModelByDomain,
} from './sceneBulkBinding'

interface SceneBulkBindingDialogProps {
  groups: SceneBulkBindingGroup[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (updatedCount: number) => void | Promise<void>
}

export function SceneBulkBindingDialog({
  groups,
  open,
  onOpenChange,
  onSaved,
}: SceneBulkBindingDialogProps) {
  const [modelsByDomain, setModelsByDomain] = useState<Record<string, BulkBindingCandidateModel[]>>(
    {}
  )
  const [modelByDomain, setModelByDomain] = useState<Record<string, string>>({})
  const [loadingModels, setLoadingModels] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoadingModels(true)
    setError('')
    setModelByDomain({})

    scenesApi
      .listBindingCandidates(buildBulkCandidateSceneKeys(groups))
      .then((data) => {
        if (cancelled) return
        const candidatesByDomain = Object.fromEntries(
          data.groups.map((group) => [group.capability_domain, group.models])
        )
        const availableModelIds = new Set(
          data.groups.flatMap((group) => group.models.map((model) => model.id))
        )
        const initialModels = getInitialModelByDomain(groups)
        for (const domain of Object.keys(initialModels)) {
          if (!availableModelIds.has(initialModels[domain])) initialModels[domain] = ''
        }
        setModelsByDomain(candidatesByDomain)
        setModelByDomain(initialModels)
      })
      .catch((loadError: unknown) => {
        if (cancelled) return
        setError(loadError instanceof Error ? loadError.message : '加载可用模型失败')
      })
      .finally(() => {
        if (!cancelled) setLoadingModels(false)
      })

    return () => {
      cancelled = true
    }
  }, [groups, open])

  const canSave = areAllGroupsConfigured(groups, modelByDomain)

  const handleSave = async () => {
    setSaving(true)
    setError('')
    try {
      const updates = buildBulkBindingUpdates(groups, modelByDomain)
      const result = await scenesApi.updateBindings(updates)
      await onSaved(result.updated_count)
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : '批量换绑失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!saving) onOpenChange(nextOpen)
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>批量换绑主模型</DialogTitle>
          <DialogDescription>
            已选 {groups.reduce((total, group) => total + group.scenes.length, 0)}{' '}
            个场景。请为每种能力选择一个主模型；现有参数、超时和备用模型不会改变。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {groups.map((group) => {
            const domainModels = modelsByDomain[group.capabilityDomain] ?? []
            return (
              <section key={group.capabilityDomain} className="rounded-lg border p-4">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-medium">
                      {DOMAIN_LABELS[group.capabilityDomain] || group.capabilityDomain}
                    </h3>
                    <p className="text-caption text-muted-foreground">
                      {group.scenes.map((scene) => scene.display_name).join('、')}
                    </p>
                  </div>
                  <span className="shrink-0 text-caption text-muted-foreground">
                    {group.scenes.length} 个场景
                  </span>
                </div>
                <label className="space-y-1.5">
                  <span className="text-body font-medium">主模型</span>
                  <select
                    aria-label={`${DOMAIN_LABELS[group.capabilityDomain] || group.capabilityDomain}主模型`}
                    className="w-full rounded-md border bg-background px-3 py-2 text-body"
                    value={modelByDomain[group.capabilityDomain] ?? ''}
                    onChange={(event) =>
                      setModelByDomain((current) => ({
                        ...current,
                        [group.capabilityDomain]: event.target.value,
                      }))
                    }
                    disabled={loadingModels || saving}
                  >
                    <option value="">请选择主模型</option>
                    {domainModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.display_name} ({model.model_name})
                      </option>
                    ))}
                  </select>
                </label>
                {!loadingModels && domainModels.length === 0 ? (
                  <p className="mt-2 text-caption text-amber-700">该能力暂无可用的全局模型</p>
                ) : null}
              </section>
            )
          })}
        </div>

        {error ? (
          <div
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-caption text-red-700"
          >
            {error}
          </div>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            取消
          </Button>
          <Button type="button" onClick={handleSave} disabled={loadingModels || saving || !canSave}>
            {saving
              ? '换绑中...'
              : `换绑 ${groups.reduce((total, group) => total + group.scenes.length, 0)} 个场景`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
