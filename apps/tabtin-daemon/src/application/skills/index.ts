import {
  importSkill,
  installNpmSkill,
  type InstallNpmSkillResult,
  type SkillInstallationContext,
} from './skill-installation.js'
import {
  cleanupDisabledSkill,
  materializeEnabledSkill,
  type SkillEnablementContext,
} from './skill-enablement.js'

export interface SkillsApplicationPorts {
  organizationId?: string
  requireUserId(): string
  request(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }>
  materializeApp(input: {
    organizationId: string
    spaceId: string
    userId: string
    appId: string
    slug: string
  }): Promise<{ installed: number; errors: string[] }>
}

/** The single application seam for every local Skill installation lifecycle. */
export class SkillsApplication {
  private readonly installationContext: SkillInstallationContext
  private readonly enablementContext: SkillEnablementContext

  constructor(private readonly ports: SkillsApplicationPorts) {
    this.installationContext = {
      registry: { request: ports.request },
      requireUserId: ports.requireUserId,
    }
    this.enablementContext = ports
  }

  import(input: {
    spaceId: string
    url?: string
    sourcePath?: string
    name?: string
    enable?: boolean
  }): Promise<{ data: any; enableError?: string }> {
    return importSkill({
      input,
      organizationId: this.ports.organizationId ?? null,
      context: this.installationContext,
    })
  }

  installNpm(input: {
    packageName: string
    spaceId?: string | null
    importToSpace?: boolean
    enableSpaceIds?: string[]
    addInteropRoot?: (rootPath: string) => Promise<void>
  }): Promise<InstallNpmSkillResult> {
    return installNpmSkill({
      ...input,
      organizationId: this.ports.organizationId,
      context: this.installationContext,
    })
  }

  materializeEnabled(input: { canonicalKey: string; djangoData: any; spaceId: string }) {
    return materializeEnabledSkill({ ...input, context: this.enablementContext })
  }

  cleanupDisabled(input: { canonicalKey: string; remove: boolean }) {
    return cleanupDisabledSkill({ ...input, context: this.enablementContext })
  }
}

export { SkillRegistryRequestError, parseSkillsAddInput } from './skill-installation.js'
