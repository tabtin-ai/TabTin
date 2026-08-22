// AUTO-GENERATED — DO NOT EDIT, see scripts/electron/codegen-surface-preload.ts

import type { AgentEngineAbortInput, AgentEngineAbortOutput } from '@tabtin/cli-server-core/surfaces/agent-engine'
import type { GetWorkspaceSnapshotInput, GetWorkspaceSnapshotOutput } from '@tabtin/cli-server-core/surfaces/agent-security'
import type { ChatExportMdInput, ChatExportMdOutput } from '@tabtin/cli-server-core/surfaces/chat-export-md'
import type { SessionCreateInput, SessionCreateOutput } from '@tabtin/cli-server-core/surfaces/session'
import type { SkillInstallInput, SkillInstallOutput } from '@tabtin/cli-server-core/surfaces/skill-install'
import type { SkillListInput, SkillListOutput } from '@tabtin/cli-server-core/surfaces/skill-list'
import type { SkillMaterializeAppInput, SkillMaterializeAppOutput } from '@tabtin/cli-server-core/surfaces/skill-materialize-app'
import type { SkillReadContentInput, SkillReadContentOutput } from '@tabtin/cli-server-core/surfaces/skill-read-content'
import type { SkillResolvePathInput, SkillResolvePathOutput } from '@tabtin/cli-server-core/surfaces/skill-resolve-path'
import type { SkillUninstallInput, SkillUninstallOutput } from '@tabtin/cli-server-core/surfaces/skill-uninstall'
import type { SkillWriteContentInput, SkillWriteContentOutput } from '@tabtin/cli-server-core/surfaces/skill-write-content'
import type { SpaceSetActiveInput, SpaceSetActiveOutput } from '@tabtin/cli-server-core/surfaces/space-set-active'

/**
 * PlatformSurface 自动生成的 preload 类型声明。
 *
 * 每个 module 对应一个 namespace 键，每个 verb 对应一个方法。
 * preload 实现层（index.ts）的 api 对象可用此接口约束 surface
 * 方法的签名，保证 surface 声明 ↔ preload 类型一致。
 *
 * 当前包含 12 个 surface，6 个 module。
 */
export interface SurfacePreloadTypes {
  'agent-engine': {
    /** agent-engine/abort（channel: agent-engine:abort） */
    abort(input: AgentEngineAbortInput): Promise<AgentEngineAbortOutput>
  }
  'agent-security': {
    /** agent-security/get-workspace-snapshot（channel: agent-security:get-workspace-snapshot） */
    getWorkspaceSnapshot(input: GetWorkspaceSnapshotInput): Promise<GetWorkspaceSnapshotOutput>
  }
  chat: {
    /** chat/export-md（channel: chat:export-md） */
    exportMd(input: ChatExportMdInput): Promise<ChatExportMdOutput>
  }
  session: {
    /** session/create（channel: session:create） */
    create(input: SessionCreateInput): Promise<SessionCreateOutput>
  }
  skill: {
    /** skill/install（channel: skill:install） */
    install(input: SkillInstallInput): Promise<SkillInstallOutput>
    /** skill/list（channel: skill:list） */
    list(input: SkillListInput): Promise<SkillListOutput>
    /** skill/materialize-app（channel: skill:materialize-app） */
    materializeApp(input: SkillMaterializeAppInput): Promise<SkillMaterializeAppOutput>
    /** skill/read-content（channel: skill:read-content） */
    readContent(input: SkillReadContentInput): Promise<SkillReadContentOutput>
    /** skill/resolve-path（channel: skill:resolve-path） */
    resolvePath(input: SkillResolvePathInput): Promise<SkillResolvePathOutput>
    /** skill/uninstall（channel: skill:uninstall） */
    uninstall(input: SkillUninstallInput): Promise<SkillUninstallOutput>
    /** skill/write-content（channel: skill:write-content） */
    writeContent(input: SkillWriteContentInput): Promise<SkillWriteContentOutput>
  }
  space: {
    /** space/set-active（channel: space:set-active） */
    setActive(input: SpaceSetActiveInput): Promise<SpaceSetActiveOutput>
  }
}
