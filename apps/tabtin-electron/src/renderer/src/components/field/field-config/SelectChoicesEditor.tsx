import React from 'react'
import {
  SelectChoicesEditor as SharedSelectChoicesEditor,
  type SelectChoiceOption,
} from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'

interface SelectChoicesEditorProps {
  choices: SelectChoiceOption[]
  onChange: (value: SelectChoiceOption[]) => void
}

export const SelectChoicesEditor: React.FC<SelectChoicesEditorProps> = ({ choices, onChange }) => {
  const { t } = useTranslation('field')

  return (
    <SharedSelectChoicesEditor
      choices={choices}
      onChange={onChange}
      label={t('fieldSettingPanel.choicesLabel', { defaultValue: '选项列表' })}
    />
  )
}
