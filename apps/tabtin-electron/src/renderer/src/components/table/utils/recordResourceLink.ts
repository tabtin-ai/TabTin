import {
  resolveTabTinResourceScheme,
  serializeSelfFormat,
} from '@tabtin/resource-router';
import { API_BASE_URL } from '@/config/api';
import { BUILD_PROFILE } from '@/utils/featureFlags';

interface RecordResourceLinkRuntime {
  apiBaseUrl?: string;
  buildProfile?: string;
}

export function buildRecordResourceLink(
  tableId: string,
  recordId: string,
  runtime: RecordResourceLinkRuntime = {},
): string {
  const scheme = resolveTabTinResourceScheme({
    apiBaseUrl: runtime.apiBaseUrl ?? API_BASE_URL,
    buildProfile: runtime.buildProfile ?? BUILD_PROFILE,
  });
  return serializeSelfFormat(
    {
      type: 'table',
      id: tableId,
      hint: 'tabdata',
      meta: { recordIds: recordId },
    },
    scheme,
  );
}
