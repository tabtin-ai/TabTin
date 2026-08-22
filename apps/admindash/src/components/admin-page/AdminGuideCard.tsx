import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Lightbulb, Route } from 'lucide-react'
import { Link } from 'react-router-dom'

export interface AdminGuideAction {
  label: string
  to: string
  description?: string
}

interface AdminGuideCardProps {
  title: string
  what: string
  whenUse: string
  nextSteps: string[]
  faq?: string[]
  actions?: AdminGuideAction[]
}

export function AdminGuideCard({
  title,
  what,
  whenUse,
  nextSteps,
  faq = [],
  actions = [],
}: AdminGuideCardProps) {
  return (
    <Card className="border-primary/20 bg-primary/5 shadow-none">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-subtitle">
          <Lightbulb className="h-4 w-4 text-primary" />
          {title}
        </CardTitle>
        <CardDescription>{what}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 text-body md:grid-cols-[1.1fr_1fr]">
        <div className="space-y-2">
          <div>
            <div className="font-medium">什么时候用</div>
            <div className="text-muted-foreground">{whenUse}</div>
          </div>
          <div>
            <div className="font-medium">下一步去哪</div>
            <ul className="mt-1 space-y-1 text-muted-foreground">
              {nextSteps.map((step) => (
                <li key={step}>· {step}</li>
              ))}
            </ul>
          </div>
        </div>
        <div className="space-y-2">
          {faq.length > 0 ? (
            <div>
              <div className="font-medium">常见问题</div>
              <ul className="mt-1 space-y-1 text-muted-foreground">
                {faq.map((item) => (
                  <li key={item}>· {item}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {actions.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {actions.map((action) => (
                <Button key={`${action.label}-${action.to}`} asChild size="sm" variant="outline">
                  <Link to={action.to} title={action.description}>
                    <Route className="mr-2 h-3.5 w-3.5" />
                    {action.label}
                  </Link>
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}
