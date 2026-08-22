/**
 * 嵌入式 Web App 通用 Home Section
 *
 * 为所有声明了 embeddedWeb 的 marketplace app 提供统一的主页展示。
 * 从 contextRegistry 读 handler 的 displayLabel/quickAction.icon，
 * 主 CTA 走 onCreateResource(appId) → createHandlers[appId] → openEmbeddedWebApp。
 */
import React, { useCallback } from 'react'
import { Button } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { contextRegistry } from '../instance'
import type { HomeSectionHandler, HomeSectionProps, ContextItemType } from '../types'

export function createEmbeddedWebHomeSection(appId: string): HomeSectionHandler {
  const Component: React.FC<HomeSectionProps> = ({ onCreateResource }) => {
    const { t } = useTranslation('context')
    const handler = contextRegistry.getHandler(appId as ContextItemType)

    const openApp = useCallback(() => {
      onCreateResource(appId)
    }, [onCreateResource])

    const icon = handler?.quickAction?.icon
    const label = handler?.displayLabel || appId

    return (
      <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
        {icon && <span className="text-muted-foreground/20 [&_svg]:h-8 [&_svg]:w-8">{icon}</span>}
        <p className="max-w-[280px] text-body text-muted-foreground">
          {t('home.embeddedWebApp.description', { appName: label })}
        </p>
        <Button
          type="button"
          size="sm"
          className="mt-1 h-7 gap-1.5 px-2 text-body"
          onClick={openApp}
        >
          {icon && <span className="[&_svg]:h-3 [&_svg]:w-3">{icon}</span>}
          {t('home.embeddedWebApp.open', { appName: label })}
        </Button>
      </div>
    )
  }
  Component.displayName = `EmbeddedWebAppHomeSection_${appId}`

  return {
    appId,
    labelKey: `home.assetBrowser.${appId}`,
    Component,
  }
}

const sections: HomeSectionHandler[] = []
for (const handler of contextRegistry.getAllHandlersRaw()) {
  if (handler.embeddedWeb?.baseUrl && handler.appId) {
    sections.push(createEmbeddedWebHomeSection(handler.appId))
  }
}

export { sections as embeddedWebAppHomeSections }
