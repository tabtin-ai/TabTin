/**
 * RecordFormDialog - 记录表单抽屉
 *
 * 用于创建和编辑记录的表单抽屉
 * 根据表格的字段定义动态生成表单控件
 */

import * as React from 'react';
import { ArrowUpRight, ChevronDown, ChevronUp, History } from 'lucide-react';
import { FieldValueEditor } from '../field-editor/FieldValueEditor';
import type { FieldValueEditorField, AttachmentRenderProps } from '../field-editor/FieldValueEditor';
import type { UserOption } from '../user/UserSelector';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '../sheet';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../dialog';
import { Button } from '../button';
import { Label } from '../label';
import { ScrollArea } from '../scroll-area';
import { LoadingSpinner } from '../loading-spinner';
import { t } from '../../i18n';
import { cn } from '../../utils/cn';
import { validateFieldRules } from '../../utils/fieldValidationRules';
import { serializeComparableFormData } from './record-form-dirty';
import { shouldRecordFormDeferEnter } from './record-form-enter';

type PendingUnsavedAction =
  | { type: 'close' }
  | { type: 'navigate'; direction: 'prev' | 'next' };

type FieldType = string;

export interface FieldDefinition {
  id: string;
  name: string;
  displayName?: string;
  field_type: FieldType;
  is_primary: boolean;
  default_value?: { mode: string; value?: unknown } | null;
  is_hidden: boolean;
  description?: string;
  displayDescription?: string;
  options?: {
    choices?: Array<string | Record<string, unknown>>;
    bound_app_id?: string;
    app_config?: Record<string, any>;
    input_fields?: string[];
    output_format?: 'text' | 'json' | 'markdown';
    [key: string]: any;
  };
  width?: number;
  validation_rules?: Record<string, any>;
  visibility_roles?: string[];
  cellValueType?: 'string' | 'number' | 'boolean' | 'dateTime';
}

export interface RecordFormData {
  [fieldName: string]: any;
}

export interface AttachmentValue {
  reference_id?: string;
  file_id?: string;
  name?: string;
  url?: string;
  size?: number;
  mime_type?: string;
  [key: string]: any;
}

export interface AttachmentFieldRenderProps {
  field: FieldDefinition;
  value: AttachmentValue[];
  onChange: (value: AttachmentValue[]) => void;
  tableId?: string;
  recordId?: string;
  disabled?: boolean;
}

export interface RecordFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Drawer 入场动画完成后触发。 */
  onOpenComplete?: () => void;
  fields: FieldDefinition[];
  initialData?: RecordFormData;
  mode: 'create' | 'edit';
  onSubmit: (data: RecordFormData) => void | Promise<void>;
  isSubmitting?: boolean;
  isReadonly?: boolean;
  /** 加载中：保持同一 Sheet 骨架，正文显示 spinner，避免切换 drawer 闪烁 */
  isLoading?: boolean;
  /** 手机全屏详情使用模态语义，避免辅助技术继续访问底层表格。 */
  modal?: boolean;
  /** 是否允许点击 Drawer 外部关闭；默认新建可关闭、编辑详情不可关闭。 */
  maskClosable?: boolean;
  /** 为触控设备扩展表单内所有按钮的命中区域。 */
  touchOptimized?: boolean;
  /**
   * 为 true 时禁止自动抢焦点（从画布打开的非模态侧栏推荐开启）。
   * 表格容器 mousedown 会 focus 自己；Sheet 再抢焦点容易触发 FocusOutside 误关。
   */
  preventOpenAutoFocus?: boolean;
  title?: string;
  description?: string;
  tableId?: string;
  recordId?: string;
  renderAttachmentField?: (
    props: AttachmentFieldRenderProps,
  ) => React.ReactNode;
  canNavigatePrev?: boolean;
  canNavigateNext?: boolean;
  onNavigatePrev?: () => void;
  onNavigateNext?: () => void;
  /** 查看记录历史回调（仅 edit 模式，弹出独立对话框） */
  onViewHistory?: () => void;
  /** 内嵌历史面板内容（详情侧栏内嵌历史模式） */
  historyPanel?: React.ReactNode;
  /** 内嵌历史面板是否可见 */
  historyVisible?: boolean;
  /** 切换内嵌历史面板 */
  onHistoryToggle?: () => void;
  /** 标题栏右侧的业务动作；由调用方负责状态和权限。 */
  headerActions?: React.ReactNode;
  /** 记录表单之外的辅助面板，例如评论。 */
  secondaryPanel?: React.ReactNode;
  /** 是否展示辅助面板。 */
  secondaryPanelOpen?: boolean;
  /** 组织成员列表，用于 user 字段选择器和 created_by/last_modified_by 的显示 */
  organizationMembers?: UserOption[];
  /** 当前操作者；用于在新建表单中预填 creator 默认值。 */
  currentUserId?: string;
  /** link 字段点击回调（由父组件提供编辑能力） */
  onLinkFieldEdit?: (fieldId: string, fieldName: string, currentValue: unknown) => void;
  /** 打开关联记录完整详情（复用主字段展开侧栏） */
  onOpenLinkedRecord?: (payload: {
    fieldId: string
    foreignTableId: string
    recordId: string
    title?: string
  }) => void;
  /** edit 模式下离开表单时自动保存，不再依赖底部「保存」按钮。 */
  saveOnExit?: boolean;
  /**
   * 跨表详情：记录所属表名称（「记录来自」）。
   * 仅在从关联入口打开目标表记录时传入。
   */
  sourceTableName?: string;
  /** 点击「记录来自」表名时跳转到该表 */
  onGoToSourceTable?: () => void;
  /**
   * link 字段编辑完成回调（父组件调用以局部更新 formData 中的 link 字段值，
   * 避免通过 initialData 全量重置导致其他字段改动丢失）
   */
  onLinkFieldUpdateRef?: React.MutableRefObject<((fieldName: string, newValue: unknown) => void) | null>;
}



// Helper functions and NestedListEditor moved to FieldValueEditor.

function normalizeDateSubmitValue(value: unknown): unknown {
  if (value == null || value === '') return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return value.trim();
  }
  const date = value instanceof Date ? value : new Date(value as any);
  if (Number.isNaN(date.getTime())) return value;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateValueCarriesTime(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (/[tT]\d{2}:\d{2}/.test(value) || /\s+\d{1,2}:\d{2}/.test(value))
  );
}

function shouldStoreDateOnly(field: FieldDefinition): boolean {
  if (field.field_type !== 'date') return false;
  const timeFormat = field.options?.formatting?.time;
  return typeof timeFormat !== 'string' || timeFormat === 'None';
}

function buildSubmitData(data: RecordFormData, fields: FieldDefinition[]): RecordFormData {
  const next = { ...data };
  for (const field of fields) {
    if (
      shouldStoreDateOnly(field) &&
      Object.prototype.hasOwnProperty.call(next, field.name) &&
      !dateValueCarriesTime(next[field.name])
    ) {
      next[field.name] = normalizeDateSubmitValue(next[field.name]);
    }
  }
  return next;
}

export function applyRecordCreateDefaults(
  data: RecordFormData,
  fields: FieldDefinition[],
  currentUserId?: string,
  now: Date = new Date(),
): RecordFormData {
  const next = { ...data };
  const nowIso = now.toISOString();
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(next, field.name)) continue;
    const spec = field.default_value;
    if (spec?.mode === 'literal') next[field.name] = spec.value;
    if (spec?.mode === 'created_time' || spec?.mode === 'last_modified_time') {
      next[field.name] = nowIso;
    }
    if (spec?.mode === 'creator' && currentUserId) {
      next[field.name] = field.options?.multiple === true ? [currentUserId] : currentUserId;
    }
  }
  return next;
}

export const RecordFormDialog: React.FC<RecordFormDialogProps> = ({
  open,
  onOpenChange,
  onOpenComplete,
  fields,
  initialData = {},
  mode,
  onSubmit,
  isSubmitting = false,
  isReadonly = false,
  isLoading = false,
  modal = false,
  maskClosable,
  touchOptimized = false,
  preventOpenAutoFocus = false,
  title,
  description,
  tableId,
  recordId,
  renderAttachmentField,
  canNavigatePrev = false,
  canNavigateNext = false,
  onNavigatePrev,
  onNavigateNext,
  onViewHistory,
  historyPanel,
  historyVisible = false,
  onHistoryToggle,
  headerActions,
  secondaryPanel,
  secondaryPanelOpen = false,
  organizationMembers,
  currentUserId,
  onLinkFieldEdit,
  onOpenLinkedRecord,
  saveOnExit = false,
  sourceTableName,
  onGoToSourceTable,
  onLinkFieldUpdateRef,
}) => {
  const fieldsRef = React.useRef(fields);
  React.useEffect(() => {
    fieldsRef.current = fields;
  }, [fields]);

  const withCreateDefaults = React.useCallback((data: RecordFormData): RecordFormData => {
    if (mode !== 'create') return data;
    return applyRecordCreateDefaults(data, fieldsRef.current, currentUserId);
  }, [currentUserId, mode]);
  const [formData, setFormData] = React.useState<RecordFormData>(() => withCreateDefaults(initialData));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [saveErrors, setSaveErrors] = React.useState<Record<string, string>>({});
  const [unsavedConfirmOpen, setUnsavedConfirmOpen] = React.useState(false);
  const scrollViewportRef = React.useRef<HTMLDivElement | null>(null);
  const baselineDataRef = React.useRef<RecordFormData>(
    withCreateDefaults(initialData),
  );
  const pendingUnsavedActionRef = React.useRef<PendingUnsavedAction | null>(
    null,
  );
  const submitPromiseRef = React.useRef<Promise<boolean> | null>(null);
  const validationErrorsRef = React.useRef<Record<string, string>>({});
  const invalidFieldFallbackRef = React.useRef<Record<string, unknown>>({});
  const showRecordNavigation =
    mode === 'edit' && (onNavigatePrev || onNavigateNext);
  const saveOnExitEnabled = saveOnExit && mode === 'edit' && !isReadonly;

  const prevRecordIdRef = React.useRef(recordId);
  const prevOpenRef = React.useRef(open);

  const isDirty =
    !isReadonly &&
    serializeComparableFormData(formData, fields) !==
      serializeComparableFormData(baselineDataRef.current, fields);

  /**
   * 滚轮：Radix modal Dialog 的 RemoveScroll 会在 capture 阶段 preventDefault，
   * 叠在关联选择器上的非模态 Sheet 原生滚轮会失效（拖 scrollbar 仍可用）。
   * 在滚动容器上 capture 手动改 scrollTop，并挡住下层画布/选择器继续吃 wheel。
   */
  React.useEffect(() => {
    if (!open) return;
    const el = scrollViewportRef.current;
    if (!el) return;

    const onWheel = (event: WheelEvent) => {
      if (el.scrollHeight <= el.clientHeight) return;
      event.preventDefault();
      event.stopPropagation();
      el.scrollTop += event.deltaY;
    };

    el.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => {
      el.removeEventListener('wheel', onWheel, { capture: true });
    };
  }, [open, isLoading, historyVisible]);

  React.useEffect(() => {
    const recordChanged = prevRecordIdRef.current !== recordId;
    const justOpened = open && !prevOpenRef.current;
    prevRecordIdRef.current = recordId;
    prevOpenRef.current = open;

    // 切换记录、或对话框重新打开：以最新 initialData 为准全量重置。
    // 对话框关闭时不会卸载（仅 open 切换），formData 会跨开关残留——若不在「重新打开」
    // 时重置，同一行在框内编辑、关闭、行内编辑后再打开，框内仍是上次的陈旧值。
    if (recordChanged || justOpened) {
      const nextInitialData = withCreateDefaults(initialData);
      setFormData(nextInitialData);
      setErrors({});
      setSaveErrors({});
      validationErrorsRef.current = {};
      invalidFieldFallbackRef.current = {};
      baselineDataRef.current = nextInitialData;
      pendingUnsavedActionRef.current = null;
      setUnsavedConfirmOpen(false);
      return;
    }

    // 同一记录、对话框持续打开期间 initialData 变化（如 link 字段编辑回填）：
    // 仅补齐缺失/未定义的键，避免冲掉用户尚未保存的其他字段改动。
    setFormData((prev) => {
      const merged = { ...prev };
      const mergedBaseline = { ...baselineDataRef.current };
      for (const key of Object.keys(initialData)) {
        if (!(key in prev) || prev[key] === undefined) {
          merged[key] = initialData[key];
          mergedBaseline[key] = initialData[key];
        }
      }
      baselineDataRef.current = mergedBaseline;
      return merged;
    });
    // fields 故意不进依赖：父组件常每次 render 新数组引用；基准只在打开/切记录时刷新。
  }, [initialData, recordId, open, withCreateDefaults]);

  React.useEffect(() => {
    if (onLinkFieldUpdateRef) {
      onLinkFieldUpdateRef.current = (fieldName: string, newValue: unknown) => {
        setFormData((prev) => ({ ...prev, [fieldName]: newValue }));
      };
      return () => { onLinkFieldUpdateRef.current = null; };
    }
  }, [onLinkFieldUpdateRef]);

  // 重置表单
  const resetForm = () => {
    const nextInitialData = withCreateDefaults(initialData);
    setFormData(nextInitialData);
    setErrors({});
    setSaveErrors({});
    validationErrorsRef.current = {};
    invalidFieldFallbackRef.current = {};
    baselineDataRef.current = nextInitialData;
  };

  // 关闭抽屉
  const handleClose = () => {
    pendingUnsavedActionRef.current = null;
    setUnsavedConfirmOpen(false);
    resetForm();
    onOpenChange(false);
  };

  const submitCurrentForm = async (): Promise<boolean> => {
    if (submitPromiseRef.current) return submitPromiseRef.current;
    const promise = (async () => {
      if (isReadonly || isSubmitting) return true;
      if (!validateForm()) return false;
      const changedFieldNames = fields
        .filter((field) => !field.is_hidden)
        .filter((field) => serializeComparableFormData(
          { [field.name]: formData[field.name] },
          [field],
        ) !== serializeComparableFormData(
          { [field.name]: baselineDataRef.current[field.name] },
          [field],
        ))
        .map((field) => field.name);
      try {
        await onSubmit(buildSubmitData(formData, fields));
        baselineDataRef.current = formData;
        invalidFieldFallbackRef.current = {};
        setSaveErrors({});
        return true;
      } catch (error) {
        console.error('鎻愪氦琛ㄥ崟澶辫触:', error);
        const message = error instanceof Error ? error.message : t('recordFormDialog.errors.saveFailed', {
          defaultValue: '保存失败，请重试',
        });
        setSaveErrors(Object.fromEntries(changedFieldNames.map((name) => [name, message])));
        return false;
      }
    })();
    submitPromiseRef.current = promise;
    try {
      return await promise;
    } finally {
      submitPromiseRef.current = null;
    }
  };

  const runPendingUnsavedAction = () => {
    const action = pendingUnsavedActionRef.current;
    pendingUnsavedActionRef.current = null;
    setUnsavedConfirmOpen(false);
    if (!action || action.type === 'close') {
      handleClose();
      return;
    }
    if (action.direction === 'prev') {
      onNavigatePrev?.();
      return;
    }
    onNavigateNext?.();
  };

  const requestClose = () => {
    if (saveOnExitEnabled) {
      if (!isDirty) {
        handleClose();
        return;
      }
      if (!validateForm()) {
        const invalidNames = Object.keys(validationErrorsRef.current);
        const rollbackData = { ...formData };
        for (const fieldName of invalidNames) {
          rollbackData[fieldName] = Object.prototype.hasOwnProperty.call(
            invalidFieldFallbackRef.current,
            fieldName,
          )
            ? invalidFieldFallbackRef.current[fieldName]
            : baselineDataRef.current[fieldName];
        }
        setFormData(rollbackData);
        setErrors({});
        setSaveErrors({});
        invalidFieldFallbackRef.current = {};
        handleClose();
        return;
      }
      void (async () => {
        const saved = await submitCurrentForm();
        if (saved) handleClose();
      })();
      return;
    }
    if (isDirty) {
      pendingUnsavedActionRef.current = { type: 'close' };
      setUnsavedConfirmOpen(true);
      return;
    }
    handleClose();
  };

  const requestNavigate = (direction: 'prev' | 'next') => {
    if (isSubmitting && !saveOnExitEnabled) return;
    if (saveOnExitEnabled) {
      if (!isDirty) {
        if (direction === 'prev') {
          onNavigatePrev?.();
          return;
        }
        onNavigateNext?.();
        return;
      }
      void (async () => {
        const saved = await submitCurrentForm();
        if (!saved) return;
        if (direction === 'prev') {
          onNavigatePrev?.();
          return;
        }
        onNavigateNext?.();
      })();
      return;
    }
    if (isDirty) {
      pendingUnsavedActionRef.current = { type: 'navigate', direction };
      setUnsavedConfirmOpen(true);
      return;
    }
    if (direction === 'prev') {
      onNavigatePrev?.();
      return;
    }
    onNavigateNext?.();
  };

  const handleKeepEditing = () => {
    pendingUnsavedActionRef.current = null;
    setUnsavedConfirmOpen(false);
  };

  const handleDiscardUnsaved = () => {
    const action = pendingUnsavedActionRef.current;
    pendingUnsavedActionRef.current = null;
    setUnsavedConfirmOpen(false);
    if (!action || action.type === 'close') {
      handleClose();
      return;
    }
    resetForm();
    if (action.direction === 'prev') {
      onNavigatePrev?.();
      return;
    }
    onNavigateNext?.();
  };

  const handleSaveUnsaved = async () => {
    if (isReadonly) return;
    if (!validateForm()) {
      pendingUnsavedActionRef.current = null;
      setUnsavedConfirmOpen(false);
      return;
    }
    try {
      await onSubmit(buildSubmitData(formData, fields));
      baselineDataRef.current = formData;
      runPendingUnsavedAction();
    } catch (error) {
      console.error('提交表单失败:', error);
      pendingUnsavedActionRef.current = null;
      setUnsavedConfirmOpen(false);
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      onOpenChange(true);
      return;
    }
    requestClose();
  };

  const handlePointerDownOutside = (event: Event) => {
    const canDismissOnOutside = maskClosable ?? mode === 'create';
    if (!canDismissOnOutside || isLoading || (isSubmitting && !saveOnExitEnabled)) {
      event.preventDefault();
      return;
    }
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('[role="dialog"]')) {
      event.preventDefault();
      return;
    }
    if (saveOnExitEnabled && isDirty) {
      event.preventDefault();
      void requestClose();
      return;
    }
    if (isDirty) {
      event.preventDefault();
      pendingUnsavedActionRef.current = { type: 'close' };
      setUnsavedConfirmOpen(true);
    }
  };

  /**
   * 焦点离开：必须忽略。
   * 生命周期：画布 mousedown → Grid 容器 focus（tabIndex=0）→ 打开非模态 Sheet →
   * 焦点仍在画布上 → Radix DismissableLayer 派发 FocusOutside → 若不拦截会立刻关掉。
   * 与 ShareDialog / ImportDialog 同一修法；外部点击也不关闭记录详情。
   */
  const handleFocusOutside = (event: Event) => {
    event.preventDefault();
  };

  const handleFormBlurCapture = (event: React.FocusEvent<HTMLFormElement>) => {
    if (!saveOnExitEnabled || isSubmitting || isLoading || !isDirty) return;
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    void submitCurrentForm();
  };

  // 更新字段值
  const updateField = (fieldName: string, value: any) => {
    setFormData((prev) => {
      if (!Object.prototype.hasOwnProperty.call(invalidFieldFallbackRef.current, fieldName)) {
        invalidFieldFallbackRef.current[fieldName] = prev[fieldName];
      }
      return {
        ...prev,
        [fieldName]: value,
      };
    });
    // 清除该字段的错误
    if (errors[fieldName]) {
      setErrors((prev) => {
        const newErrors = { ...prev };
        delete newErrors[fieldName];
        return newErrors;
      });
    }
    if (saveErrors[fieldName]) {
      setSaveErrors((prev) => {
        const next = { ...prev };
        delete next[fieldName];
        return next;
      });
    }
  };

  // 验证表单
  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    fields.forEach((field) => {
      // 跳过隐藏字段
      if (field.is_hidden) return;

      const value = formData[field.name];
      const rulesResult = validateFieldRules(
        value,
        field.validation_rules,
      );
      if (!rulesResult.valid) {
        const customMessage =
          typeof rulesResult.params?.message === 'string'
            ? rulesResult.params.message
            : undefined;
        if (customMessage) {
          newErrors[field.name] = customMessage;
        } else if (rulesResult.errorCode === 'min_length') {
          const min = Number(rulesResult.params?.minLength ?? '')
          newErrors[field.name] = t('recordFormDialog.errors.minLength', {
            name: field.name,
            min: Number.isFinite(min) ? min : '',
            defaultValue: `${field.name} 长度不能小于 ${Number.isFinite(min) ? min : ''}`,
          });
        } else if (rulesResult.errorCode === 'max_length') {
          const max = Number(rulesResult.params?.maxLength ?? '')
          newErrors[field.name] = t('recordFormDialog.errors.maxLength', {
            name: field.name,
            max: Number.isFinite(max) ? max : '',
            defaultValue: `${field.name} 长度不能超过 ${Number.isFinite(max) ? max : ''}`,
          });
        } else if (rulesResult.errorCode === 'pattern') {
          newErrors[field.name] = t('recordFormDialog.errors.pattern', {
            name: field.name,
            defaultValue: `${field.name} 格式不符合要求`,
          });
        } else {
          newErrors[field.name] = t('recordFormDialog.errors.validation', {
            name: field.name,
            defaultValue: `${field.name} 未通过验证规则`,
          });
        }
        return;
      }

      // 类型验证
      if (value) {
        switch (field.field_type) {
          case 'email':
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
              newErrors[field.name] = t('recordFormDialog.errors.email');
            }
            break;
          case 'url':
            try {
              new URL(value);
            } catch {
              newErrors[field.name] = t('recordFormDialog.errors.url');
            }
            break;
          case 'phone': {
            // 与 table-ui / table-kernel 默认 CN 规则对齐：手机号 / 固话 / 400·800
            const phoneDigits = String(value).replace(/\D/g, '');
            const isMobile = /^1[3-9]\d{9}$/.test(phoneDigits);
            const isLandline = /^0\d{2,3}\d{7,8}$/.test(phoneDigits);
            const isService = /^[48]00\d{7}$/.test(phoneDigits);
            if (!isMobile && !isLandline && !isService) {
              newErrors[field.name] = t('recordFormDialog.errors.phone');
            }
            break;
          }
          case 'number':
          case 'percent':
          case 'currency':
            if (isNaN(Number(value))) {
              newErrors[field.name] = t('recordFormDialog.errors.number');
            }
            break;
          case 'date': {
            const timestamp = Date.parse(value);
            if (Number.isNaN(timestamp)) {
              newErrors[field.name] = t('recordFormDialog.errors.datetime');
            }
            break;
          }
          case 'attachment':
          {
            if (!Array.isArray(value)) {
              newErrors[field.name] = t('recordFormDialog.errors.attachment');
            }
            break;
          }
        }
      }
    });

    validationErrorsRef.current = newErrors;
    setErrors(newErrors);
    for (const field of fields) {
      if (!newErrors[field.name]) {
        delete invalidFieldFallbackRef.current[field.name];
      }
    }
    return Object.keys(newErrors).length === 0;
  };

  // 提交表单
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isReadonly) return;

    if (!validateForm()) {
      return;
    }

    try {
      await onSubmit(buildSubmitData(formData, fields));
      if (!saveOnExitEnabled) {
        handleClose();
      } else {
        baselineDataRef.current = formData;
      }
    } catch (error) {
      console.error('提交表单失败:', error);
    }
  };

  const handleFormKeyDown = (event: React.KeyboardEvent<HTMLFormElement>) => {
    if (
      event.key !== 'Enter' ||
      event.shiftKey ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      isSubmitting
    ) {
      return;
    }

    // cmdk 搜索框 / 选项项自行处理 Enter（选中高亮项），勿当作表单提交
    if (shouldRecordFormDeferEnter(event.target)) return;
    if (saveOnExitEnabled) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    event.currentTarget.requestSubmit();
  };

  // 渲染字段输入控件
  const renderFieldInput = (field: FieldDefinition) => {
    const value = formData[field.name] ?? '';
    const error = errors[field.name] || saveErrors[field.name];

    const editorField: FieldValueEditorField = {
      id: field.id,
      name: field.name,
      displayName: field.displayName,
      field_type: field.field_type,
      description: field.description,
      displayDescription: field.displayDescription,
      is_primary: field.is_primary,
      options: field.options as Record<string, any>,
      cellValueType: field.cellValueType,
    };

    const attachmentAdapter = renderAttachmentField
      ? (props: AttachmentRenderProps) =>
          renderAttachmentField!({
            field,
            value: Array.isArray(props.value) ? props.value as AttachmentValue[] : [],
            onChange: (next) => props.onChange(next),
            tableId: props.tableId,
            recordId: props.recordId,
            disabled: props.disabled,
          })
      : undefined;

    return (
      <>
        <FieldValueEditor
          key={field.id}
          field={editorField}
          value={value}
          onChange={(v) => updateField(field.name, v)}
          error={error}
          disabled={isSubmitting || isReadonly || field.default_value?.mode === 'last_modified_time'}
          mode={mode}
          tableId={tableId}
          recordId={recordId}
          organizationMembers={organizationMembers}
          renderAttachment={attachmentAdapter}
          onLinkEdit={onLinkFieldEdit}
          onOpenLinkedRecord={onOpenLinkedRecord}
          getFieldExtra={(key) => formData[key]}
        />
        {saveErrors[field.name] && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-1 h-7 px-0 text-body text-destructive hover:text-destructive"
            onClick={() => {
              void submitCurrentForm();
            }}
            disabled={isSubmitting}
          >
            {t('recordFormDialog.retry', { defaultValue: '重试' })}
          </Button>
        )}
      </>
    );
  };

  // 过滤掉隐藏字段
  const visibleFields = fields.filter((field) => !field.is_hidden);

  const showSecondaryPanel = Boolean(
    secondaryPanel && secondaryPanelOpen && !historyVisible,
  );
  const primaryPanelClassName = cn(
    'min-w-0 flex-1 overflow-hidden',
    showSecondaryPanel
      ? 'hidden @[720px]/record-detail:flex @[720px]/record-detail:w-[420px] @[720px]/record-detail:flex-none'
      : 'flex',
  );

  const handleOpenAnimationEnd = React.useCallback(
    (event: React.AnimationEvent<HTMLDivElement>) => {
      if (!open || event.target !== event.currentTarget) return;
      onOpenComplete?.();
    },
    [onOpenComplete, open],
  );

  return (
    <>
    <Sheet open={open} onOpenChange={handleOpenChange} modal={modal}>
      <SheetContent
        side="right"
        overlay={modal}
        data-record-form-touch-optimized={touchOptimized || undefined}
        className={cn(
          'flex h-full flex-col overflow-hidden p-0 @container/record-detail',
          showSecondaryPanel
            ? 'w-[min(780px,100%)] max-w-full sm:max-w-[780px]'
            : 'w-full max-w-full rounded-none sm:w-[420px] sm:max-w-[420px] sm:rounded-[12px]',
        )}
        onPointerDownOutside={handlePointerDownOutside}
        onInteractOutside={handlePointerDownOutside}
        onFocusOutside={handleFocusOutside}
        onAnimationEnd={handleOpenAnimationEnd}
        onOpenAutoFocus={
          preventOpenAutoFocus
            ? (event) => {
                event.preventDefault();
              }
            : undefined
        }
      >
        <SheetHeader className="shrink-0 border-b border-border/40 px-4 py-3 pr-12 pt-[max(0.75rem,env(safe-area-inset-top))]">
          <div className="flex items-center gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <div className="min-w-0">
                <SheetTitle className="truncate text-body">
                  {title ||
                    (mode === 'create'
                      ? t('recordFormDialog.title.create')
                      : t('recordFormDialog.title.edit'))}
                </SheetTitle>
                <SheetDescription className="sr-only">
                  {description ||
                    title ||
                    (mode === 'create'
                      ? t('recordFormDialog.title.create')
                      : t('recordFormDialog.title.edit'))}
                </SheetDescription>
              </div>
              {showRecordNavigation && (
                <div className="flex shrink-0 items-center rounded-md border border-border/60">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 rounded-none rounded-l-md border-r border-border/60"
                    onClick={() => requestNavigate('prev')}
                    disabled={isSubmitting || !canNavigatePrev || !onNavigatePrev}
                    aria-label={t('common.previous')}
                  >
                    <ChevronUp className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 rounded-none rounded-r-md"
                    onClick={() => requestNavigate('next')}
                    disabled={isSubmitting || !canNavigateNext || !onNavigateNext}
                    aria-label={t('common.next')}
                  >
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>
            {mode === 'edit' && (onHistoryToggle || onViewHistory) && (
              <Button
                type="button"
                variant={historyVisible ? 'secondary' : 'ghost'}
                size="sm"
                className="shrink-0 gap-1.5 text-muted-foreground hover:text-foreground"
                onClick={onHistoryToggle || onViewHistory}
              >
                <History className="h-4 w-4" />
                <span className="hidden sm:inline text-body">{t('recordFormDialog.viewHistory')}</span>
              </Button>
            )}
            {headerActions}
          </div>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* 内嵌历史面板（recordHistoryVisible 侧栏模式） */}
          {isLoading ? (
            <div className={cn(primaryPanelClassName, 'items-center justify-center')}>
              <LoadingSpinner size="sm" />
            </div>
          ) : historyVisible && historyPanel ? (
            <div className={cn(primaryPanelClassName, 'flex-col rounded-b bg-background')}>
              {historyPanel}
            </div>
          ) : (
            <form
              onSubmit={handleSubmit}
              onKeyDown={handleFormKeyDown}
              onBlurCapture={handleFormBlurCapture}
              className={cn(primaryPanelClassName, 'flex-col')}
            >
            <div className="flex-1 overflow-hidden">
              <ScrollArea
                viewportRef={scrollViewportRef}
                className="h-full w-full pr-2 sm:pr-4"
              >
                <div className="space-y-6 px-4 py-4 sm:px-6">
                  {visibleFields.map((field) => (
                    <div key={field.id} className="space-y-2">
                      <Label
                        htmlFor={field.id}
                        className="flex items-center gap-1"
                      >
                        {field.displayName || field.name}
                        {field.is_primary && (
                          <span className="text-body text-muted-foreground">
                            {t('recordFormDialog.primaryField')}
                          </span>
                        )}
                      </Label>
                      {renderFieldInput(field)}
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>

            <SheetFooter className="shrink-0 flex-col gap-3 border-t border-border/40 px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:flex-col sm:space-x-0 sm:px-6">
              {sourceTableName ? (
                <div className="flex w-full min-w-0 items-center gap-2">
                  <span className="shrink-0 text-body text-muted-foreground">
                    {t('recordFormDialog.recordFrom')}
                  </span>
                  {onGoToSourceTable ? (
                    <button
                      type="button"
                      className="inline-flex min-w-0 max-w-full items-center gap-1 text-left text-body text-primary hover:underline"
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        onGoToSourceTable()
                      }}
                    >
                      <span className="truncate">{sourceTableName}</span>
                      <ArrowUpRight className="h-3.5 w-3.5 shrink-0" />
                    </button>
                  ) : (
                    <span className="truncate text-body text-foreground">
                      {sourceTableName}
                    </span>
                  )}
                </div>
              ) : null}
              <div className="flex w-full justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={saveOnExitEnabled ? requestClose : handleClose}
                  disabled={isSubmitting}
                >
                  {isReadonly || saveOnExitEnabled ? t('common.close') : t('common.cancel')}
                </Button>
                {!isReadonly && !saveOnExitEnabled && (
                  <Button type="submit" disabled={isSubmitting}>
                    {isSubmitting
                      ? t('recordFormDialog.submitting')
                      : mode === 'create'
                        ? t('common.create')
                        : t('common.save')}
                  </Button>
                )}
              </div>
            </SheetFooter>
            </form>
          )}
          {showSecondaryPanel ? (
            <aside className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background @[720px]/record-detail:border-l @[720px]/record-detail:border-border/40">
              {secondaryPanel}
            </aside>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>

    <Dialog
      open={unsavedConfirmOpen}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) handleKeepEditing();
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        container={null}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          handleKeepEditing();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('recordFormDialog.unsaved.title')}</DialogTitle>
          <DialogDescription>
            {t('recordFormDialog.unsaved.description')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={handleKeepEditing}
            disabled={isSubmitting}
          >
            {t('recordFormDialog.unsaved.keepEditing')}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={handleDiscardUnsaved}
            disabled={isSubmitting}
          >
            {t('recordFormDialog.unsaved.discard')}
          </Button>
          <Button
            type="button"
            onClick={() => {
              void handleSaveUnsaved();
            }}
            disabled={isSubmitting}
          >
            {isSubmitting
              ? t('recordFormDialog.submitting')
              : t('recordFormDialog.unsaved.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
};
