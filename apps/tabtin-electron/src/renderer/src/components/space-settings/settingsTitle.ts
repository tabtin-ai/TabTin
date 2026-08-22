import i18n from '@/i18n'

export function getSpaceSettingsTitle(spaceId?: string | null): string {
  if (!spaceId) {
    return i18n.t('title', { ns: 'space' })
  }

  return i18n.t('title', { ns: 'space' })
}
