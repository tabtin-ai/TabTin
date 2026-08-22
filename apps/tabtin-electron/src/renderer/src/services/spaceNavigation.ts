import { toast } from '@tabtin/smartsheet-ui/toast';
import { ensureSpaceSelected } from './spaceSelection';

export interface SpaceNavigationFailureToast {
  title: string;
  description?: string;
  variant?: 'default' | 'destructive';
}

export interface EnsureSpaceSelectedWithFeedbackOptions {
  organizationId?: string;
  failureToast?: SpaceNavigationFailureToast;
  /** 异步加载后仍允许本次调用选中 Space；过期导航传入 false 以避免覆盖较新选择。 */
  isCurrent?: () => boolean;
}

export interface EnsureSpaceSelectedOrThrowOptions {
  organizationId?: string;
  failureMessage?: string;
}

const DEFAULT_FAILURE_TOAST: SpaceNavigationFailureToast = {
  title: '无法打开该 Space',
  description: '该 Space 可能是私有的、你没有访问权限、已归档，或当前工作区数据尚未同步完成',
  variant: 'destructive',
};

const DEFAULT_THROW_MESSAGE = '无法打开该 Space';

export async function ensureSpaceSelectedWithFeedback(
  spaceId: string,
  options: EnsureSpaceSelectedWithFeedbackOptions = {},
): Promise<boolean> {
  const success = options.isCurrent
    ? await ensureSpaceSelected(spaceId, options.organizationId, options.isCurrent)
    : await ensureSpaceSelected(spaceId, options.organizationId);
  if (success) return true;
  if (options.isCurrent?.() === false) return false;

  const feedback = options.failureToast ?? DEFAULT_FAILURE_TOAST;
  toast({
    title: feedback.title,
    description: feedback.description,
    variant: feedback.variant ?? 'destructive',
  });
  return false;
}

export async function ensureSpaceSelectedOrThrow(
  spaceId: string,
  options: EnsureSpaceSelectedOrThrowOptions = {},
): Promise<void> {
  const success = await ensureSpaceSelected(spaceId, options.organizationId);
  if (success) return;

  throw new Error(options.failureMessage ?? DEFAULT_THROW_MESSAGE);
}
