import manifestJson from '../manifest.json'
import { listApprovedBrandKeys, resolveConnectorBrandIcon } from './resolve.js'
import type {
  ConnectorBrandIconQuery,
  ConnectorBrandManifest,
  ConnectorBrandResolveResult,
} from './types.js'

export type {
  ConnectorBrandEntry,
  ConnectorBrandIconQuery,
  ConnectorBrandManifest,
  ConnectorBrandMatch,
  ConnectorBrandResolveResult,
  ConnectorBrandStatus,
} from './types.js'

export { listApprovedBrandKeys, resolveConnectorBrandIcon } from './resolve.js'

/** Bundled registry SSoT (JSON). Clients should not fork match tables. */
export const connectorBrandManifest = manifestJson as ConnectorBrandManifest

export function resolveConnectorBrandIconFromRegistry(
  query: ConnectorBrandIconQuery,
): ConnectorBrandResolveResult | null {
  return resolveConnectorBrandIcon(query, connectorBrandManifest)
}

export function listApprovedConnectorBrandKeys(): string[] {
  return listApprovedBrandKeys(connectorBrandManifest)
}
