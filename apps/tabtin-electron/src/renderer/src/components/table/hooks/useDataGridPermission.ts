/**
 * useDataGridPermission - 权限守卫 hook
 *
 * 职责：
 * 1. 403 错误检测 → is403Error()
 * 2. 403 降级只读 → mark403Readonly()（作为 TableReadonlyContext 的兜底）
 * 3. 计费配额 403 → 同时触发 showBillingErrorToast（A11）
 */

import React from 'react';
import { toast } from '@tabtin/smartsheet-ui';
import { extractBillingErrorCode, showBillingErrorToast } from '@/lib/billingErrorHandler';

export interface UseDataGridPermissionParams {
  selectedTableId: string | null;
  isTableReadonly: boolean;
  setTableReadonly: (readonly: boolean) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}

export interface UseDataGridPermissionReturn {
  is403Error: (error: unknown) => boolean;
  mark403Readonly: (error?: unknown) => void;
}

export function useDataGridPermission({
  selectedTableId,
  isTableReadonly,
  setTableReadonly,
  t,
}: UseDataGridPermissionParams): UseDataGridPermissionReturn {
  React.useEffect(() => {
    setTableReadonly(false);
  }, [selectedTableId, setTableReadonly]);

  const is403Error = React.useCallback((error: unknown): boolean => {
    if (!error) return false;
    const msg = error instanceof Error ? error.message : String(error);
    return (
      msg.includes('403') ||
      msg.includes('Forbidden') ||
      msg.includes('permission') ||
      msg.includes('PERMISSION_DENIED') ||
      extractBillingErrorCode(error) !== null
    );
  }, []);

  const mark403Readonly = React.useCallback((error?: unknown) => {
    const billingCode = extractBillingErrorCode(error);
    if (billingCode) {
      showBillingErrorToast(billingCode, {
        description: error instanceof Error ? error.message : undefined,
      });
    }

    if (!isTableReadonly) {
      setTableReadonly(true);
      if (!billingCode) {
        toast({
          title: String(t('table:permission.readonlyTitle' as any)),
          description: String(t('table:permission.readonlyDesc' as any)),
          variant: 'destructive',
        });
      }
    }
  }, [isTableReadonly, setTableReadonly, t]);

  return { is403Error, mark403Readonly };
}
