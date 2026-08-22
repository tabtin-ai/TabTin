import React, { useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  Button,
  Input,
  Label,
} from '@tabtin/smartsheet-ui'
import { Globe2, LayoutDashboard, Loader2, Rocket, PenLine, Briefcase, BookOpen } from 'lucide-react'
import { useCreateSiteDialog } from '@/stores/useCreateSiteDialog'

const templates = [
  {
    id: 'blank',
    icon: Globe2,
    labelKey: 'template.blank',
    defaultLabel: '空白站点',
    descKey: 'template.blankDesc',
    defaultDesc: 'React + Vite + Tailwind，从零开始',
  },
  {
    id: 'landing-page',
    icon: Rocket,
    labelKey: 'template.landingPage',
    defaultLabel: '落地页',
    descKey: 'template.landingPageDesc',
    defaultDesc: '产品介绍页，Hero + 功能 + CTA',
  },
  {
    id: 'dashboard',
    icon: LayoutDashboard,
    labelKey: 'template.dashboard',
    defaultLabel: '数据看板',
    descKey: 'template.dashboardDesc',
    defaultDesc: '接入 TabData 的数据可视化面板',
  },
  {
    id: 'blog',
    icon: PenLine,
    labelKey: 'template.blog',
    defaultLabel: '博客',
    descKey: 'template.blogDesc',
    defaultDesc: '文章列表 + 标签筛选',
  },
  {
    id: 'portfolio',
    icon: Briefcase,
    labelKey: 'template.portfolio',
    defaultLabel: '作品集',
    descKey: 'template.portfolioDesc',
    defaultDesc: '项目展示 + 个人介绍',
  },
  {
    id: 'docs',
    icon: BookOpen,
    labelKey: 'template.docs',
    defaultLabel: '文档站',
    descKey: 'template.docsDesc',
    defaultDesc: '侧边栏导航 + 内容页',
  },
] as const

const CreateSiteDialog: React.FC = () => {
  const { t } = useTranslation('tabsite')
  const { isOpen, close } = useCreateSiteDialog()

  const [name, setName] = useState('')
  const [selectedTemplate, setSelectedTemplate] = useState('blank')
  const [framework] = useState('react')
  const [creating, setCreating] = useState(false)

  const reset = useCallback(() => {
    setName('')
    setSelectedTemplate('blank')
    setCreating(false)
  }, [])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        close(null)
        reset()
      }
    },
    [close, reset],
  )

  useEffect(() => {
    return () => { close(null) }
  }, [close])

  const handleCreate = useCallback(async () => {
    if (creating) return
    setCreating(true)
    close({
      name: name.trim() || t('label.untitledSite', { defaultValue: '未命名站点' }),
      template: selectedTemplate,
      framework,
    })
    reset()
  }, [creating, name, selectedTemplate, framework, close, reset, t])

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t('dialog.createTitle', { defaultValue: '新建站点' })}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label>{t('dialog.siteName', { defaultValue: '站点名称' })}</Label>
            <Input
              placeholder={t('dialog.siteNamePlaceholder', { defaultValue: '输入站点名称' })}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && !creating && handleCreate()}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label>{t('dialog.selectTemplate', { defaultValue: '选择模板' })}</Label>
            <div className="grid grid-cols-3 gap-2">
              {templates.map((tpl) => {
                const Icon = tpl.icon
                const isSelected = selectedTemplate === tpl.id
                return (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => setSelectedTemplate(tpl.id)}
                    className={`flex flex-col items-center gap-1.5 rounded-lg border-2 px-3 py-3 text-center transition-colors ${
                      isSelected
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-primary/40'
                    }`}
                  >
                    <Icon
                      className={`h-6 w-6 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`}
                    />
                    <div>
                      <div className="text-body font-medium">
                        {t(tpl.labelKey, { defaultValue: tpl.defaultLabel })}
                      </div>
                      <div className="mt-0.5 text-caption text-muted-foreground">
                        {t(tpl.descKey, { defaultValue: tpl.defaultDesc })}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={creating}>
            {t('dialog.cancel', { defaultValue: '取消' })}
          </Button>
          <Button onClick={handleCreate} disabled={creating}>
            {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('dialog.create', { defaultValue: '创建' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default CreateSiteDialog
