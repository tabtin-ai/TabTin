export type SkillCredentialResolver = (
  params: { skillKey: string; spaceId: string; agentId: string; primaryEnv?: string },
  signal: AbortSignal,
) => Promise<SkillCredentialInjection | null>

export interface SkillCredentialInjection {
  env: Record<string, string>
  serviceName: string
  credentialId: string
  warnings?: string[]
}
