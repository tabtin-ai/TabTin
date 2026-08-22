import { Check } from 'lucide-react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@tabtin/smartsheet-ui'
import { COLOR_SCHEMES, getColorSchemeById } from '@/constants/color-schemes'
import { useUIStore } from '@stores/useUIStore'
import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'

interface ColorSchemeMenuProps {
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'bottom' | 'left' | 'right'
  className?: string
}

export const ColorSchemeMenu: React.FC<ColorSchemeMenuProps> = ({
  align = 'end',
  side = 'top',
  className,
}) => {
  const { t } = useTranslation('theme')
  const colorScheme = useUIStore(state => state.colorScheme)
  const resolvedTheme = useUIStore(state => state.resolvedTheme)
  const setColorScheme = useUIStore(state => state.setColorScheme)

  const activeScheme = getColorSchemeById(colorScheme)
  const activePreview =
    resolvedTheme === 'dark' ? activeScheme.accentDark : activeScheme.accentLight

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn('h-8 w-8 text-muted-foreground hover:text-foreground', className)}
          title={t('colorScheme.toggle')}
        >
          <span
            className="h-3.5 w-3.5 rounded-full border border-border/60"
            style={{ backgroundColor: `hsl(${activePreview})` }}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        side={side}
        sideOffset={6}
      >
        {COLOR_SCHEMES.map((scheme) => {
          const preview =
            resolvedTheme === 'dark' ? scheme.accentDark : scheme.accentLight
          const isActive = scheme.id === colorScheme
          return (
            <DropdownMenuItem
              key={scheme.id}
              onSelect={() => setColorScheme(scheme.id)}
            >
              <span
                className="h-3 w-3 rounded-full border border-border/60"
                style={{ backgroundColor: `hsl(${preview})` }}
              />
              <span>{t(`colorScheme.options.${scheme.id}`)}</span>
              {isActive && <Check className="h-3.5 w-3.5 ml-auto" />}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
