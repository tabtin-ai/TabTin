import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildMemberSearchRequest,
  MEMBER_SEARCH_PAGE_SIZE,
} from '../src/share-dialog/hooks/memberSearchRequest'

test('invite collaborator search requests nickname-only matching with page size 100', () => {
  assert.equal(MEMBER_SEARCH_PAGE_SIZE, 100)
  assert.deepEqual(buildMemberSearchRequest('organization-1', '小明'), {
    method: 'GET',
    endpoint: '/context/organizations/organization-1/members',
    params: {
      search: '小明',
      search_mode: 'nickname',
      limit: 100,
      offset: 0,
    },
  })
})

test('invite collaborator browse list supports offset pagination', () => {
  assert.deepEqual(buildMemberSearchRequest('organization-1', '', 100), {
    method: 'GET',
    endpoint: '/context/organizations/organization-1/members',
    params: {
      search: '',
      search_mode: 'nickname',
      limit: 100,
      offset: 100,
    },
  })
})