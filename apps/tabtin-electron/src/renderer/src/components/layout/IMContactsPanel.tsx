/**
 * IMContactsPanel —— 「消息 > 通讯录」主画布。
 *
 * 复用 StandaloneModulePage 壳（与自动化 / 技能库等同视觉规范）；
 * 返回消息通过侧栏「通讯录」toggle，不在页内重复 back 条。
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import { Contact } from 'lucide-react'
import { ContactsDirectory } from '@components/tabchat/ContactsDirectory'
import { StandaloneModulePage } from '@components/context-space/StandaloneModulePage'
import { useOrganizationStore } from '@stores/useOrganizationStore'

export const IMContactsPanel: React.FC = React.memo(() => {
  const { t } = useTranslation('tabchat')
  const organizationName = useOrganizationStore(
    (state) => state.selectedOrganization?.name ?? '',
  )

  const title = t('contacts', { defaultValue: '通讯录' })
  const description = organizationName
    || t('contactsSubtitle', { defaultValue: '查看组织成员并发起私信' })

  return (
    <StandaloneModulePage
      testId="im-contacts-panel"
      icon={<Contact className="h-7 w-7" strokeWidth={1.5} aria-hidden />}
      title={title}
      description={description}
    >
      <ContactsDirectory />
    </StandaloneModulePage>
  )
})

IMContactsPanel.displayName = 'IMContactsPanel'
