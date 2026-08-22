import React from 'react'
import { Folder, Plus, Search, Check } from 'lucide-react'
import { cn } from '../../utils/cn'
import {
  StepPanelLayout,
  FontSize,
  FontWeight,
  ButtonStyles,
  BorderRadius,
  BorderColors,
  Transitions,
  InlineSpacing,
} from '../../constants/design-tokens'
import { t } from '../../i18n'

export interface SpaceOption {
  id: string
  name: string
  description?: string
  taskCount?: number
  updatedAt?: string
}

export interface SpaceSelectionPanelProps {
  spaces: SpaceOption[]
  selectedSpaceId?: string
  onSelect: (spaceId: string) => void
  onCreateNew?: () => void
  className?: string
}

export const SpaceSelectionPanel: React.FC<SpaceSelectionPanelProps> = ({
  spaces,
  selectedSpaceId,
  onSelect,
  onCreateNew,
  className,
}) => {
  const [searchTerm, setSearchTerm] = React.useState('')

  const filteredSpaces = React.useMemo(() => {
    if (process.env.NODE_ENV === 'development' && !Array.isArray(spaces)) {
      console.error('[SpaceSelectionPanel] spaces must be an array, got:', spaces)
    }

    const safeSpaces = spaces || []
    if (!searchTerm) return safeSpaces
    const lowerTerm = searchTerm.toLowerCase()
    return safeSpaces.filter(p =>
      p.name.toLowerCase().includes(lowerTerm) ||
      p.description?.toLowerCase().includes(lowerTerm)
    )
  }, [spaces, searchTerm])

  return (
    <div className={cn('space-y-4', className)}>
      <div className="flex items-center justify-between gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            placeholder={t('spaceSelection.searchPlaceholder')}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className={cn(
              'w-full pl-9 pr-4 py-2',
              'bg-background border border-border rounded-md',
              'text-body focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500'
            )}
          />
        </div>

        {onCreateNew && (
          <button
            onClick={onCreateNew}
            className={cn(
              'h-9 px-4 py-2 rounded-md',
              'inline-flex items-center',
              'text-body font-medium',
              ButtonStyles.outline
            )}
          >
            <Plus className="w-4 h-4 mr-2" />
            {t('spaceSelection.newSpace')}
          </button>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 max-h-[400px] overflow-y-auto p-1">
        {filteredSpaces.length > 0 ? (
          filteredSpaces.map((space) => {
            const isSelected = selectedSpaceId === space.id
            return (
              <div
                key={space.id}
                onClick={() => onSelect(space.id)}
                className={cn(
                  'relative group p-4',
                  'border rounded-lg text-left',
                  Transitions.all,
                  'cursor-pointer',
                  isSelected
                    ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500'
                    : 'border-border bg-card hover:border-brand-300 hover:bg-muted/50'
                )}
              >
                <div className="flex items-start justify-between mb-2">
                  <div className={cn(
                    'p-2 rounded-md',
                    isSelected ? 'bg-brand-100 text-brand-600' : 'bg-muted text-muted-foreground group-hover:bg-background'
                  )}>
                    <Folder className="w-5 h-5" />
                  </div>
                  {isSelected && (
                    <div className="bg-brand-500 text-white rounded-full p-0.5">
                      <Check className="w-3 h-3" />
                    </div>
                  )}
                </div>

                <h3 className={cn(FontSize.body, FontWeight.semibold, 'mb-1 truncate')}>
                  {space.name}
                </h3>

                {space.description && (
                  <p className="text-body text-muted-foreground line-clamp-2 mb-2 h-8">
                    {space.description}
                  </p>
                )}

                <div className="flex items-center justify-between text-body text-muted-foreground mt-2 pt-2 border-t border-border/50">
                  <span>{t('spaceSelection.taskCount', { count: space.taskCount || 0 })}</span>
                  {space.updatedAt && (
                    <span>{new Date(space.updatedAt).toLocaleDateString()}</span>
                  )}
                </div>
              </div>
            )
          })
        ) : (
          <div className="col-span-full py-8 text-center text-muted-foreground">
            {searchTerm ? t('spaceSelection.empty.noMatch') : t('spaceSelection.empty.noSpaces')}
          </div>
        )}
      </div>
    </div>
  )
}
