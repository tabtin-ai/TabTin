import type { AgentTool } from '../types';
import {
  getSharedSessionToolImpl,
  type ManageCookiesInput,
  type ManageCookiesOutput,
  type ClearSessionInput,
  type ClearSessionOutput,
} from '../impl/SessionToolImpl';
import { standardizeLegacyResult } from '../utils/tool-output';
import { t } from '../i18n';

export type { ManageCookiesInput, ManageCookiesOutput, ClearSessionInput, ClearSessionOutput };

export const manageCookiesTool: AgentTool<ManageCookiesInput, ManageCookiesOutput> = {
  name: 'manage_cookies',
  description: t('tools.session.manageCookies.description'),
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get', 'set', 'clear'],
        description: t('tools.session.manageCookies.params.action'),
      },
      domain: {
        type: 'string',
        description: t('tools.session.manageCookies.params.domain'),
      },
      url: {
        type: 'string',
        description: t('tools.session.manageCookies.params.url'),
      },
      cookies: {
        type: 'array',
        description: t('tools.session.manageCookies.params.cookies'),
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            value: { type: 'string' },
            domain: { type: 'string' },
            path: { type: 'string' },
            secure: { type: 'boolean' },
            httpOnly: { type: 'boolean' },
            expires: { type: 'number' },
            sameSite: { type: 'string', enum: ['Strict', 'Lax', 'None'] },
          },
          required: ['name', 'value'],
        },
      },
    },
    required: ['action'],
  },
  async execute(input: ManageCookiesInput): Promise<ManageCookiesOutput> {
    const impl = getSharedSessionToolImpl();
    const result = await impl.manageCookies(input);
    return standardizeLegacyResult(result);
  },
};

export const clearSessionTool: AgentTool<ClearSessionInput, ClearSessionOutput> = {
  name: 'clear_session',
  description: t('tools.session.clearSession.description'),
  parameters: {
    type: 'object',
    properties: {
      clearCookies: {
        type: 'boolean',
        description: t('tools.session.clearSession.params.clearCookies'),
        default: true,
      },
      clearLocalStorage: {
        type: 'boolean',
        description: t('tools.session.clearSession.params.clearLocalStorage'),
        default: true,
      },
      clearCache: {
        type: 'boolean',
        description: t('tools.session.clearSession.params.clearCache'),
        default: true,
      },
    },
    required: [],
  },
  async execute(input: ClearSessionInput): Promise<ClearSessionOutput> {
    const impl = getSharedSessionToolImpl();
    const result = await impl.clearSession(input);
    return standardizeLegacyResult(result);
  },
};

export const sessionTools = [manageCookiesTool, clearSessionTool];
