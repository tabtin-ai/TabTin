/**
 * RecordFormContainer - 记录表单容器组件
 *
 * 连接 UI 组件和状态管理
 * 负责调用 API 创建/更新记录
 */

import React from 'react';
import {
  Button,
  CommentsSection,
  RecordFormDialog,
  RecordHistoryPanel,
  useToast,
  type CommentItem,
  type CommentMentionCandidate,
  type RecordFormData,
  type AttachmentFieldRenderProps,
  type HistoryOperation,
} from '@tabtin/smartsheet-ui';
import { MessageSquare } from 'lucide-react';
import { toFieldDefinitions, toOrganizationMembers } from '@tabtin/table-ui';
import { UndoRedoApiService, computeChangedRecordData, isOutOfBandManagedField } from '@tabtin/table-core';
import { useTableStore } from '@stores/useTableStore';
import { useRecordStore } from '@stores/useRecordStore';
import { useViewStore } from '@stores/useViewStore';
import { useUIStore } from '@stores/useUIStore';
import type { AttachmentReference, Field, TableRecord } from '@tabtin/table-core';
import { AttachmentField } from '@/components/attachments/AttachmentField';
import { LinkCellEditor } from '@/components/field/LinkCellEditor';
import { LinkedRecordFormHost } from '@/components/record/LinkedRecordFormHost';
import { useAttachmentStore } from '@stores/useAttachmentStore';
import { useOrganizationStore } from '@stores/useOrganizationStore';
import { useAuthStore } from '@stores/useAuthStore';
import { useTranslation } from 'react-i18next';
import {
  announceTableDrawerOpen,
  useCloseOnOtherTableDrawerOpen,
} from '@/components/table/utils/tableDrawerCoordinator';
import { useTableCollabOptional } from '@/components/table/TableCollabContext';
import { useRecordComments } from './useRecordComments';
import { RecordFormFocusTarget } from './recordFormFocusTarget';

interface LinkEditorModalState {
  fieldId: string;
  fieldName: string;
  fieldConfig: {
    foreignTableId: string;
    relationship: string;
    lookupFieldId?: string;
    isOneWay?: boolean;
  };
  currentValue: Array<{ id: string; title?: string }>;
}

const SYSTEM_PARENT_RECORD_FIELD_NAME = '父记录';
const SYSTEM_PARENT_RECORD_FIELD_DESCRIPTION = '子记录层级关系的父记录字段';

function isSystemParentRecordField(field: Field, tableId?: string): boolean {
  if (field.field_type !== 'link') return false;
  if (field.name !== SYSTEM_PARENT_RECORD_FIELD_NAME) return false;
  if (field.description !== SYSTEM_PARENT_RECORD_FIELD_DESCRIPTION) return false;
  const options = field.options ?? {};
  const foreignTableId = typeof options.foreignTableId === 'string' ? options.foreignTableId : undefined;
  const relationship = typeof options.relationship === 'string' ? options.relationship : undefined;
  return (!tableId || !foreignTableId || foreignTableId === tableId) && relationship === 'ManyOne';
}

export interface RecordFormContainerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode?: 'create' | 'edit';
  record?: TableRecord;
  initialValues?: RecordFormData;
  canNavigatePrev?: boolean;
  canNavigateNext?: boolean;
  onNavigatePrev?: () => void;
  onNavigateNext?: () => void;
  /** 查看记录历史回调 */
  onViewHistory?: (recordId: string, recordLabel: string) => void;
  isReadonly?: boolean;
  /** 从通知等外部入口打开记录时，直接展示评论区域。 */
  initialCommentsOpen?: boolean;
  /** Drawer 完成打开后需要聚焦的编辑目标。 */
  initialFocusTarget?: RecordFormFocusTarget | null;
  /** 通知深链需要定位并高亮的评论。 */
  targetCommentId?: string;
}

export const RecordFormContainer: React.FC<RecordFormContainerProps> = ({
  open,
  onOpenChange,
  mode = 'create',
  record,
  initialValues,
  canNavigatePrev = false,
  canNavigateNext = false,
  onNavigatePrev,
  onNavigateNext,
  onViewHistory,
  isReadonly = false,
  initialCommentsOpen = false,
  initialFocusTarget = null,
  targetCommentId,
}) => {
  const { t } = useTranslation('record');
  const drawerId = React.useId();
  const { toast } = useToast();
  const selectedTable = useTableStore((state) => state.selectedTable);
  const fields = useTableStore((state) => state.fields);
  const createRecord = useRecordStore((state) => state.createRecord);
  const updateRecord = useRecordStore((state) => state.updateRecord);
  const currentViewId = useViewStore((state) => state.currentViewId);
  const refreshCurrentView = useViewStore((state) => state.refreshCurrentView);
  const setError = useUIStore((state) => state.setError);
  const clearAttachmentTasks = useAttachmentStore((state) => state.clearAll);
  const wsMembers = useOrganizationStore((state) => state.members);
  const currentUserId = useAuthStore((state) => state.user?.id != null ? String(state.user.id) : undefined);
  const mergeIncrementalRecords = useRecordStore((state) => state.mergeIncrementalRecords);
  const mergeRestoredRecords = useRecordStore((state) => state.mergeRestoredRecords);
  const records = useRecordStore((state) => state.records);
  const latestVersion = useRecordStore((state) => state.latestVersion);
  // ：协作在线时记录表单写入走 Y.Doc（他端实时可见）；否则保持现有 REST 行为不变。
  const tableCollab = useTableCollabOptional();
  const mirrorRecordsToCollab = tableCollab?.mirrorRecordsToCollab;
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const saveOnExit = mode === 'edit' && !isReadonly;

  // ── Link editor state ──
  const [linkEditorState, setLinkEditorState] = React.useState<LinkEditorModalState | null>(null);
  const [linkFieldOverrides, setLinkFieldOverrides] = React.useState<Record<string, unknown>>({});
  const [linkedRecordDetail, setLinkedRecordDetail] = React.useState<{
    foreignTableId: string;
    recordId: string;
    title?: string;
  } | null>(null);

  // ── Inline history panel state ──
  const [historyVisible, setHistoryVisible] = React.useState(false);
  const [historyOps, setHistoryOps] = React.useState<HistoryOperation[]>([]);
  const [historyTotal, setHistoryTotal] = React.useState(0);
  const [historyLoading, setHistoryLoading] = React.useState(false);
  const [historyNextCursor, setHistoryNextCursor] = React.useState<string | null>(null);
  const historyRetryCount = React.useRef(0);
  const historyRequestId = React.useRef(0);
  const historyRecordId = React.useRef(record?.id);
  const historyRetryTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [commentsVisible, setCommentsVisible] = React.useState(false);
  const [activeFocusTarget, setActiveFocusTarget] = React.useState<RecordFormFocusTarget | null>(null);
  const recordComments = useRecordComments({
    recordId: record?.id,
    anchorCommentId: targetCommentId,
    // 详情打开时即取首屏，保证尚未展开评论栏时「评论 (N)」也准确。
    enabled: open && mode === 'edit',
  });

  const commentItems = React.useMemo<CommentItem[]>(() => (
    recordComments.comments.map((comment) => ({
      id: comment.id,
      author_name: comment.actor.name,
      author_type: comment.actor.type,
      author_user_id: comment.actor.type === 'human' ? comment.actor.id : null,
      authorization_subject_name: comment.authorization_subject.name,
      agent_run_id: comment.audit?.agent_run_id,
      body: comment.content,
      created_at: comment.created_at,
      mention_user_ids: comment.mentions,
      can_delete: comment.capabilities.can_delete,
      is_deleted: comment.is_deleted,
      thread_id: comment.thread?.id ?? comment.id,
      thread_status: comment.thread?.status ?? 'open',
      can_resolve: comment.thread?.capabilities?.can_resolve ?? true,
      can_reopen: comment.thread?.capabilities?.can_reopen ?? false,
      reply_to: comment.reply_to ? {
        id: comment.reply_to.id,
        author_name: comment.reply_to.author_name,
        body: comment.reply_to.content,
        is_deleted: comment.reply_to.is_deleted,
      } : null,
    }))
  ), [recordComments.comments]);

  const commentMentionCandidates = React.useMemo<CommentMentionCandidate[]>(() => (
    recordComments.mentionCandidates.map((candidate) => ({
      userId: candidate.user_id,
      displayName: candidate.display_name,
      accountName: candidate.account_name,
      avatar: candidate.avatar,
      email: candidate.email,
    }))
  ), [recordComments.mentionCandidates]);

  React.useEffect(() => {
    const subscribe = tableCollab?.collabBridge.collab.onStatelessEvent;
    if (!open || mode !== 'edit' || !record?.id || !subscribe) return undefined;

    return subscribe('table.comment.changed', (payload: unknown) => {
      const event = payload && typeof payload === 'object'
        ? payload as { record_id?: string }
        : {};
      // RLS 表只会收到不含 record_id 的泛化失效消息；此时重新走 REST 权限校验。
      if (!event.record_id || event.record_id === record.id) {
        void recordComments.refresh();
      }
    });
  }, [mode, open, record?.id, recordComments.refresh, tableCollab?.collabBridge.collab.onStatelessEvent]);

  const closeRecordForm = React.useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  React.useEffect(() => {
    if (open) {
      announceTableDrawerOpen('record-form', drawerId);
    }
  }, [drawerId, open]);

  useCloseOnOtherTableDrawerOpen('record-form', drawerId, open, closeRecordForm);

  const MAX_HISTORY_RETRIES = 2;

  React.useLayoutEffect(() => {
    historyRecordId.current = record?.id;
  }, [record?.id]);

  const invalidateInlineHistoryRequests = React.useCallback(() => {
    historyRequestId.current += 1;
    historyRetryCount.current = 0;
    if (historyRetryTimer.current) {
      clearTimeout(historyRetryTimer.current);
      historyRetryTimer.current = null;
    }
  }, []);

  const fetchInlineHistory = React.useCallback(
    async (recordId: string, cursor: string | null = null) => {
      if (recordId !== historyRecordId.current) return;

      const requestId = ++historyRequestId.current;
      if (historyRetryTimer.current) {
        clearTimeout(historyRetryTimer.current);
        historyRetryTimer.current = null;
      }
      const isCurrentRecordRequest = () => (
        requestId === historyRequestId.current && recordId === historyRecordId.current
      );

      setHistoryLoading(true);
      try {
        const result = await UndoRedoApiService.getRecordHistory(recordId, {
          cursor,
          include_undone: true,
          limit: 20,
        });
        if (!isCurrentRecordRequest()) return;

        // HistoryOperationOut 和 HistoryOperation 结构完全一致，安全映射
        const ops = (result.operations ?? result.history_list ?? []) as HistoryOperation[];
        setHistoryOps((prev) => (cursor ? [...prev, ...ops] : ops));
        setHistoryTotal(result.total);
        setHistoryNextCursor(result.next_cursor ?? null);
        historyRetryCount.current = 0; // 成功后重置重试计数
      } catch (error) {
        if (!isCurrentRecordRequest()) return;

        console.error('[RecordFormContainer] fetchInlineHistory failed:', error);

        // 自动重试（最多 MAX_HISTORY_RETRIES 次）
        if (historyRetryCount.current < MAX_HISTORY_RETRIES) {
          historyRetryCount.current += 1;
          const delay = historyRetryCount.current * 1000;
          historyRetryTimer.current = setTimeout(() => {
            historyRetryTimer.current = null;
            if (isCurrentRecordRequest()) {
              void fetchInlineHistory(recordId, cursor);
            }
          }, delay);
        } else {
          // 重试耗尽，向用户展示错误
          toast({
            variant: 'destructive',
            title: t('errors.loadHistoryFailed', '加载历史记录失败'),
            description:
              error instanceof Error ? error.message : t('errors.tryAgainLater', '请稍后重试'),
          });
          historyRetryCount.current = 0;
        }
      } finally {
        if (isCurrentRecordRequest()) {
          setHistoryLoading(false);
        }
      }
    },
    [toast, t],
  );

  const handleHistoryToggle = React.useCallback(() => {
    const next = !historyVisible;
    setHistoryVisible(next);
    if (next) setCommentsVisible(false);
    if (next && record?.id && historyOps.length === 0) {
      void fetchInlineHistory(record.id, null);
    }
  }, [record?.id, historyOps.length, fetchInlineHistory, historyVisible]);

  const handleCommentsToggle = React.useCallback(() => {
    setCommentsVisible((current) => {
      const next = !current;
      if (next) setHistoryVisible(false);
      return next;
    });
  }, []);

  const handleLoadMoreHistory = React.useCallback(() => {
    if (!record?.id || historyLoading || !historyNextCursor) return;
    void fetchInlineHistory(record.id, historyNextCursor);
  }, [record?.id, historyLoading, historyNextCursor, fetchInlineHistory]);

  // Reset history when dialog closes or record changes
  React.useEffect(() => {
    if (!open) {
      invalidateInlineHistoryRequests();
      setHistoryVisible(false);
      setHistoryOps([]);
      setHistoryTotal(0);
      setHistoryNextCursor(null);
      setHistoryLoading(false);
    }
  }, [invalidateInlineHistoryRequests, open]);

  React.useEffect(() => {
    invalidateInlineHistoryRequests();
    setHistoryVisible(false);
    setHistoryOps([]);
    setHistoryTotal(0);
    setHistoryNextCursor(null);
    setHistoryLoading(false);
  }, [invalidateInlineHistoryRequests, record?.id]);

  React.useEffect(() => () => {
    invalidateInlineHistoryRequests();
  }, [invalidateInlineHistoryRequests]);

  React.useEffect(() => {
    const shouldOpenComments = Boolean(
      open && mode === 'edit' && record?.id && initialCommentsOpen,
    );
    setCommentsVisible(shouldOpenComments);
    if (shouldOpenComments) setHistoryVisible(false);
  }, [initialCommentsOpen, mode, open, record?.id]);

  React.useEffect(() => {
    setActiveFocusTarget(null);
  }, [initialFocusTarget, open, record?.id]);

  const handleDrawerOpenComplete = React.useCallback(() => {
    if (open && initialFocusTarget) {
      setActiveFocusTarget(initialFocusTarget);
    }
  }, [initialFocusTarget, open]);

  const fieldNameMap = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const f of fields) {
      map[f.id] = f.name;
    }
    return map;
  }, [fields]);

  const fieldTypeMap = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const f of fields) {
      map[f.id] = f.field_type;
    }
    return map;
  }, [fields]);

  const outOfBandFieldNames = React.useMemo(
    () => fields.filter((f) => isOutOfBandManagedField(f)).map((f) => f.name),
    [fields],
  );

  const fieldDefinitions = React.useMemo(() => {
    const tableId = selectedTable?.id;
    return toFieldDefinitions(fields).map((fieldDefinition, index) => {
      const sourceField = fields[index];
      if (!sourceField || !isSystemParentRecordField(sourceField, tableId)) {
        return fieldDefinition;
      }
      return {
        ...fieldDefinition,
        displayName: t('systemFields.parentRecord.name', 'Parent record'),
        displayDescription: t(
          'systemFields.parentRecord.description',
          'Parent record field for the sub-record hierarchy',
        ),
      };
    });
  }, [fields, selectedTable?.id, t]);

  const organizationMembers = React.useMemo(() => toOrganizationMembers(wsMembers), [wsMembers]);

  // 初始数据（编辑模式），合并 link 字段覆盖值
  const initialData: RecordFormData = React.useMemo(() => {
    let base: RecordFormData = {};
    if (mode === 'edit' && record) {
      base = record.data;
    } else if (mode === 'create' && initialValues) {
      base = initialValues;
    }
    if (Object.keys(linkFieldOverrides).length > 0) {
      return { ...base, ...linkFieldOverrides };
    }
    return base;
  }, [mode, record, initialValues, linkFieldOverrides]);

  React.useEffect(() => {
    if (!open) {
      clearAttachmentTasks();
      setLinkEditorState(null);
      setLinkFieldOverrides({});
      setLinkedRecordDetail(null);
    }
  }, [open, clearAttachmentTasks]);

  const handleOpenLinkedRecord = React.useCallback(
    (payload: {
      fieldId: string;
      foreignTableId: string;
      recordId: string;
      title?: string;
    }) => {
      // 关闭选择器后打开跨表详情（与主字段展开同一套侧栏）
      setLinkEditorState(null);
      setLinkedRecordDetail({
        foreignTableId: payload.foreignTableId,
        recordId: payload.recordId,
        title: payload.title,
      });
    },
    [],
  );

  // ── Link field edit handlers ──
  const handleLinkFieldEdit = React.useCallback(
    (fieldId: string, fieldName: string, currentValue: unknown) => {
      if (isReadonly) return;
      if (!selectedTable) return;

      const field = fields.find((f: Field) => f.id === fieldId);
      if (!field || field.field_type !== 'link') return;

      const options = field.options as Record<string, unknown> | undefined;
      const foreignTableId = String(options?.foreignTableId ?? '');
      if (!foreignTableId) return;

      let items: Array<{ id: string; title?: string }> = [];
      if (Array.isArray(currentValue)) {
        items = currentValue
          .filter((v): v is Record<string, unknown> => v != null && typeof v === 'object')
          .map((v) => ({
            id: String(v.id ?? ''),
            title: v.title ? String(v.title) : undefined,
          }));
      } else if (currentValue && typeof currentValue === 'object' && 'id' in (currentValue as Record<string, unknown>)) {
        const v = currentValue as Record<string, unknown>;
        items = [{ id: String(v.id ?? ''), title: v.title ? String(v.title) : undefined }];
      }

      setLinkEditorState({
        fieldId,
        fieldName,
        fieldConfig: {
          foreignTableId,
          relationship: String(options?.relationship ?? 'ManyMany'),
          lookupFieldId: options?.lookupFieldId ? String(options.lookupFieldId) : undefined,
          isOneWay: Boolean(options?.isOneWay),
        },
        currentValue: items,
      });
    },
    [isReadonly, selectedTable, fields],
  );

  const handleLinkEditorClose = React.useCallback(() => {
    setLinkEditorState(null);
  }, []);

  const handleLinkEditorSave = React.useCallback(
    async (newValue: Array<{ id: string; title?: string }>) => {
      if (isReadonly) return;
      if (!linkEditorState || !selectedTable) return;

      const field = fields.find((f: Field) => f.id === linkEditorState.fieldId);
      if (!field) return;

      const isSingle =
        linkEditorState.fieldConfig.relationship === 'OneOne' ||
        linkEditorState.fieldConfig.relationship === 'ManyOne';

      const cellValue = isSingle
        ? newValue.length > 0
          ? newValue[0]
          : null
        : newValue;

      if (mode === 'edit' && record) {
        if (tableCollab?.isCollabRuntime) {
          // 协作在线：写 Y.Doc（桥接内部完成乐观合并），他端实时可见。
          await tableCollab.updateRecord(record.id, {
            fields: { [field.id]: cellValue },
            fieldKeyType: 'id',
          });
        } else {
          await updateRecord(record.id, {
            fields: { [field.id]: cellValue },
            fieldKeyType: 'id',
          });

          mergeIncrementalRecords(
            [{
              ...record,
              data: { ...(record as any).data, [field.name]: cellValue },
              fields: { ...(record as any).fields, [field.id]: cellValue },
            }],
            (latestVersion ?? 0) + 1,
          );
        }
      }

      setLinkFieldOverrides((prev) => ({
        ...prev,
        [field.name]: cellValue,
      }));
    },
    [isReadonly, linkEditorState, selectedTable, fields, mode, record, updateRecord, mergeIncrementalRecords, records, latestVersion, tableCollab],
  );

  const handleRenderAttachmentField = React.useCallback(
    ({
      field,
      value,
      onChange,
      recordId: currentRecordId,
      disabled,
    }: AttachmentFieldRenderProps) => {
      if (!selectedTable) {
        return null;
      }
      const attachmentValue: AttachmentReference[] = (value ?? []).flatMap((item) => {
        const referenceId = item.reference_id ?? item.file_id ?? item.url;
        if (!referenceId) {
          return [];
        }
        return [{
          reference_id: referenceId,
          file_id: item.file_id ?? referenceId,
          table_id: item.table_id,
          field_id: item.field_id,
          record_id: item.record_id,
          name: item.name ?? item.file_id ?? referenceId,
          url: item.url,
          size: item.size,
          mime_type: item.mime_type,
          thumbnail_url: item.thumbnail_url,
          smThumbnailUrl: item.smThumbnailUrl,
          lgThumbnailUrl: item.lgThumbnailUrl,
          preview_url: item.preview_url,
        }];
      });

      const handleAttachmentChange = (next: AttachmentReference[]) => {
        const normalized = next.map((item) => ({
          reference_id: item.reference_id,
          file_id: item.file_id,
          table_id: item.table_id,
          field_id: item.field_id,
          record_id: item.record_id,
          name: item.name,
          url: item.url,
          size: item.size,
          mime_type: item.mime_type,
          thumbnail_url: item.thumbnail_url,
          smThumbnailUrl: item.smThumbnailUrl,
          lgThumbnailUrl: item.lgThumbnailUrl,
          preview_url: item.preview_url,
        }));

        onChange(normalized);

        if (mode === 'edit' && record && tableCollab?.isCollabRuntime) {
          void tableCollab.updateRecordFields(record.id, { [field.name]: normalized });
          return;
        }

        if (mode === 'edit' && record) {
          const patchedRecord = {
            ...record,
            data: { ...(record as any).data, [field.name]: normalized },
            fields: { ...(record as any).fields, [field.id]: normalized },
          };
          mergeRestoredRecords(
            selectedTable.id,
            [patchedRecord],
            { newVersion: (latestVersion ?? 0) + 1, syncView: true },
          );
        }
      };

      return (
        <AttachmentField
          field={field}
          tableId={selectedTable.id}
          recordId={currentRecordId ?? record?.id}
          value={attachmentValue}
          onChange={handleAttachmentChange}
          disabled={disabled || isReadonly}
          busy={isSubmitting}
        />
      );
    },
    [latestVersion, mergeRestoredRecords, mode, record, selectedTable, tableCollab, isReadonly, isSubmitting],
  );

  // 提交处理
  const handleSubmit = async (data: RecordFormData) => {
    if (!selectedTable) {
      setError(t('errors.noTable'));
      return;
    }
    if (isReadonly) return;

    setIsSubmitting(true);
    try {
      if (mode === 'create') {
        if (tableCollab?.isCollabRuntime) {
          // 协作在线：写 Y.Doc（乐观合并进 record/view store，他端实时可见）。
          await tableCollab.createRecordFields(data);
        } else {
          console.log('🚀 开始创建记录:', data);
          // 构造正确的请求格式
          const createRequest = {
            table_id: selectedTable.id,
            data: data,
          };
          console.log('📦 API 请求体:', createRequest);
          const createdRecord = await createRecord(createRequest);
          console.log('✅ 记录创建成功:', createdRecord);
          if (currentViewId) {
            try {
              await refreshCurrentView();
            } catch (refreshError) {
              console.error('❌ 刷新视图数据失败:', refreshError);
            }
          }
        }
      } else if (mode === 'edit' && record) {
        // 仅提交用户实际改动的字段：formData 携带整条记录（含自动编号、创建时间
        // 等系统托管字段），整条回传会被后端 bulk_update 因系统字段而整条拒绝。
        // 带外管理字段（附件 / 多媒体）不参与脏字段 diff：它们经各自 API 即时落库、
        // 打开对话框时懒加载回填 formData，基线 record.data 永远没有它们，参与 diff 会
        // 被恒判改动并整条回传附件载荷，反而触发后端整条拒绝（详见 computeChangedRecordData）。
        const changed = computeChangedRecordData(data, initialData, {
          ignoreKeys: outOfBandFieldNames,
        });
        if (Object.keys(changed).length === 0) {
          if (!saveOnExit) {
            onOpenChange(false);
          }
          return;
        }
        if (tableCollab?.isCollabRuntime) {
          // 协作在线：按字段名写 Y.Doc（内部转 fieldId），他端实时可见。
          await tableCollab.updateRecordFields(record.id, changed);
        } else {
          await updateRecord(record.id, { data: changed });
          if (currentViewId) {
            try {
              await refreshCurrentView();
            } catch (refreshError) {
              console.error('❌ 刷新视图数据失败:', refreshError);
            }
          }
        }
      }
      if (!saveOnExit) {
        onOpenChange(false);
      }
    } catch (error) {
      console.error('❌ 提交记录失败:', error);
      toast({
        variant: 'destructive',
        title: t('errors.submitFailed', '提交失败'),
        description: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!selectedTable) {
    return null;
  }

  return (<>
    <RecordFormDialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenComplete={handleDrawerOpenComplete}
      fields={fieldDefinitions}
      initialData={initialData}
      mode={mode}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      isReadonly={isReadonly}
      saveOnExit={saveOnExit}
      title={
        mode === 'create'
          ? t('dialog.createTitle', { name: selectedTable.name })
          : t('dialog.editTitle')
      }
      description={
        mode === 'create'
          ? t('dialog.createDescription')
          : t('dialog.editDescription')
      }
      tableId={selectedTable.id}
      recordId={record?.id}
      renderAttachmentField={handleRenderAttachmentField}
      canNavigatePrev={canNavigatePrev}
      canNavigateNext={canNavigateNext}
      onNavigatePrev={onNavigatePrev}
      onNavigateNext={onNavigateNext}
      onViewHistory={
        mode === 'edit' && record && onViewHistory
          ? () => {
              const primaryField = fields.find((f: Field) => f.is_primary);
              const label = primaryField
                ? String(record.data?.[primaryField.name] ?? record.id)
                : String(record.id);
              onViewHistory(record.id, label);
            }
          : undefined
      }
      historyVisible={historyVisible}
      onHistoryToggle={mode === 'edit' && record ? handleHistoryToggle : undefined}
      headerActions={
        mode === 'edit' && record ? (
          <Button
            type="button"
            variant={commentsVisible ? 'secondary' : 'ghost'}
            size="sm"
            className="shrink-0 gap-1.5 text-muted-foreground hover:text-foreground"
            onClick={handleCommentsToggle}
            aria-pressed={commentsVisible}
            aria-label={t('comments.toggle', '打开评论')}
          >
            <MessageSquare className="h-4 w-4" />
            <span className="hidden sm:inline text-body">
              {recordComments.openThreadTotal > 0
                ? `${t('comments.title', '评论')} (${recordComments.openThreadTotal})`
                : t('comments.title', '评论')}
            </span>
          </Button>
        ) : null
      }
      secondaryPanelOpen={commentsVisible}
      secondaryPanel={
        mode === 'edit' && record ? (
          <CommentsSection
            layout="side-panel"
            autoFocus={activeFocusTarget === RecordFormFocusTarget.CommentInput}
            highlightedCommentId={targetCommentId}
            comments={commentItems}
            total={recordComments.threadTotal}
            statusFilter={recordComments.statusFilter}
            onStatusFilterChange={recordComments.setStatusFilter}
            updatingThreadIds={recordComments.updatingThreadIds}
            onResolveThread={recordComments.resolveThread}
            onReopenThread={recordComments.reopenThread}
            value={recordComments.draft}
            onValueChange={recordComments.setDraft}
            onSubmit={async (mentionUserIds, replyToCommentId) => {
              await recordComments.submit(mentionUserIds, replyToCommentId)
            }}
            mentionCandidates={commentMentionCandidates}
            onMentionSearch={recordComments.searchMentionCandidates}
            currentUserId={currentUserId}
            deletingCommentIds={recordComments.deletingCommentIds}
            onDeleteComment={recordComments.deleteComment}
            onRetry={async () => {
              await recordComments.retry()
            }}
            isLoading={recordComments.loading}
            isSubmitting={recordComments.submitting}
            error={recordComments.error}
            hasMore={recordComments.hasMore}
            isLoadingMore={recordComments.loadingMore}
            onLoadMore={recordComments.loadMore}
            labels={{
              title: t('comments.title', '评论'),
              placeholder: t('comments.placeholder', '添加评论，输入 @ 提及成员'),
              submit: t('comments.submit', '发送评论'),
              deleteComment: t('comments.delete', '删除'),
              deletingComment: t('comments.deleting', '正在删除...'),
              retry: t('comments.retry', '重试'),
              loading: t('comments.loading', '正在加载评论...'),
              noMentionResults: t('comments.noMentionResults', '没有匹配的成员'),
              loadMore: t('comments.loadMore', '加载更早评论'),
              loadingMore: t('comments.loadingMore', '正在加载...'),
              reply: t('comments.reply', '回复'),
              replyingTo: t('comments.replyingTo', '回复'),
              cancelReply: t('comments.cancelReply', '取消回复'),
              deletedComment: t('comments.deletedComment', '原评论已删除'),
              filterOpen: t('comments.filterOpen', '未解决'),
              filterResolved: t('comments.filterResolved', '已解决'),
              filterAll: t('comments.filterAll', '全部'),
              resolveThread: t('comments.resolveThread', '标记已解决'),
              reopenThread: t('comments.reopenThread', '重新打开'),
              updatingThread: t('comments.updatingThread', '正在更新...'),
              empty: t('comments.empty', '暂无评论'),
              countUnit: t('comments.countUnit', '条线程'),
            }}
          />
        ) : null
      }
      organizationMembers={organizationMembers}
      currentUserId={currentUserId}
      onLinkFieldEdit={mode === 'edit' && record && !isReadonly ? handleLinkFieldEdit : undefined}
      onOpenLinkedRecord={mode === 'edit' && record ? handleOpenLinkedRecord : undefined}
      historyPanel={
        historyVisible ? (
          <RecordHistoryPanel
            operations={historyOps}
            total={historyTotal}
            loading={historyLoading}
            onLoadMore={handleLoadMoreHistory}
            fieldNameMap={fieldNameMap}
            fieldTypeMap={fieldTypeMap}
          />
        ) : null
      }
    />
    {linkEditorState && selectedTable && record && (
      <LinkCellEditor
        open
        onClose={handleLinkEditorClose}
        tableId={selectedTable.id}
        recordId={record.id}
        fieldId={linkEditorState.fieldId}
        fieldConfig={linkEditorState.fieldConfig}
        currentValue={linkEditorState.currentValue}
        onSave={handleLinkEditorSave}
        onOpenLinkedRecord={(payload) => {
          setLinkEditorState(null);
          setLinkedRecordDetail(payload);
        }}
      />
    )}
    {linkedRecordDetail && (
      <LinkedRecordFormHost
        open
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setLinkedRecordDetail(null);
        }}
        foreignTableId={linkedRecordDetail.foreignTableId}
        recordId={linkedRecordDetail.recordId}
        titleHint={linkedRecordDetail.title}
        // 关联入口只查看目标记录，不跨表编辑
        isReadonly
        coordinateDrawers={false}
      />
    )}
  </>
  );
};
