import type http from 'node:http'

import {
  parseSkillsAddInput,
  SkillsApplication,
  SkillRegistryRequestError,
} from '../../../../application/skills/index.js'
import type { CliRequestContext } from '../../cli-context.js'
import { djangoRequest, errorResponse, type SendJSON } from '../shared/error-handler.js'

const LOG_TAG = '[CLI Skills Import]'

function skillsApplication(organizationId: string | null, cliContext: CliRequestContext): SkillsApplication {
  return new SkillsApplication({
    organizationId: organizationId ?? undefined,
    request: (method, path, body) => djangoRequest(method, path, body, { logTag: LOG_TAG }),
    requireUserId: () => cliContext.requireUserId(),
    materializeApp: async () => { throw new Error('App materialization is not used by import routes') },
  })
}

function normalizedId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed && trimmed !== '.' && !trimmed.includes('/') && !trimmed.includes('\\') && !trimmed.includes('..') && !/[\x00-\x1F\x7F]/.test(trimmed)
    ? trimmed
    : null
}

export async function handleSkillImport(params: {
  body: any
  organizationId: string | null
  sendJSON: SendJSON
  res: http.ServerResponse
  cliContext: CliRequestContext
}): Promise<void> {
  const spaceId = normalizedId(params.body?.space_id) ?? normalizedId(params.body?.spaceId)
  if (!spaceId) {
    params.sendJSON(params.res, 400, errorResponse('VALIDATION_ERROR', '缺少有效的 space_id'))
    return
  }
  try {
    const result = await skillsApplication(params.organizationId, params.cliContext).import({
        spaceId,
        url: typeof params.body?.url === 'string' ? params.body.url.trim() : '',
        sourcePath: typeof params.body?.path === 'string' ? params.body.path.trim() : '',
        name: typeof params.body?.name === 'string' ? params.body.name.trim() : undefined,
        enable: params.body?.enable !== false,
    })
    params.sendJSON(params.res, 200, {
      success: true,
      data: { ...result.data, ...(result.enableError ? { enable_error: result.enableError } : {}) },
    })
  } catch (error) {
    if (error instanceof SkillRegistryRequestError) {
      params.sendJSON(params.res, error.status, error.responseData)
      return
    }
    params.sendJSON(params.res, 400, errorResponse(
      'VALIDATION_ERROR',
      error instanceof Error ? error.message : String(error),
    ))
  }
}

export async function handleSkillInstallNpm(params: {
  body: any
  organizationId: string | null
  sendJSON: SendJSON
  res: http.ServerResponse
  addInteropRoot?: (rootPath: string) => Promise<void>
  importToSpace?: boolean
  cliContext: CliRequestContext
}): Promise<void> {
  const rawPackage = String(params.body?.package ?? params.body?.npm ?? params.body?.skill_key ?? '')
  if (!parseSkillsAddInput(rawPackage).source) {
    params.sendJSON(params.res, 400, errorResponse('VALIDATION_ERROR', '请提供源地址（如 https://github.com/owner/repo --skill foo，或 npm:@scope/pkg）'))
    return
  }
  try {
    const data = await skillsApplication(params.organizationId, params.cliContext).installNpm({
      packageName: rawPackage,
      spaceId: normalizedId(params.body?.space_id) ?? normalizedId(params.body?.spaceId),
      importToSpace: Boolean(params.body?.import_to_space ?? params.body?.importToSpace ?? params.importToSpace),
      addInteropRoot: params.addInteropRoot,
    })
    params.sendJSON(params.res, 200, { success: true, data })
  } catch (error) {
    params.sendJSON(params.res, 500, errorResponse('INTERNAL_ERROR', error instanceof Error ? error.message : String(error), {
      suggestions: ['确认本机已安装 Node.js / npx', '检查网络是否可访问 npm registry / GitHub'],
    }))
  }
}

export {
  collectSkillImportFiles,
  installNpmSkill,
  normalizeNpmPackageName,
  parseSkillsAddInput,
  resolveHomeAgentsSkillsDir,
} from '../../../../application/skills/skill-installation.js'
