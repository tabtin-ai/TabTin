export type ConnectorBrandStatus = 'approved' | 'deferred'

export interface ConnectorBrandMatch {
  ids?: string[]
  hosts?: string[]
  names?: string[]
  npm?: string[]
}

export interface ConnectorBrandEntry {
  status: ConnectorBrandStatus
  title: string
  file: string | null
  /** Official brand hex for identification glyph (e.g. #635BFF). */
  color?: string | null
  source: string | null
  guidelines: string | null
  vendorNote?: string
  match: ConnectorBrandMatch
}

export interface ConnectorBrandManifest {
  version: number
  policy?: string
  brands: Record<string, ConnectorBrandEntry>
}

/** Inputs the resolver accepts — UI passes whatever identity it has. */
export interface ConnectorBrandIconQuery {
  /** Future explicit field from API / catalog. */
  brandKey?: string | null
  catalogId?: string | null
  name?: string | null
  endpointUrl?: string | null
  docsUrl?: string | null
  credentialUrl?: string | null
  commandArgs?: readonly string[] | null
}

export interface ConnectorBrandResolveResult {
  brandKey: string
  file: string
  title: string
}
