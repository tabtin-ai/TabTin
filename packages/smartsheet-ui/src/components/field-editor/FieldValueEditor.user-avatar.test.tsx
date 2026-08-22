import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { FieldValueEditor } from './FieldValueEditor'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('FieldValueEditor system user avatar', () => {
  it('uses the shared avatar URL resolver for organization members', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      act(() => {
        root.render(
          <FieldValueEditor
            field={{ id: 'creator', name: '创建人', field_type: 'created_by' }}
            value="user-42"
            onChange={vi.fn()}
            organizationMembers={[
              { id: 'user-42', name: '王小明', avatarUrl: 'user-avatars/member.png' },
            ]}
          />
        )
      })

      expect(container.textContent).toContain('王小明')
      expect(container.querySelector('img')?.getAttribute('src')).toBe(
        'https://assets.example.com/user-avatars/member.png',
      )
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })
})
