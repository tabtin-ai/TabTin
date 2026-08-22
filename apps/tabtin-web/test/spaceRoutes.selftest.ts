import {
  getPendingSpaceRouteSyncTarget,
  spaceHomePath,
} from '../src/features/space/spaceRoutes'

function expectEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

expectEqual(
  spaceHomePath('team B', 'space/2'),
  '/organizations/team%20B/spaces/space%2F2',
  'spaceHomePath encodes path segments',
)

expectEqual(
  getPendingSpaceRouteSyncTarget({
    pathname: '/organizations/team-a/spaces/space-a/docs/doc-a',
    pendingOrganizationSwitch: true,
    selectedSpaceKind: 'workspace',
    organizationId: 'team-b',
    spaceId: 'space-b',
  }),
  '/organizations/team-b/spaces/space-b',
  'pending team switch redirects stale resource route to selected space home',
)

expectEqual(
  getPendingSpaceRouteSyncTarget({
    pathname: '/organizations/team-b/spaces/space-b/',
    pendingOrganizationSwitch: true,
    selectedSpaceKind: 'workspace',
    organizationId: 'team-b',
    spaceId: 'space-b',
  }),
  null,
  'already synchronized route is left unchanged',
)

expectEqual(
  getPendingSpaceRouteSyncTarget({
    pathname: '/organizations/team-a/spaces/space-a',
    pendingOrganizationSwitch: false,
    selectedSpaceKind: 'workspace',
    organizationId: 'team-b',
    spaceId: 'space-b',
  }),
  null,
  'non-team-switch selection does not force replace navigation',
)

expectEqual(
  getPendingSpaceRouteSyncTarget({
    pathname: '/organizations/team-a/spaces/space-a',
    pendingOrganizationSwitch: true,
    selectedSpaceKind: 'dm',
    organizationId: 'team-b',
    spaceId: 'space-b',
  }),
  null,
  'non-workspace selection does not produce a space home route',
)
