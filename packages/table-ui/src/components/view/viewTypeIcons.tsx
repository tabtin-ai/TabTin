import React from 'react'
import { Grid2x2, Calendar, PanelsTopLeft, LayoutGrid, Layers, ClipboardList } from 'lucide-react'

export const VIEW_TYPE_ICONS: Record<string, React.ReactNode> = {
  grid: <Grid2x2 className="h-3.5 w-3.5" />,
  kanban: <PanelsTopLeft className="h-3.5 w-3.5" />,
  calendar: <Calendar className="h-3.5 w-3.5" />,
  gallery: <LayoutGrid className="h-3.5 w-3.5" />,
  flashcard: <Layers className="h-3.5 w-3.5" />,
  form: <ClipboardList className="h-3.5 w-3.5" />,
}

export const getViewTypeIcon = (viewType: string): React.ReactNode => {
  return VIEW_TYPE_ICONS[viewType] ?? VIEW_TYPE_ICONS.grid
}
