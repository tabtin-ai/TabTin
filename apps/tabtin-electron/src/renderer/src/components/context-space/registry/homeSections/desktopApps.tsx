import React from 'react'
import { Grid2X2 } from 'lucide-react'
import type { HomeSectionHandler } from '../types'
import { DesktopAppsPane } from '@components/context-space/DesktopAppsPane'
import { DESKTOP_APPS_HOME_ID } from '@components/context-space/desktopAppsConstants'

const DesktopAppsSection: React.FC = () => <DesktopAppsPane />

export const desktopAppsHomeSection: HomeSectionHandler = {
  appId: DESKTOP_APPS_HOME_ID,
  // 独立页「更多应用」——勿复用 canvasRail.apps（工作台），否则会与工作台标签撞名。
  labelKey: 'desktop.apps.catalogTitle',
  Component: DesktopAppsSection,
  tabIcon: <Grid2X2 className="h-4 w-4 shrink-0 text-muted-foreground/80" />,
}
