import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const hostSource = readFileSync(
  resolve(__dirname, '..', 'ElectronAgentHost.ts'),
  'utf8',
)
/** Runtime assembly owns createRuntime / factory / soft-reconfigure (extracted from Host). */
const runtimeSource = readFileSync(
  resolve(__dirname, '..', 'runtime', 'electron-runtime-assembly.ts'),
  'utf8',
)
const typesSource = readFileSync(
  resolve(__dirname, '..', 'electron-agent-types.ts'),
  'utf8',
)

describe('ElectronAgentHost runtime cache key wiring', () => {
  it('builds one cache key from every baked runtime field', () => {
    // 阶段 1：`getOrCreateRuntime` 组装 `cacheKeyInput` 直接喂给
    // `RuntimeSessionFactory.resolve`（factory 内部再走 `createRuntimeCacheKey`），
    // 不再手写 `const runtimeCacheKey = createRuntimeCacheKey(...)`。
    const start = runtimeSource.indexOf('const cacheKeyInput = {')
    expect(start).toBeGreaterThan(-1)
    const block = runtimeSource.slice(start, start + 1000)

    for (const field of [
      'modelId',
      'customRules',
      'personalRules',
      'workspaceRoot: effectiveWorkspaceRoot',
      'owner',
      'spaceId: archiveSpaceId',
      'operationSwitches',
      'maxCreditsPerRun:',
      'memoryCapability',
      'workingDirType',
      'enabledApps',
    ]) {
      expect(block).toContain(field)
    }
    expect(block).toContain(
      'normalizeExecutionLimitsForCostCap(executionLimits)?.max_credits_per_run',
    )
    expect(block).not.toMatch(/teamRules|team_rules/)
  })

  it('routes runtime resolution through the shared session factory', () => {
    // 阶段 1：reuse / soft-reconfigure / rebuild 决策全部下沉到
    // `RuntimeSessionFactory`；assembly 仅剩 `factory.resolve` 一处入口。
    expect(runtimeSource).toContain('this.runtimeFactory.resolve({')
    // adapter 通过 spread cacheKey 把 factory 归一化后的 `RuntimeCacheKey`
    // 字段直接写进 HostState —— 保证 `getCacheKey(session)=session` 与
    // 下轮 `runtimeCacheKeysMatch` 使用同一份字段。
    expect(runtimeSource).toMatch(/const state: HostState = \{[\s\S]*?\.\.\.cacheKey/)
    // registry 唯一真相源：factory 直接持 `this.ports.sessions`，无第二份 Map。
    expect(runtimeSource).toContain('new RuntimeSessionFactory(')
    expect(runtimeSource).toContain('this.buildRuntimeFactoryAdapter()')
    expect(runtimeSource).toContain('this.ports.sessions')
    expect(runtimeSource).toContain('normalizeElectronRuntimeExtraKey(')
    expect(runtimeSource).toContain('session.workspaceId')
    expect(runtimeSource).toMatch(/const state: HostState = \{[\s\S]*?workspaceId: input\.workspaceId/)
    // Host 壳只委托 assembly，不再内联 factory。
    expect(hostSource).toContain('this.runtimeAssembly.getOrCreateRuntime(')
  })

  it('#8423 /  in-turn push dual-write uses shared gate', () => {
    expect(hostSource).toContain('isInTurnPushNotificationUser(userPayload)')
    expect(hostSource).toContain("triggeredBy: 'push-notification' as const")
    // idle drain 不得仅凭 triggered_by 双写（必须有非空 message_id）
    expect(hostSource).not.toMatch(
      /const isInTurnPush =\s*userPayload\.triggered_by === 'push-notification'\s*&&/,
    )
  })

  it('keeps personal rules when rebuilding a push-notification query', () => {
    const anchor = hostSource.indexOf("triggeredBy: 'push-notification'")
    expect(anchor).toBeGreaterThan(-1)
    const drainBlock = hostSource.slice(anchor - 1000, anchor + 800)
    expect(drainBlock).toContain(
      'personalRules: session.personalRules',
    )
    expect(drainBlock).toContain(
      'workspaceId: session.workspaceId',
    )
    // ：drain 必须带回已烘焙能力，否则 rebuild 吃 FALLBACK 32k/8192
    expect(drainBlock).toContain(
      'modelContextWindow: session.engineConfig.contextWindowTokens',
    )
    expect(drainBlock).toContain(
      'modelMaxOutput: session.engineConfig.maxOutputTokens',
    )
    expect(drainBlock).toContain('memoryCapability: session.memoryCapability')
    expect(drainBlock).toContain('workingDirType: session.workingDirType')
    expect(drainBlock).toContain('workingDir: session.workspaceRoot')
    // ：idle drain 必须带 clientMessageId，否则有 history 时 prelude 不发 USER
    expect(drainBlock).toContain('clientMessageId: crypto.randomUUID()')
    expect(hostSource).not.toContain('sessionWorkspaceIds')
  })

  it('#10516 bakes Space context into queued runtime builds instead of late-reading CLI globals', () => {
    const inputStart = typesSource.indexOf('export interface RuntimeBuildInput')
    expect(inputStart).toBeGreaterThan(-1)
    const inputBlock = typesSource.slice(inputStart, inputStart + 900)
    expect(inputBlock).toContain('workspaceId: string')
    expect(inputBlock).toContain('spaceId: string')
    expect(inputBlock).toContain('organizationId: string')

    const requestStart = runtimeSource.indexOf('buildRequestFromQuery(')
    expect(requestStart).toBeGreaterThan(-1)
    const requestBlock = runtimeSource.slice(requestStart, requestStart + 4200)
    expect(requestBlock).toContain('spaceId: normalizedSpaceId')
    expect(requestBlock).toContain('organizationId: normalizedOrganizationId')

    const hostStateStart = runtimeSource.indexOf('async buildHostState(')
    expect(hostStateStart).toBeGreaterThan(-1)
    const hostStateBlock = runtimeSource.slice(hostStateStart, hostStateStart + 2400)
    expect(hostStateBlock).toContain('input.workspaceId')
    expect(hostStateBlock).toContain('input.spaceId')
    expect(hostStateBlock).toContain('input.organizationId')

    const createStart = runtimeSource.indexOf('async createRuntimeForSession(')
    expect(createStart).toBeGreaterThan(-1)
    const createBlock = runtimeSource.slice(createStart, createStart + 3400)
    expect(createBlock).toContain('sessionSpaceId?: string')
    expect(createBlock).toContain('sessionOrganizationIdInput?: string')

    const archiveStart = runtimeSource.indexOf(
      'const spaceId = sessionSpaceId?.trim() || undefined',
    )
    expect(archiveStart).toBeGreaterThan(-1)
    const archiveBlock = runtimeSource.slice(archiveStart - 500, archiveStart + 500)
    expect(archiveBlock).toContain('const spaceId = sessionSpaceId?.trim() || undefined')
    expect(archiveBlock).toContain(
      'const organizationId = sessionOrganizationIdInput?.trim() || sessionOrganizationId',
    )
    expect(archiveBlock).not.toContain('const spaceId = getCLISpaceId()')
  })

  it('backfills push-notification capabilities from existing session in buildRequestFromQuery', () => {
    const start = runtimeSource.indexOf('buildRequestFromQuery(')
    expect(start).toBeGreaterThan(-1)
    const block = runtimeSource.slice(start, start + 3500)
    expect(block).toContain("request.triggeredBy === 'push-notification'")
    expect(block).toContain('existing?.engineConfig.contextWindowTokens')
    expect(block).toContain('existing?.engineConfig.maxOutputTokens')
    expect(block).toContain('existing?.memoryCapability')
    expect(block).toContain('existing?.workingDirType')
  })

  it('rejects a missing model instead of creating a synthetic default runtime', () => {
    const start = runtimeSource.indexOf('buildRequestFromQuery(')
    expect(start).toBeGreaterThan(-1)
    const block = runtimeSource.slice(start, start + 1800)
    expect(block).toContain("request.modelId?.trim()")
    expect(block).toContain("throw new Error('modelId is required to initialize session runtime')")
    expect(block).not.toContain("request.modelId ?? 'default'")
  })

  it('#7894 runtime workspaceRoot comes only from Space.working_dir, never CLI organizationRoot', () => {
    expect(runtimeSource).toContain('function resolveExecutionWorkspaceRoot(')
    expect(runtimeSource).toContain('resolveExecutionWorkspaceRoot({')
    expect(runtimeSource).toMatch(/workingDir:\s*request\.workingDir/)
    expect(runtimeSource).not.toMatch(
      /normalizeWorkspaceRoot\(\s*getCLIOrganizationRoot\(\)\s*\)/,
    )
    expect(runtimeSource).not.toMatch(/getCLIOrganizationRoot\s*\(/)
    const importLine = runtimeSource
      .split('\n')
      .find((line) => line.includes("from '../../cli/cli-server.js'"))
    expect(importLine).toBeTruthy()
    expect(importLine).toContain('getCLISpaceId')
    expect(importLine).not.toContain('getCLIOrganizationRoot')
  })

  it('keeps an active session binding authoritative and fails closed when it is unreachable', () => {
    expect(runtimeSource).toContain('resolveAuthoritativeSessionCodeRoot(')
    expect(runtimeSource).toContain('new ExecutionRootUnreachableError(')
    expect(runtimeSource).toContain('strictWorkspaceRoot: Boolean(authoritativeBoundCodeRoot)')
    expect(runtimeSource).toContain('? resolveStrictRuntimeWorkspaceRoot(workspaceRoot)')
    expect(runtimeSource).not.toContain('falling back to workingDir/sandbox')
  })

  it('bakes modelCaps from catalog before FALLBACK when IPC omits window/maxOutput', () => {
    const start = runtimeSource.indexOf(
      'const catalogHitForCaps = findCatalogEntry(scopedModelCatalogSnapshot, modelId)',
    )
    expect(start).toBeGreaterThan(-1)
    const block = runtimeSource.slice(start, start + 1200)
    expect(block).toContain('catalogContextWindow')
    expect(block).toContain('catalogMaxOutput')
    expect(block).toContain('FALLBACK_MODEL_CAPABILITIES.maxOutputTokens')
  })

  it('#6674 injects personal rules through the same pre-user hook as Agent profile', () => {
    const hookStart = runtimeSource.indexOf('buildAgentProfileHook({')
    expect(hookStart).toBeGreaterThan(-1)
    const hookBlock = runtimeSource.slice(hookStart, hookStart + 500)
    expect(hookBlock).toContain(
      'getAgentProfile: async () => this.ports.sessions.get(sessionId)?.agentProfile ?? null',
    )
    expect(hookBlock).toContain(
      'getPersonalRules: async () => this.ports.sessions.get(sessionId)?.personalRules',
    )
    expect(
      runtimeSource.match(/personalRulesPlacement:\s*'pre-user-context'/g),
    ).toHaveLength(2)
    const reconfigureStart = runtimeSource.indexOf(
      'const reconfigBaked: BakedSystemPromptInputs = {',
    )
    const createStart = runtimeSource.indexOf(
      'const promptBaked: BakedSystemPromptInputs = {',
    )
    expect(runtimeSource.slice(reconfigureStart, reconfigureStart + 500)).toContain(
      "personalRulesPlacement: 'pre-user-context'",
    )
    expect(runtimeSource.slice(createStart, createStart + 500)).toContain(
      "personalRulesPlacement: 'pre-user-context'",
    )
  })

  it('binds Skill enablement to the runtime Agent instead of the Workspace shell', () => {
    expect(runtimeSource).toContain(
      '? hostRef.skillEnablementCache.forAgent(agentId)',
    )
    // ：beforeRun 按 runId 租约冻结；斜杠只 force 刷新缓存，不写共享快照。
    expect(runtimeSource).toMatch(
      /await hostRef\.skillsStore\.beginRun\(ctx\.runId, agentId, \{\s+catalog:/,
    )
    expect(runtimeSource).toContain('hostRef.skillsStore?.endRun(ctx.runId)')
    expect(runtimeSource).toContain('hostRef.skillsStore?.peekRun(runId)')
    expect(runtimeSource).toContain('snapshot.resolve(key)')
    expect(runtimeSource).toContain('snapshot.availableSkills')
    expect(runtimeSource).toContain(
      'const personalPlugins = await loadPersonalPluginSkillsForRun()',
    )
    expect(runtimeSource).toContain(
      'authoritative: Boolean(registry) && personalPlugins.authoritative',
    )
    expect(runtimeSource).toContain('snapshot.availableSkills.find(isLibTvSkill)')
    expect(runtimeSource).toContain('registry.renderAvailableSkills(snapshot.availableSkills')
    expect(runtimeSource).not.toContain('registry.getByKey(key, { spaceId: ctx?.spaceId })')
    expect(runtimeSource).toContain('refreshSkillEnablementForSlash')
    expect(runtimeSource).toContain('await agentSkillEnablement.refresh({ force: true })')
    expect(runtimeSource).not.toContain('activeSkillEnablementSnapshot')
    expect(runtimeSource).toContain(
      '[SkillEnablement] missing agentId; all Skills disabled (closed carry set)',
    )
    expect(runtimeSource).not.toMatch(
      /skillEnablementCache\.(?:refresh|getSync)\([^)]*(?:spaceId|workspaceId)/,
    )
    expect(hostSource).toContain('[SkillEnablement] refresh failed agent=')
  })

  it('query fetchAuthoritative 走 host-turn bundle 并透传 workspaceId', () => {
    expect(hostSource).toContain('workspaceId: request.workspaceId')
    // 禁止 query 热路径只读 Agent JSON grant；统一 bundle 会按 Workspace
    // 解析最终配置，并与 prepareTurnInputs 共享缓存。
    const fetchPort = hostSource.search(/fetchAuthoritative:\s*(?:async\s*)?\(args\)\s*=>/)
    expect(fetchPort).toBeGreaterThan(-1)
    const portBlock = hostSource.slice(fetchPort, fetchPort + 700)
    expect(portBlock).toContain(
      'args.workspaceId ?? this.sessions.get(args.sessionId)?.workspaceId',
    )
    expect(portBlock).toContain('loadHostTurnBundle({')
    expect(portBlock).toContain('workspaceId,')
    expect(portBlock).not.toContain('agentConfigClient.fetchAuthoritativeAgentConfig(')
  })

  it('routes compact runtime creation through the AgentHost facade with the owner scope', () => {
    const start = hostSource.indexOf('private async handleCompactSession(')
    const end = hostSource.indexOf('private async compactSessionInternal(', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const block = hostSource.slice(start, end)

    // 阶段 4 · 门面：compact 旁路统一走 requireSharedHost().submitRun。
    expect(block).toContain('this.requireSharedHost().submitRun(submission)')
    expect(block).toContain('lifecycleScopeId: this.ownerKey(owner)')
    expect(block).toContain('execute: () => this.compactSessionInternal(input, threadId)')
    expect(block).toContain("error: 'workspaceId is required'")
    expect(block).toContain('existingSession.workspaceId !== workspaceId')
    expect(block).toContain("error: 'session belongs to another workspace'")
    expect(block.indexOf('existingSession.workspaceId !== workspaceId')).toBeLessThan(
      block.indexOf('syncCLISpaceContextFromQueryRequest('),
    )
  })
})
