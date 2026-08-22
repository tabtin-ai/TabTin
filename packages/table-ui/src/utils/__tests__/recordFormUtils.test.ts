import { describe, it, expect } from 'vitest'
import {
  toFieldDefinitions,
  toOrganizationMembers,
  type WorkspaceMemberLike,
} from '../recordFormUtils'

describe('toFieldDefinitions', () => {
  it('preserves field defaults for record creation forms', () => {
    const [field] = toFieldDefinitions([
      {
        id: 'field-1',
        name: 'Status',
        field_type: 'select',
        is_primary: false,
        is_hidden: false,
        default_value: { mode: 'literal', value: 'Todo' },
      },
    ])

    expect(field.default_value).toEqual({ mode: 'literal', value: 'Todo' })
  })
})

describe('toOrganizationMembers', () => {
  it('maps avatar to avatarUrl', () => {
    const members: WorkspaceMemberLike[] = [
      {
        user_id: 'u1',
        user: {
          id: 'u1',
          nickname: 'Alice',
          username: 'alice',
          email: 'alice@example.com',
          avatar: 'https://cdn.example.com/avatars/alice.jpg',
        },
      },
    ]

    const result = toOrganizationMembers(members)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      id: 'u1',
      name: 'Alice',
      email: 'alice@example.com',
      avatarUrl: 'https://cdn.example.com/avatars/alice.jpg',
    })
  })

  it('returns undefined avatarUrl when user has no avatar', () => {
    const members: WorkspaceMemberLike[] = [
      {
        user_id: 'u2',
        user: {
          id: 'u2',
          nickname: 'Bob',
          email: 'bob@example.com',
        },
      },
    ]

    const result = toOrganizationMembers(members)
    expect(result[0].avatarUrl).toBeUndefined()
  })

  it('returns undefined avatarUrl when user is null', () => {
    const members: WorkspaceMemberLike[] = [
      { user_id: 'u3', user: null },
    ]

    const result = toOrganizationMembers(members)
    expect(result[0]).toEqual({
      id: 'u3',
      name: 'u3',
      email: undefined,
      avatarUrl: undefined,
    })
  })

  it('returns undefined avatarUrl when avatar is empty string', () => {
    const members: WorkspaceMemberLike[] = [
      {
        user_id: 'u4',
        user: { id: 'u4', nickname: 'Dave', avatar: '' },
      },
    ]

    const result = toOrganizationMembers(members)
    expect(result[0].avatarUrl).toBeUndefined()
  })

  it('prefers nickname over username for name', () => {
    const members: WorkspaceMemberLike[] = [
      {
        user_id: 'u5',
        user: { id: 'u5', nickname: 'Nick', username: 'nick_user' },
      },
    ]

    const result = toOrganizationMembers(members)
    expect(result[0].name).toBe('Nick')
  })

  it('falls back to username when nickname is absent', () => {
    const members: WorkspaceMemberLike[] = [
      {
        user_id: 'u6',
        user: { id: 'u6', username: 'only_username' },
      },
    ]

    const result = toOrganizationMembers(members)
    expect(result[0].name).toBe('only_username')
  })

  it('falls back to user_id when user object has no name fields', () => {
    const members: WorkspaceMemberLike[] = [
      { user_id: 'u7', user: { id: 'u7' } },
    ]

    const result = toOrganizationMembers(members)
    expect(result[0].name).toBe('u7')
  })
})
