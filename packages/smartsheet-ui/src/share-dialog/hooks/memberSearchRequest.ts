export const MEMBER_SEARCH_PAGE_SIZE = 100

export function buildMemberSearchRequest(
  organizationId: string,
  query: string,
  offset = 0,
  limit = MEMBER_SEARCH_PAGE_SIZE,
) {
  return {
    method: 'GET' as const,
    endpoint: `/context/organizations/${organizationId}/members`,
    params: {
      search: query,
      search_mode: 'nickname',
      limit,
      offset,
    },
  }
}
