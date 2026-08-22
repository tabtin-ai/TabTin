import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ArrowRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import { MODULE_GROUPS } from '../constants'
import type { BillingModuleShortcut } from '../types'

function ModuleShortcutCard({ title, href, icon: Icon, desc }: BillingModuleShortcut) {
  return (
    <Link to={href} className="group">
      <Card className="h-full border transition-colors hover:border-primary/40 hover:shadow-md">
        <CardContent className="flex items-start gap-3 p-4">
          <div className="rounded-md bg-primary/10 p-2 text-primary transition-colors group-hover:bg-primary/15">
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="font-medium">{title}</p>
              <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </div>
            <p className="mt-1 text-body leading-5 text-muted-foreground">{desc}</p>
          </div>
        </CardContent>
      </Card>
    </Link>
  )
}

export function BillingDashboardModuleMap() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-title font-semibold">模块地图</h2>
        <p className="text-body text-muted-foreground">
          按问题类型进入对应子模块，避免在多个页面间盲找入口。
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        {MODULE_GROUPS.map((group) => (
          <Card key={group.title} className="shadow-sm">
            <CardHeader>
              <CardTitle className="text-subtitle">{group.title}</CardTitle>
              <CardDescription>{group.description}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {group.items.map((item) => (
                <ModuleShortcutCard key={item.href} {...item} />
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
