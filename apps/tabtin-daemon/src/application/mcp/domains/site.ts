import { McpDomainSupport } from './domain-support.js'

export class SiteMcpDomain extends McpDomainSupport {
  async toolSiteList(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const spaceId = (args.space_id as string) || process.env.TABTIN_SPACE_ID
    const organizationId = (args.organization_id as string) || process.env.TABTIN_ORGANIZATION_ID
    if (!spaceId || !organizationId) {
      return { content: [{ type: 'text', text: 'Error: space_id and organization_id are required. Set TABTIN_SPACE_ID and TABTIN_ORGANIZATION_ID env vars or pass them as arguments.' }], isError: true }
    }
    const qs = new URLSearchParams({ organization_id: organizationId, space_id: spaceId })
    if (args.status) qs.set('status', String(args.status))
    const data = await this.get(`/tabsite/sites/?${qs}`)
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }

  async toolSiteInfo(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const siteId = args.site_id as string
    if (!siteId) return { content: [{ type: 'text', text: 'Error: site_id is required' }], isError: true }
    const data = await this.get(`/tabsite/sites/${siteId}/`)
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }

  async toolSiteCreate(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const name = args.name as string
    if (!name) return { content: [{ type: 'text', text: 'Error: name is required' }], isError: true }
    const spaceId = (args.space_id as string) || process.env.TABTIN_SPACE_ID
    const organizationId = (args.organization_id as string) || process.env.TABTIN_ORGANIZATION_ID
    if (!spaceId || !organizationId) {
      return { content: [{ type: 'text', text: 'Error: space_id and organization_id are required. Set TABTIN_SPACE_ID and TABTIN_ORGANIZATION_ID env vars or pass them as arguments.' }], isError: true }
    }
    const data = await this.request('/tabsite/sites/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        organization_id: organizationId,
        space_id: spaceId,
        name,
        framework: (args.framework as string) || 'react',
        template: (args.template as string) || 'blank',
      }),
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }

  async toolSiteUpdate(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const siteId = args.site_id as string
    if (!siteId) return { content: [{ type: 'text', text: 'Error: site_id is required' }], isError: true }
    const updates: Record<string, unknown> = {}
    if (args.name !== undefined) updates.name = args.name
    if (args.is_public !== undefined) updates.is_public = args.is_public
    if (args.custom_domain !== undefined) updates.custom_domain = args.custom_domain
    if (args.status !== undefined) updates.status = args.status
    if (Object.keys(updates).length === 0) {
      return { content: [{ type: 'text', text: 'Error: at least one field to update is required' }], isError: true }
    }
    const data = await this.request(`/tabsite/sites/${siteId}/`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }

  async toolSitePublish(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const siteId = args.site_id as string
    const distUrl = args.dist_url as string
    if (!siteId || !distUrl) {
      return { content: [{ type: 'text', text: 'Error: site_id and dist_url are required' }], isError: true }
    }
    const data = await this.request(`/tabsite/sites/${siteId}/publish/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: (args.message as string) || '',
        dist_url: distUrl,
      }),
    })
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
  }}
