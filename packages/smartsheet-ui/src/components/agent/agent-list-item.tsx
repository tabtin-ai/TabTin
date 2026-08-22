import React from 'react'
import { Space } from './types'

export interface AgentListItemProps {
  space: Space
  isSelected?: boolean
  onClick?: (space: Space) => void
}

export const AgentListItem: React.FC<AgentListItemProps> = ({
  space,
  isSelected = false,
  onClick,
}) => {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onClick?.(space)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onClick?.(space)
        }
      }}
      className={`
        group w-full flex items-center gap-2 px-2 py-1.5 rounded
        transition-all duration-150 cursor-pointer
        ${isSelected
          ? 'bg-accent/15 text-foreground'
          : 'hover:bg-accent/8 text-muted-foreground hover:text-foreground'
        }
      `}
    >
      {space.avatar ? (
        <img src={space.avatar} alt="" className="flex-shrink-0 h-5 w-5 rounded object-cover" />
      ) : (
        <span className="flex-shrink-0 h-5 w-5 rounded bg-accent/10 text-accent text-[11px] font-semibold flex items-center justify-center">
          {space.name?.charAt(0) || '📁'}
        </span>
      )}

      <span className={`flex-1 text-body truncate min-w-0 ${
        isSelected ? 'font-medium' : 'font-normal'
      }`}>
        {space.name}
      </span>
    </div>
  )
}
