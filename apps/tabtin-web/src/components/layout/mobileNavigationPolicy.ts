import type { WebPresentationEnvironment } from './WebPresentationEnvironment'
import {
  isPhoneWebPresentation,
  isTabletWebPresentation,
} from './WebPresentationEnvironment'

export function shouldUseMobileNavigation(
  presentation: Pick<WebPresentationEnvironment, 'layout' | 'input' | 'mobileHost'> & {
    isEmbedded: boolean
  },
): boolean {
  if (presentation.isEmbedded) return false
  if (isPhoneWebPresentation(presentation)) return true

  return presentation.layout === 'medium' && isTabletWebPresentation(presentation)
}
