import React, { act, forwardRef, useImperativeHandle } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tabtin/smartsheet-ui', () => ({
  resolveSelectChipColors: () => ({ backgroundColor: '#eee', color: '#111' }),
}))

vi.mock('@tabtin/table-engine', () => ({
  resolveRecordId: (row: { __recordId?: string }) => row.__recordId ?? null,
}))

vi.mock('./overlays/RecordMenu', () => ({ RecordMenu: () => null }))
vi.mock('./overlays/FieldMenu', () => ({ FieldMenu: () => null }))
vi.mock('./overlays/StatisticMenu', () => ({ StatisticMenu: () => null }))
vi.mock('./overlays/DescriptionTooltip', () => ({ DescriptionTooltip: () => null }))

vi.mock('./grid/Grid', () => ({
  Grid: forwardRef(function Grid(
    props: {
      groupPoints?: Array<{ type: number; value?: unknown; depth?: number }>
      groupCollection?: {
        getGroupCell: (value: unknown, depth: number) => {
          data?: Array<{ id: string; name: string; avatarUrl?: string }>
        }
      }
    },
    ref,
  ) {
    useImperativeHandle(ref, () => ({
      getContainer: () => null,
      getScrollState: () => ({ scrollLeft: 0, scrollTop: 0 }),
      forceUpdate: () => undefined,
    }))

    const groupPoint = props.groupPoints?.find((point) => point.type === 0)
    const user = groupPoint && props.groupCollection
      ? props.groupCollection.getGroupCell(groupPoint.value, groupPoint.depth ?? 0).data?.[0]
      : undefined

    return <div data-testid="group-user">{JSON.stringify(user ?? null)}</div>
  }),
}))

import { CanvasGridAdapter } from './CanvasGridAdapter'

async function unmountAfterDeferredImports(root: ReturnType<typeof createRoot>) {
  await act(async () => {
    await vi.dynamicImportSettled()
  })
  await act(async () => root.unmount())
}

describe('CanvasGridAdapter user group header', () => {
  it('uses the current organization member name and avatar for an ID-only group value', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    const root = createRoot(container)
    const userId = '634e1f02-0f40-426e-84cd-655335b5d247'

    await act(async () => {
      root.render(
        <CanvasGridAdapter
          columns={[
            {
              field: 'Owner',
              fieldId: 'f_owner',
              headerName: 'Owner',
              type: 'user',
              originalFieldType: 'user',
            },
          ]}
          rows={[
            {
              id: '__group__owner',
              __rowType: 'group_header',
              __groupLevel: 0,
              __groupPath: userId,
              __groupLabel: '张三',
              __groupValue: [userId],
              __groupValues: { Owner: [userId] },
              __groupCount: 1,
            },
            { id: 'rec-1', Owner: [userId] },
          ]}
          organizationMembers={[
            {
              id: userId,
              name: '张三',
              avatarUrl: 'https://cdn.example.com/avatar.png',
            },
          ]}
        />,
      )
    })

    expect(container.querySelector('[data-testid="group-user"]')?.textContent).toBe(
      JSON.stringify({
        id: userId,
        name: '张三',
        avatarUrl: 'https://cdn.example.com/avatar.png',
      }),
    )

    await unmountAfterDeferredImports(root)
  })

  it('does not borrow an organization avatar for an external structured user', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    const root = createRoot(container)
    const userId = 'external-user-id'

    await act(async () => {
      root.render(
        <CanvasGridAdapter
          columns={[
            {
              field: 'Owner',
              fieldId: 'f_owner',
              headerName: 'Owner',
              type: 'user',
              originalFieldType: 'user',
            },
          ]}
          rows={[
            {
              id: '__group__external-owner',
              __rowType: 'group_header',
              __groupLevel: 0,
              __groupPath: userId,
              __groupLabel: 'Imported User',
              __groupValue: [{ id: userId, name: 'Imported User' }],
              __groupValues: { Owner: [{ id: userId, name: 'Imported User' }] },
              __groupCount: 1,
            },
            { id: 'rec-1', Owner: [{ id: userId, name: 'Imported User' }] },
          ]}
          organizationMembers={[
            {
              id: userId,
              name: 'Organization User',
              avatarUrl: 'https://cdn.example.com/organization-avatar.png',
            },
          ]}
        />,
      )
    })

    expect(container.querySelector('[data-testid="group-user"]')?.textContent).toBe(
      JSON.stringify({
        id: userId,
        name: 'Imported User',
      }),
    )

    await unmountAfterDeferredImports(root)
  })

  it('uses the latest resolved name for a member instead of the embedded stale snapshot', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    const root = createRoot(container)
    const userId = 'renamed-member-id'

    await act(async () => {
      root.render(
        <CanvasGridAdapter
          columns={[
            {
              field: 'Owner',
              fieldId: 'f_owner',
              headerName: 'Owner',
              type: 'user',
              originalFieldType: 'user',
            },
          ]}
          rows={[
            {
              id: '__group__owner',
              __rowType: 'group_header',
              __groupLevel: 0,
              __groupPath: `user:["${userId}"]`,
              __groupLabel: '新名字',
              __groupValue: [{ id: userId, name: '旧名字' }],
              __groupValues: { Owner: [{ id: userId, name: '旧名字' }] },
              __groupCount: 1,
            },
            { id: 'rec-1', Owner: [{ id: userId, name: '旧名字' }] },
          ]}
          organizationMembers={[
            {
              id: userId,
              name: '新名字',
              avatarUrl: 'https://cdn.example.com/member.png',
            },
          ]}
          userDisplayNameById={new Map([[userId, '新名字']])}
        />,
      )
    })

    expect(container.querySelector('[data-testid="group-user"]')?.textContent).toBe(
      JSON.stringify({
        id: userId,
        name: '新名字',
        avatarUrl: 'https://cdn.example.com/member.png',
      }),
    )

    await unmountAfterDeferredImports(root)
  })

  it('structured user 缺 avatar 时回落组织成员头像', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    const root = createRoot(container)
    const userId = 'member-with-avatar'

    await act(async () => {
      root.render(
        <CanvasGridAdapter
          columns={[
            {
              field: 'Owner',
              fieldId: 'f_owner',
              headerName: 'Owner',
              type: 'user',
              originalFieldType: 'user',
            },
          ]}
          rows={[
            {
              id: '__group__owner',
              __rowType: 'group_header',
              __groupLevel: 0,
              __groupPath: userId,
              __groupLabel: 'Member',
              __groupValue: [{ id: userId, name: 'Member' }],
              __groupValues: { Owner: [{ id: userId, name: 'Member' }] },
              __groupCount: 3,
              __groupLoadedCount: 1,
            },
            { id: 'rec-1', Owner: [{ id: userId, name: 'Member' }] },
          ]}
          organizationMembers={[
            {
              id: userId,
              name: 'Member',
              avatarUrl: 'https://cdn.example.com/member.png',
            },
          ]}
        />,
      )
    })

    expect(container.querySelector('[data-testid="group-user"]')?.textContent).toBe(
      JSON.stringify({
        id: userId,
        name: 'Member',
        avatarUrl: 'https://cdn.example.com/member.png',
      }),
    )

    await unmountAfterDeferredImports(root)
  })
})
