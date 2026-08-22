import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  ArrowLeft,
  Ban,
  Bot,
  CalendarDays,
  Check,
  CheckCircle2,
  CheckSquare2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  ExternalLink,
  FileText,
  History,
  ImagePlus,
  Loader2,
  MessageSquare,
  Paperclip,
  PackageOpen,
  Play,
  Plus,
  UserRound,
  RefreshCw,
  X,
} from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Textarea,
  toast,
} from '@components/ui';
import type {
  OrganizationMember,
  Space,
  WorkspaceSummary,
} from '@tabtin/app-shell';
import { WorkspaceApiService } from '@tabtin/app-shell';
import { useAuthStore } from '@stores/useAuthStore';
import { ProjectApiService } from '@/services/projectApi';
import { openProjectTaskChatSession } from '@/services/openProjectTaskChatSession';
import { MemberApiService } from '@/services/memberApi';
import { SpaceAccessApiService } from '@/services/spaceAccessApi';
import { useChatStore } from '@stores/chat/useChatStore';
import { rememberProjectTaskRunStatus } from '@/stores/chat/messages/product/delivery/projectTaskSendGate';
import { useProjectTaskRealtime } from '@/hooks/useProjectTaskRealtime';
import { useProjectTaskStore } from '@/stores/useProjectTaskStore';
import { useUIStore } from '@stores/useUIStore';
import { useProjectWorkspaceSelectionStore } from '../projectWorkspaceSelectionStore';
import {
  readProjectOrchestrationCollapsed,
  writeProjectOrchestrationCollapsed,
} from './projectOrchestrationPreference';
import { createLogger } from '@/utils/logger';
import { useCloudDocumentPreviewStore } from '@/components/chat/preview/useCloudDocumentPreviewStore';
import { InlineDocPreview } from '@/components/context-space/tabdoc/InlineDocPreview';
import { MarkdownRenderer } from '@/components/chat/markdown/MarkdownRenderer';
import type { ChatAttachment } from '@/components/chat/types';
import { formatFileSize } from '@/components/chat/types';
import { useComposerAttachmentUploads } from '@/components/chat/composer/useComposerAttachmentUploads';
import { isImageMime, validateUploadFile } from '@/constants/upload';
import type {
  Project,
  ProjectTask,
  ProjectTaskConversation,
  ProjectTaskPriority,
  ProjectTaskResultItem,
  ProjectTaskRun,
} from '@/types/project';
import type { OrganizationAgent, SpaceMembership } from '@/types/space-access';
import { cn } from '@utils/cn';
import {
  CANVAS_TEXT_EYEBROW,
  CANVAS_TEXT_META,
  CANVAS_TEXT_MICRO,
  CANVAS_TEXT_SECONDARY,
  CANVAS_TEXT_SECTION_LABEL,
} from '../canvasUi';

const log = createLogger('projectTasks');

const PRIORITY_LABEL: Record<ProjectTaskPriority, string> = {
  low: '低',
  medium: '中',
  high: '高',
  urgent: '紧急',
};

const STATUS_LABEL: Record<ProjectTask['work_status'], string> = {
  todo: '待执行',
  in_progress: '执行中',
  // 存量 in_review：产品上已并入过程态，不再单独叫「待验收」。
  in_review: '执行中',
  blocked: '受阻',
  done: '已完成',
  cancelled: '已取消',
};

const RUN_STATUS_LABEL: Record<
  NonNullable<ProjectTask['latest_run']>['status'],
  string
> = {
  preparing: '准备中',
  pending: '等待执行',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const CONVERSATION_KIND_LABEL: Record<ProjectTaskConversation['kind'], string> =
  {
    preparation: '准备会话',
    execution: '执行会话',
  };

const EVENT_LABEL: Record<string, string> = {
  created: '创建了任务',
  assignment_accepted: '接受了任务',
  assignment_rejected: '拒绝了任务',
  execution_configured: '确认了工作空间与 Agent',
  run_prepared: '准备了执行会话',
  run_started: '启动了 Agent 执行',
  run_completed: '完成了 Agent 执行',
  run_failed: '未能完成 Agent 执行',
  run_results_refreshed: '更新了执行结果',
  task_cancelled: '取消了任务',
  result_accepted: '完成并发布了执行结果',
  result_visibility_changed: '调整了结果预览可见性',
};

const readEventText = (
  payload: Record<string, unknown>,
  key: string,
): string => {
  const value = payload[key];
  return typeof value === 'string' ? value.trim() : '';
};

const formatTaskEventDetails = (
  event: NonNullable<ProjectTask['events']>[number],
  task: ProjectTask,
): string[] => {
  const payload = event.payload || {};
  const details: string[] = [];

  if (event.event_type === 'created') {
    const title = readEventText(payload, 'title') || task.title;
    const responsibleName =
      readEventText(payload, 'responsible_user_name') ||
      task.responsible_user.name;
    const priorityKey = (readEventText(payload, 'priority') ||
      task.priority) as ProjectTaskPriority;
    const priority = PRIORITY_LABEL[priorityKey] || priorityKey;
    const description =
      readEventText(payload, 'description') || task.description;
    const selfAssigned =
      payload.self_assigned === true ||
      String(task.created_by.id) === String(task.responsible_user.id);
    const assignmentStatus =
      readEventText(payload, 'assignment_status') || task.assignment_status;

    if (title) details.push(`标题：${title}`);
    if (responsibleName) {
      details.push(
        selfAssigned
          ? `指派给 ${responsibleName}（自己接受）`
          : `指派给 ${responsibleName}${assignmentStatus === 'pending' ? '（待确认）' : ''}`,
      );
    }
    if (priority) details.push(`优先级：${priority}`);
    if (description) details.push(`说明：${description}`);
    return details;
  }

  if (event.event_type === 'execution_configured') {
    const agentName =
      readEventText(payload, 'agent_name') || task.selected_agent?.name || '';
    const workspaceName =
      readEventText(payload, 'workspace_name') ||
      task.project_workspace?.name ||
      '';
    if (agentName) details.push(`Agent：${agentName}`);
    if (workspaceName) details.push(`工作空间：${workspaceName}`);
    return details;
  }

  if (
    event.event_type === 'run_started' ||
    event.event_type === 'run_prepared'
  ) {
    const runId = readEventText(payload, 'run_id');
    if (runId) details.push(`执行记录：${runId.slice(0, 8)}`);
    return details;
  }

  if (event.event_type === 'result_accepted') {
    const summary = task.result_summary?.trim();
    const deliverableCount = task.deliverables?.length ?? 0;
    if (summary) details.push(`结论：${summary}`);
    if (deliverableCount > 0) details.push(`发布交付物 ${deliverableCount} 项`);
    return details;
  }

  if (event.event_type === 'result_visibility_changed') {
    const visibility =
      readEventText(payload, 'result_visibility') ||
      readEventText(payload, 'to') ||
      task.result_visibility;
    if (visibility === 'project_preview') {
      details.push('已先给大家看结果摘要与候选产物（放开≠完成）');
    } else if (visibility === 'private') {
      details.push('已收回预览，结果仅责任人可见');
    }
    return details;
  }

  return details;
};

/** 动态事件关联的执行会话；优先按 run_id 在 conversations 里找，旧事件回退 latest_run。 */
const resolveTaskEventSessionId = (
  event: NonNullable<ProjectTask['events']>[number],
  task: ProjectTask,
): string => {
  const fromPayload = readEventText(event.payload || {}, 'chat_session_id');
  if (fromPayload) return fromPayload;
  if (event.event_type !== 'run_started' && event.event_type !== 'run_prepared')
    return '';
  const runId = readEventText(event.payload || {}, 'run_id');
  if (runId && task.conversations?.length) {
    const matched = task.conversations.find((item) => item.run_id === runId);
    if (matched?.session_id) return matched.session_id;
  }
  if (runId && task.latest_run?.id && runId !== task.latest_run.id) return '';
  return task.latest_run?.chat_session_id || '';
};

function taskConversations(
  task: ProjectTask | null,
): ProjectTaskConversation[] {
  if (!task) return [];
  if (task.conversations?.length) return task.conversations;
  const run = task.latest_run;
  if (!run) return [];
  return [
    {
      session_id: run.chat_session_id,
      run_id: run.id,
      kind: run.status === 'preparing' ? 'preparation' : 'execution',
      run_status: run.status,
      rerun_of_id: run.rerun_of_id,
      title: '执行',
      is_active:
        run.status === 'preparing' ||
        run.status === 'pending' ||
        run.status === 'running',
      created_at: run.created_at,
    },
  ];
}

const formatTaskDate = (value: string | null | undefined, locale: string) => {
  if (!value) return '—';
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
};

type TaskLaneId = 'backlog' | 'active' | 'closed' | 'cancelled';

interface TaskLane {
  id: TaskLaneId;
  title: string;
  description: string;
  dotClassName: string;
  statuses: ProjectTask['work_status'][];
}

const TASK_LANES: TaskLane[] = [
  {
    id: 'backlog',
    title: '待处理',
    description: '等待确认或配置工作空间与 Agent',
    dotClassName: 'bg-muted-foreground/60',
    statuses: ['todo'],
  },
  {
    id: 'active',
    title: '执行中',
    description: '过程中可改稿、预览；受阻与存量待验收任务也在这里',
    dotClassName: 'bg-primary',
    // in_review：兼容存量；新路径成功结束后保持 in_progress。
    statuses: ['in_progress', 'in_review', 'blocked'],
  },
  {
    id: 'closed',
    title: '已完成',
    description: '责任人确认完成后进入团队交付',
    dotClassName: 'bg-success',
    statuses: ['done'],
  },
  {
    id: 'cancelled',
    title: '已取消',
    description: '已终止且不再继续执行',
    dotClassName: 'bg-muted-foreground/60',
    statuses: ['cancelled'],
  },
];

function getTaskLaneId(status: ProjectTask['work_status']): TaskLaneId {
  return (
    TASK_LANES.find((lane) => lane.statuses.includes(status))?.id ?? 'backlog'
  );
}

function memberName(member: OrganizationMember): string {
  return (
    member.user?.nickname ||
    member.user?.username ||
    member.user?.email ||
    member.user_id
  );
}

function taskCompletedRun(task: ProjectTask | null): ProjectTaskRun | null {
  if (!task) return null;
  if (task.latest_completed_run) return task.latest_completed_run;
  return task.latest_run?.status === 'completed' ? task.latest_run : null;
}

function taskDetailAssets(task: ProjectTask | null): ProjectTaskResultItem[] {
  if (!task) return [];
  if (task.work_status !== 'done') {
    return (
      taskCompletedRun(task)?.result_items ??
      task.latest_run?.result_items ??
      []
    );
  }
  return task.deliverables
    .filter((item) => item.item_type !== 'team_asset' && item.resource_id)
    .map((item) => ({
      id: item.context_item_id,
      context_item_id: item.context_item_id,
      resource_type: item.item_type,
      resource_id: item.resource_id,
      item_type: item.item_type,
      title: item.title,
      preview: item.preview,
    }));
}

function taskResultSpaceId(
  task: ProjectTask | null,
  projectId: string,
): string {
  if (!task || task.work_status === 'done') return projectId;
  const resourceSpaceId = task.latest_run?.result_items.find(
    (item) => item.resource_space_id,
  )?.resource_space_id;
  return resourceSpaceId || task.project_workspace?.id || projectId;
}

function canCancelTask(task: ProjectTask, currentUserId: string): boolean {
  return (
    task.responsible_user.id === currentUserId &&
    task.work_status !== 'done' &&
    task.work_status !== 'cancelled'
  );
}

export const ProjectTasksPane: React.FC<{ project: Space }> = ({ project }) => {
  const { t, i18n } = useTranslation('project');
  const currentUserId = String(useAuthStore((state) => state.user?.id) ?? '');
  useProjectTaskRealtime(project.id);
  const tasks = useProjectTaskStore(
    (state) => state.byProjectId[project.id]?.tasks ?? [],
  );
  const tasksLoading = useProjectTaskStore((state) =>
    Boolean(state.byProjectId[project.id]?.tasksLoading),
  );
  const tasksError = useProjectTaskStore(
    (state) => state.byProjectId[project.id]?.tasksError ?? '',
  );
  const fetchTasks = useProjectTaskStore((state) => state.fetchTasks);
  const [memberships, setMemberships] = useState<SpaceMembership[]>([]);
  const [organizationMembers, setOrganizationMembers] = useState<
    OrganizationMember[]
  >([]);
  const [agents, setAgents] = useState<OrganizationAgent[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [projectDetail, setProjectDetail] = useState<Project | null>(null);
  const [metaLoading, setMetaLoading] = useState(true);
  const [orchestrationOpening, setOrchestrationOpening] = useState(false);
  const [orchestrationCollapsed, setOrchestrationCollapsed] = useState(() =>
    readProjectOrchestrationCollapsed(currentUserId),
  );
  const [actionKey, setActionKey] = useState('');
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<ProjectTaskPriority>('medium');
  const [responsibleUserId, setResponsibleUserId] = useState(currentUserId);
  const [selectedAgentByTask, setSelectedAgentByTask] = useState<
    Record<string, string>
  >({});
  const [selectedWorkspaceByTask, setSelectedWorkspaceByTask] = useState<
    Record<string, string>
  >({});
  const [reviewTask, setReviewTask] = useState<ProjectTask | null>(null);
  const [taskPendingCancellation, setTaskPendingCancellation] =
    useState<ProjectTask | null>(null);
  const [detailTask, setDetailTask] = useState<ProjectTask | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [expandedResultDocId, setExpandedResultDocId] = useState<string | null>(
    null,
  );
  const [commentDraft, setCommentDraft] = useState('');
  const detailRequestIdRef = useRef(0);
  const loadRequestIdRef = useRef(0);
  const actionInFlightRef = useRef(false);
  const [reviewSummary, setReviewSummary] = useState('');
  const [deliverableTitle, setDeliverableTitle] = useState('');
  const [selectedResultItemIds, setSelectedResultItemIds] = useState<string[]>(
    [],
  );
  const [kickoffMessageByTask, setKickoffMessageByTask] = useState<
    Record<string, string>
  >({});
  const [kickoffAttachments, setKickoffAttachments] = useState<
    ChatAttachment[]
  >([]);
  const kickoffImageInputRef = useRef<HTMLInputElement>(null);
  const kickoffFileInputRef = useRef<HTMLInputElement>(null);
  const {
    attachmentsUploading: kickoffAttachmentsUploading,
    cancelUpload: cancelKickoffUpload,
  } = useComposerAttachmentUploads(kickoffAttachments, setKickoffAttachments);

  const isLoading = metaLoading || (tasksLoading && tasks.length === 0);
  const displayError = error || tasksError;

  useEffect(() => {
    setOrchestrationCollapsed(readProjectOrchestrationCollapsed(currentUserId));
  }, [currentUserId]);

  const resetCreateDraft = useCallback(() => {
    setTitle('');
    setDescription('');
    setPriority('medium');
    setResponsibleUserId(currentUserId);
  }, [currentUserId]);

  const loadData = useCallback(
    async (quiet = false) => {
      const requestId = ++loadRequestIdRef.current;
      if (!quiet) setMetaLoading(true);
      setError('');
      try {
        const [
          ,
          membershipResult,
          memberResult,
          agentResult,
          detail,
          workspaceResult,
        ] = await Promise.all([
          fetchTasks(project.id, { quiet }),
          SpaceAccessApiService.listSpaceMemberships(project.id),
          MemberApiService.getMembers(project.organization_id, { limit: 200 }),
          SpaceAccessApiService.listOrganizationAgents(
            project.organization_id,
            { pageSize: 200 },
          ),
          ProjectApiService.getProject(project.id),
          WorkspaceApiService.list(project.organization_id).catch(
            () => [] as WorkspaceSummary[],
          ),
        ]);
        if (loadRequestIdRef.current !== requestId) return;
        setMemberships(membershipResult.memberships);
        setOrganizationMembers(memberResult.members);
        setAgents(agentResult.agents);
        setProjectDetail(detail);
        setWorkspaces(workspaceResult);
      } catch (cause) {
        if (loadRequestIdRef.current !== requestId) return;
        log.error('load failed', { projectId: project.id, cause });
        setError(cause instanceof Error ? cause.message : '项目任务加载失败');
      } finally {
        if (loadRequestIdRef.current === requestId) setMetaLoading(false);
      }
    },
    [fetchTasks, project.id, project.organization_id],
  );

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const hasActiveRun = tasks.some(
    (task) =>
      task.latest_run?.status === 'preparing' ||
      task.latest_run?.status === 'pending' ||
      task.latest_run?.status === 'running',
  );
  useEffect(() => {
    if (!hasActiveRun) return;
    const timer = window.setInterval(() => {
      void fetchTasks(project.id, { quiet: true });
    }, 4000);
    return () => window.clearInterval(timer);
  }, [fetchTasks, hasActiveRun, project.id]);

  const activeUserIds = useMemo(
    () =>
      new Set(
        memberships
          .filter((item) => item.is_active && item.user_id)
          .map((item) => item.user_id as string),
      ),
    [memberships],
  );
  const responsibleOptions = useMemo(
    () =>
      organizationMembers.filter((member) => activeUserIds.has(member.user_id)),
    [activeUserIds, organizationMembers],
  );
  // 终态：不再要求 Agent 先加入 Project；责任人可选自己拥有的任意活跃非 human Agent。
  const availableAgents = useMemo(
    () => agents.filter((agent) => agent.is_active && agent.type !== 'human'),
    [agents],
  );
  /** 责任人可选的执行工作空间：组织内自己可见的现场；默认伴生优先。 */
  const availableWorkspaces = useMemo(() => {
    const companionId = projectDetail?.my_workspace?.id;
    if (!companionId) return workspaces;
    const companion = workspaces.find((item) => item.id === companionId);
    const rest = workspaces.filter((item) => item.id !== companionId);
    if (companion) return [companion, ...rest];
    if (projectDetail?.my_workspace) {
      return [
        {
          id: projectDetail.my_workspace.id,
          organization_id:
            projectDetail.my_workspace.organization_id ||
            project.organization_id,
          name: projectDetail.my_workspace.name,
          working_dir: projectDetail.my_workspace.working_dir,
          device_online:
            projectDetail.my_workspace.control_device_status === 'online',
          is_home: false,
          trust_status: 'untrusted' as const,
          approval_grant: 'always_ask' as const,
          approval_memo_generation: 0,
        },
        ...workspaces,
      ];
    }
    return workspaces;
  }, [project.organization_id, projectDetail?.my_workspace, workspaces]);
  const tasksByLane = useMemo(() => {
    const grouped: Record<TaskLaneId, ProjectTask[]> = {
      backlog: [],
      active: [],
      closed: [],
      cancelled: [],
    };
    tasks.forEach((task) =>
      grouped[getTaskLaneId(task.work_status)].push(task),
    );
    return grouped;
  }, [tasks]);
  const detailAssets = useMemo(
    () => taskDetailAssets(detailTask),
    [detailTask],
  );
  const detailTabdocAssets = useMemo(
    () =>
      detailAssets.filter(
        (item) =>
          (item.resource_type === 'tabdoc' || item.item_type === 'tabdoc') &&
          item.resource_id,
      ),
    [detailAssets],
  );
  const detailOtherAssets = useMemo(
    () =>
      detailAssets.filter(
        (item) =>
          !(
            (item.resource_type === 'tabdoc' || item.item_type === 'tabdoc') &&
            item.resource_id
          ),
      ),
    [detailAssets],
  );
  const activeResultDoc = useMemo(() => {
    if (detailTabdocAssets.length === 0) return null;
    return (
      detailTabdocAssets.find((item) => item.id === expandedResultDocId) ??
      detailTabdocAssets[0]
    );
  }, [detailTabdocAssets, expandedResultDocId]);
  const detailCompletedRun =
    detailTask?.latest_completed_run ??
    (detailTask?.latest_run?.status === 'completed'
      ? detailTask.latest_run
      : null);
  const detailSummary =
    detailTask?.work_status === 'done'
      ? detailTask.result_summary
      : detailCompletedRun?.result_summary ||
        detailTask?.latest_run?.result_summary ||
        '';
  const detailResultSpaceId = taskResultSpaceId(detailTask, project.id);
  const detailIsMine = detailTask?.responsible_user.id === currentUserId;
  const detailIsBusy = Boolean(detailTask && (detailLoading || actionKey));
  const detailCanConfigure = Boolean(
    detailTask &&
    detailIsMine &&
    detailTask.assignment_status === 'accepted' &&
    detailTask.work_status === 'todo' &&
    !detailTask.execution_ready,
  );
  const detailInProcess = Boolean(
    detailTask &&
    (detailTask.work_status === 'todo' ||
      detailTask.work_status === 'blocked' ||
      detailTask.work_status === 'in_progress' ||
      detailTask.work_status === 'in_review'),
  );
  const detailCanKickoff = Boolean(
    detailIsMine &&
    detailTask?.execution_ready &&
    detailInProcess &&
    detailTask.latest_run?.status !== 'pending' &&
    detailTask.latest_run?.status !== 'running',
  );
  const detailConversations = useMemo(
    () => taskConversations(detailTask),
    [detailTask],
  );
  const detailHasOpenableConversation = detailConversations.some(
    (item) => item.session_id,
  );
  const detailHasActiveConversation = detailConversations.some(
    (item) => item.is_active,
  );
  const detailRunBusy = Boolean(
    detailTask?.latest_run?.status === 'pending' ||
    detailTask?.latest_run?.status === 'running',
  );
  /** 新开对话走 prepareTaskRun；活跃执行中禁用（唯一活跃 Run 约束）。 */
  const detailCanStartConversation = Boolean(
    detailIsMine &&
    detailTask?.execution_ready &&
    detailInProcess &&
    !detailHasActiveConversation &&
    !detailRunBusy,
  );
  const detailHasActiveRun = Boolean(
    detailTask?.latest_run?.status === 'preparing' ||
    detailTask?.latest_run?.status === 'pending' ||
    detailTask?.latest_run?.status === 'running',
  );
  const detailCanComplete = Boolean(
    detailIsMine &&
    detailTask &&
    (detailTask.work_status === 'in_progress' ||
      detailTask.work_status === 'in_review') &&
    detailCompletedRun &&
    !detailHasActiveRun &&
    (Boolean(detailCompletedRun.result_summary?.trim()) ||
      (detailCompletedRun.result_items?.length ?? 0) > 0),
  );
  const detailHasActions = Boolean(
    detailTask &&
    ((detailIsMine && detailTask.assignment_status === 'pending') ||
      detailCanConfigure ||
      detailCanKickoff ||
      detailCanComplete ||
      canCancelTask(detailTask, currentUserId) ||
      detailHasOpenableConversation ||
      detailCanStartConversation),
  );

  const runAction = useCallback(
    async (
      key: string,
      action: () => Promise<unknown>,
      successTitle: string,
    ): Promise<boolean> => {
      if (actionInFlightRef.current) return false;
      actionInFlightRef.current = true;
      setActionKey(key);
      setError('');
      log.info('action start', { projectId: project.id, action: key });
      try {
        await action();
        toast({ title: successTitle });
        await loadData(true);
        log.info('action completed', { projectId: project.id, action: key });
        return true;
      } catch (cause) {
        log.error('action failed', {
          projectId: project.id,
          action: key,
          cause,
        });
        const message =
          cause instanceof Error ? cause.message : '操作失败，请重试';
        setError(message);
        toast({
          title: '操作失败',
          description: message,
          variant: 'destructive',
        });
        return false;
      } finally {
        actionInFlightRef.current = false;
        setActionKey('');
      }
    },
    [loadData, project.id],
  );

  const handleCreate = async () => {
    if (!title.trim() || !responsibleUserId) return;
    await runAction(
      'create',
      async () => {
        await ProjectApiService.createTask(project.id, {
          title: title.trim(),
          description: description.trim(),
          priority,
          responsible_user_id: responsibleUserId,
        });
        setCreateOpen(false);
        resetCreateDraft();
      },
      '任务已创建',
    );
  };

  const closeTaskDetail = useCallback(() => {
    detailRequestIdRef.current += 1;
    setDetailTask(null);
    setDetailLoading(false);
    setCommentDraft('');
    setKickoffAttachments([]);
  }, []);

  const openRunSessionById = async (
    sessionId: string,
    options?: {
      keepDetail?: boolean;
      taskId?: string;
      runId?: string | null;
      runStatus?: ProjectTaskRun['status'] | null;
    },
  ) => {
    if (!sessionId) return;
    if (!options?.keepDetail) closeTaskDetail();
    try {
      await openProjectTaskChatSession({
        projectId: project.id,
        organizationId: project.organization_id,
        sessionId,
      });
      // TaskRun 与 Project 编排对话共用 Space；写入执行锚点，避免普通
      // project_tasks / chat 上下文误启用 task-only Skill。
      // run_status 供本机送信门禁 / 隐藏「确认并重新发送」。
      if (options?.taskId) {
        if (options.runStatus) {
          rememberProjectTaskRunStatus(sessionId, options.runStatus);
        }
        await useChatStore.getState().syncContext(
          project.id,
          'project_task',
          {
            project_id: project.id,
            task_id: options.taskId,
            ...(options.runId ? { task_run_id: options.runId } : {}),
            ...(options.runStatus ? { run_status: options.runStatus } : {}),
          },
          [],
          { force: true, targetSessionId: sessionId },
        );
      }
    } catch (cause) {
      log.warn('open run session failed', {
        projectId: project.id,
        taskId: options?.taskId,
        sessionId,
        cause,
      });
      toast({ title: '打开任务执行会话失败', variant: 'destructive' });
    }
  };

  const openRunSession = async (
    task: ProjectTask,
    options?: { keepDetail?: boolean },
  ) => {
    const conversations = taskConversations(task);
    const conversation = conversations.find((item) => item.session_id);
    const sessionId =
      conversation?.session_id || task.latest_run?.chat_session_id;
    if (!sessionId) return;
    await openRunSessionById(sessionId, {
      keepDetail: options?.keepDetail,
      taskId: task.id,
      runId: conversation?.run_id ?? task.latest_run?.id,
      runStatus: conversation?.run_status ?? task.latest_run?.status,
    });
  };

  const focusTaskConversations = () => {
    const section = document.getElementById('task-detail-conversations');
    if (typeof section?.scrollIntoView === 'function') {
      section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const handleOpenLatestOrListConversations = async (task: ProjectTask) => {
    const conversations = taskConversations(task);
    if (conversations.length > 1) {
      focusTaskConversations();
      return;
    }
    const conversation = conversations.find((item) => item.session_id);
    const sessionId = conversation?.session_id;
    if (sessionId) {
      await openRunSessionById(sessionId, {
        keepDetail: true,
        taskId: task.id,
        runId: conversation?.run_id,
        runStatus: conversation?.run_status,
      });
      return;
    }
    focusTaskConversations();
  };

  const handlePrepareConversation = async (task: ProjectTask) => {
    let preparedTask: ProjectTask | null = null;
    const prepared = await runDetailAction(
      task,
      `prepare:${task.id}`,
      async () => {
        preparedTask = await ProjectApiService.prepareTaskRun(
          project.id,
          task.id,
        );
      },
      '已准备新对话',
    );
    if (!prepared) return;
    const conversation = preparedTask
      ? taskConversations(preparedTask).find((item) => item.session_id)
      : null;
    const sessionId = conversation?.session_id;
    if (sessionId) {
      await openRunSessionById(sessionId, {
        keepDetail: true,
        taskId: task.id,
        runId: conversation?.run_id,
        runStatus: conversation?.run_status ?? 'preparing',
      });
    }
  };

  const addKickoffFiles = (
    files: FileList | null,
    preferredType?: 'image' | 'file',
  ) => {
    if (!files?.length) return;
    const next: ChatAttachment[] = [];
    for (const file of Array.from(files)) {
      const asImage = preferredType === 'image' || isImageMime(file.type);
      const validation = validateUploadFile(
        file,
        asImage ? 'IMAGE' : 'ATTACHMENT',
      );
      if (!validation.valid) {
        toast({
          title: '无法添加附件',
          description: validation.reason || file.name,
          variant: 'destructive',
        });
        continue;
      }
      next.push({
        id: `kickoff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        type: asImage ? 'image' : 'file',
        status: 'pending',
        previewUrl: asImage ? URL.createObjectURL(file) : undefined,
      });
    }
    if (next.length > 0)
      setKickoffAttachments((current) => [...current, ...next].slice(0, 20));
  };

  const removeKickoffAttachment = (id: string) => {
    cancelKickoffUpload(id);
    setKickoffAttachments((current) => {
      const target = current.find((item) => item.id === id);
      if (target?.previewUrl?.startsWith('blob:'))
        URL.revokeObjectURL(target.previewUrl);
      return current.filter((item) => item.id !== id);
    });
  };

  const handleStartRun = async (task: ProjectTask) => {
    if (kickoffAttachmentsUploading) {
      toast({ title: '请等待附件上传完成', variant: 'destructive' });
      return;
    }
    if (kickoffAttachments.some((item) => item.status === 'error')) {
      toast({ title: '请先移除上传失败的附件', variant: 'destructive' });
      return;
    }
    const message = (kickoffMessageByTask[task.id] || '').trim();
    const attachments = kickoffAttachments
      .filter(
        (item) => item.status === 'ready' && (item.fileId || item.remoteUrl),
      )
      .map((item) => ({
        type: item.type,
        file_id: item.fileId || '',
        filename: item.filename,
        mime_type: item.mimeType,
        size: item.size,
        url: item.remoteUrl || '',
        preview_url: item.previewUrl || item.remoteUrl || '',
      }));
    let startedTask: ProjectTask | null = null;
    const succeeded = await runAction(
      `run:${task.id}`,
      async () => {
        startedTask = await ProjectApiService.startTaskRun(
          project.id,
          task.id,
          { message, attachments },
        );
      },
      task.work_status === 'blocked' ? '已创建新的执行' : '任务已开始执行',
    );
    setKickoffMessageByTask((current) => {
      if (!(task.id in current)) return current;
      const next = { ...current };
      delete next[task.id];
      return next;
    });
    setKickoffAttachments([]);
    if (!succeeded) return;
    // 开始执行后离开任务详情，直接进入本次执行对话。
    const sessionTask =
      startedTask ??
      (await ProjectApiService.getTask(project.id, task.id).catch(() => null));
    if (sessionTask?.latest_run?.chat_session_id) {
      await openRunSession(sessionTask);
      return;
    }
    closeTaskDetail();
  };

  const openProjectOrchestration = async () => {
    if (orchestrationOpening) return;
    setOrchestrationOpening(true);
    try {
      const chatStore = useChatStore.getState();
      const selectionStore = useProjectWorkspaceSelectionStore.getState();
      const isCurrentProject = () =>
        useProjectWorkspaceSelectionStore.getState().selectedProjectId ===
        project.id;
      let orchestrationSession =
        selectionStore.orchestrationSessionByProjectId[project.id];
      let sessionId = orchestrationSession?.sessionId ?? null;
      if (!sessionId) {
        // Project TaskRun 的执行会话也会成为 Space 当前会话，不能复用它做项目编排。
        // 显式创建一条按 Project 持久复用的专属对话，避免任务上下文互相污染。
        await chatStore.createSession(
          project.id,
          project.organization_id,
          undefined,
          { trigger: 'explicit' },
        );
        const createdSessionId =
          useChatStore.getState().currentSessionIdBySpaceId[project.id] ?? null;
        if (!createdSessionId) {
          throw new Error('未能创建 Project AI 编排对话');
        }
        sessionId = createdSessionId;
        useProjectWorkspaceSelectionStore
          .getState()
          .setOrchestrationSession(project.id, sessionId);
        orchestrationSession = { sessionId, started: false };
      }
      if (!isCurrentProject()) return;
      await chatStore.selectSession(project.id, sessionId);
      if (!isCurrentProject()) return;
      await chatStore.syncContext(
        project.id,
        'project_tasks',
        {
          project_id: project.id,
          orchestration_scope: 'project_tasks',
        },
        [],
        { force: true, targetSessionId: sessionId },
      );
      if (!isCurrentProject()) return;
      useProjectWorkspaceSelectionStore.getState().openTaskSession(sessionId);
      useUIStore.getState().setChatSidePanelCollapsed(false);
      if (!orchestrationSession.started) {
        const projectSelection = useProjectWorkspaceSelectionStore.getState();
        projectSelection.setOrchestrationStarted(project.id, sessionId, true);
        try {
          const projectDescription = project.description?.trim();
          await chatStore.sendMessage(
            [
              `你正在为当前 Project「${project.name}」启动 AI 编排。`,
              projectDescription ? `Project 说明：${projectDescription}` : '',
              '现在只进入需求澄清阶段：不要调用任何 Project 工具，不要拆解任务，也不要创建看板任务。',
              '先用一条简短、自然的回复请用户说明这次想完成的目标；可以提示用户补充期望交付物、时间和关键约束，但不要替用户假设需求。',
              '收到用户进一步输入后，再调用 project_members_list 和 project_tasks_list 了解可分工成员与现有任务，提出有明确产出、依赖关系和责任人的完整方案。',
              '方案必须先交给用户确认；确认后才调用 project_tasks_create 一次性写入看板，不要让用户逐条手工创建。',
            ]
              .filter(Boolean)
              .join('\n'),
            true,
            undefined,
            undefined,
            sessionId,
            {
              source: 'project_orchestration',
              displayMessage: '开始 AI 编排',
            },
          );
          const kickoffAccepted = (
            useChatStore.getState().messagesBySessionId[sessionId] ?? []
          ).some(
            (message) =>
              message.metadata?.source === 'project_orchestration' &&
              (message as { sendStatus?: string }).sendStatus !== 'failed',
          );
          if (!kickoffAccepted) {
            useProjectWorkspaceSelectionStore
              .getState()
              .setOrchestrationStarted(project.id, sessionId, false);
          }
        } catch (cause) {
          useProjectWorkspaceSelectionStore
            .getState()
            .setOrchestrationStarted(project.id, sessionId, false);
          throw cause;
        }
      }
    } catch (cause) {
      log.warn('open project orchestration failed', {
        projectId: project.id,
        cause,
      });
      toast({
        title: 'AI 编排对话打开失败',
        description: cause instanceof Error ? cause.message : '请稍后重试。',
        variant: 'destructive',
      });
    } finally {
      setOrchestrationOpening(false);
    }
  };

  const openTaskDetail = async (task: ProjectTask) => {
    const requestId = ++detailRequestIdRef.current;
    setDetailTask(task);
    setKickoffAttachments([]);
    setDetailLoading(true);
    try {
      const detail = await ProjectApiService.getTask(project.id, task.id);
      if (detailRequestIdRef.current === requestId) setDetailTask(detail);
    } catch (cause) {
      if (detailRequestIdRef.current !== requestId) return;
      log.warn('load task detail failed', {
        projectId: project.id,
        taskId: task.id,
        cause,
      });
      toast({
        title: '任务详情加载不完整',
        description: '已显示看板中的任务信息，可稍后重试。',
        variant: 'destructive',
      });
    } finally {
      if (detailRequestIdRef.current === requestId) setDetailLoading(false);
    }
  };

  const pendingTaskFocus = useProjectWorkspaceSelectionStore(
    (state) => state.pendingTaskFocus,
  );
  useEffect(() => {
    if (!pendingTaskFocus || pendingTaskFocus.projectId !== project.id) return;
    const taskId = useProjectWorkspaceSelectionStore
      .getState()
      .consumePendingTaskFocus(project.id, pendingTaskFocus.requestId);
    if (!taskId) return;
    const task = tasks.find((item) => item.id === taskId);
    void openTaskDetail(
      task ?? ({ id: taskId, project_id: project.id } as ProjectTask),
    );
  }, [pendingTaskFocus, project.id, tasks]);

  const runDetailAction = async (
    task: ProjectTask,
    key: string,
    action: () => Promise<unknown>,
    successTitle: string,
  ): Promise<boolean> => {
    const activeDetailRequestId = detailRequestIdRef.current;
    const succeeded = await runAction(key, action, successTitle);
    if (!succeeded || detailRequestIdRef.current !== activeDetailRequestId)
      return false;
    const requestId = ++detailRequestIdRef.current;
    setDetailLoading(true);
    try {
      const detail = await ProjectApiService.getTask(project.id, task.id);
      if (detailRequestIdRef.current === requestId) setDetailTask(detail);
    } catch (cause) {
      if (detailRequestIdRef.current !== requestId) return false;
      log.warn('refresh task detail after action failed', {
        projectId: project.id,
        taskId: task.id,
        cause,
      });
      toast({
        title: '任务已更新，但详情刷新失败',
        description: '请稍后重新打开任务详情查看最新状态。',
        variant: 'destructive',
      });
    } finally {
      if (detailRequestIdRef.current === requestId) setDetailLoading(false);
    }
    return true;
  };

  const handleAddComment = async () => {
    if (!detailTask || !commentDraft.trim()) return;
    const published = await runDetailAction(
      detailTask,
      `comment:${detailTask.id}`,
      () =>
        ProjectApiService.addTaskComment(
          project.id,
          detailTask.id,
          commentDraft,
        ),
      '评论已发布',
    );
    if (published) setCommentDraft('');
  };

  const handleConfigure = async (task: ProjectTask) => {
    const agentId = selectedAgentByTask[task.id] || availableAgents[0]?.id;
    const workspaceId =
      selectedWorkspaceByTask[task.id] ||
      availableWorkspaces[0]?.id ||
      projectDetail?.my_workspace?.id;
    if (!agentId || !workspaceId) return;
    await runDetailAction(
      task,
      `configure:${task.id}`,
      () =>
        ProjectApiService.configureTaskExecution(project.id, task.id, {
          agent_id: agentId,
          workspace_id: workspaceId,
        }),
      '已确认工作空间与 Agent',
    );
  };

  const resolveResultItemSpaceId = (item: ProjectTaskResultItem): string => {
    // 过程态：资源仍在责任人伴生工作空间；已完成：交付物已进 Project 资产。
    if (item.resource_space_id) return item.resource_space_id;
    if (detailTask?.work_status === 'done') return project.id;
    return detailTask?.project_workspace?.id || project.id;
  };

  const openResultItem = (
    item: ProjectTaskResultItem,
    options?: { openVersionHistory?: boolean },
  ) => {
    // ：完成前候选文档真实归属仍是责任人伴生工作空间（resourceSpaceId），
    // 预览宿主留在当前 Project（不切换 selected Space）。项目成员默认可
    // 只读打开中间产物正文；不 re-home、不等于正式发布。
    const isTabdoc =
      item.resource_type === 'tabdoc' || item.item_type === 'tabdoc';
    if (!isTabdoc) {
      if (options?.openVersionHistory) {
        toast({ title: '该产物暂不支持版本历史' });
        return;
      }
      toast({ title: '请从执行会话查看这个交付物' });
      return;
    }

    useCloudDocumentPreviewStore.getState().open({
      documentId: item.resource_id,
      resourceSpaceId: resolveResultItemSpaceId(item),
      organizationId: project.organization_id,
      title: item.title,
      ...(options?.openVersionHistory ? { openVersionHistory: true } : {}),
    });
  };

  const openReview = (task: ProjectTask) => {
    const completedRun =
      task.latest_completed_run ??
      (task.latest_run?.status === 'completed' ? task.latest_run : null);
    setReviewTask(task);
    setReviewSummary(completedRun?.result_summary || '');
    setDeliverableTitle(`${task.title} · 交付结果`);
    setSelectedResultItemIds(
      (completedRun?.result_items ?? []).map((item) => item.id),
    );
  };

  const handleAcceptResult = async () => {
    if (!reviewTask || !reviewSummary.trim()) return;
    const accepted = await runAction(
      `review:${reviewTask.id}`,
      () =>
        ProjectApiService.acceptTaskResult(project.id, reviewTask.id, {
          result_summary: reviewSummary.trim(),
          deliverable_title: deliverableTitle.trim(),
          result_item_ids: selectedResultItemIds,
        }),
      '任务已完成，结果已进入项目资产',
    );
    if (accepted) {
      setReviewTask(null);
      setSelectedResultItemIds([]);
    }
  };

  const handleCancelTask = async () => {
    if (!taskPendingCancellation) return;
    const cancelled = await runAction(
      `cancel:${taskPendingCancellation.id}`,
      () =>
        ProjectApiService.cancelTask(project.id, taskPendingCancellation.id),
      '任务已取消',
    );
    if (cancelled) {
      if (detailTask?.id === taskPendingCancellation.id) closeTaskDetail();
      setTaskPendingCancellation(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex min-h-56 items-center justify-center text-muted-foreground/60">
        <Loader2
          className="h-5 w-5 animate-spin"
          aria-label={t('loadingTasks')}
        />
      </div>
    );
  }

  return (
    <section
      className="flex flex-col gap-5"
      aria-labelledby="project-tasks-title"
    >
      <header
        className={cn(
          'flex flex-wrap items-start justify-between gap-4',
          detailTask && 'hidden',
        )}
      >
        <div>
          <p className={CANVAS_TEXT_EYEBROW}>{t('tasks')}</p>
          <h2
            id="project-tasks-title"
            className="mt-1 text-title font-semibold text-foreground"
          >
            {t('projectTasks')}
          </h2>
          <p className="mt-1 max-w-2xl text-body leading-relaxed text-muted-foreground">
            先选择指派人，再由指派人确认自己的 Agent 与 Project
            工作空间；责任人确认完成后结果才进入团队资产。
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void loadData()}
            disabled={isLoading}
          >
            <RefreshCw className="mr-2 h-3.5 w-3.5" />
            刷新
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="mr-2 h-3.5 w-3.5" />
            手动新建
          </Button>
        </div>
      </header>

      <section
        className={cn(
          'rounded-[12px] border border-primary/15 bg-primary/[0.04] px-4 py-3',
          detailTask && 'hidden',
        )}
      >
        <button
          type="button"
          className="flex w-full min-w-0 items-center gap-3 rounded-interactive text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          aria-expanded={!orchestrationCollapsed}
          aria-controls={`project-ai-orchestration-${project.id}`}
          onClick={() => {
            const collapsed = !orchestrationCollapsed;
            setOrchestrationCollapsed(collapsed);
            writeProjectOrchestrationCollapsed(currentUserId, collapsed);
          }}
        >
          <span className="inline-grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
            <Bot className="h-4 w-4" aria-hidden />
          </span>
          <h3 className="min-w-0 flex-1 truncate text-body font-medium text-foreground">
            {t('orchestrate')}
          </h3>
          <ChevronDown
            className={cn(
              'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
              !orchestrationCollapsed && 'rotate-180',
            )}
            aria-hidden
          />
        </button>
        {!orchestrationCollapsed && (
          <div
            id={`project-ai-orchestration-${project.id}`}
            className="mt-3 flex flex-col gap-3 border-t border-primary/15 pt-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <p className={cn('max-w-2xl', CANVAS_TEXT_SECONDARY)}>
              描述目标后，AI
              会读取成员和现有任务，先给出拆解与分工方案；你确认后再一次写入看板。
            </p>
            <Button
              type="button"
              size="sm"
              className="shrink-0"
              disabled={orchestrationOpening}
              onClick={() => void openProjectOrchestration()}
            >
              {orchestrationOpening ? (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Bot className="mr-2 h-3.5 w-3.5" />
              )}
              开始 AI 编排
            </Button>
          </div>
        )}
      </section>

      {displayError && !detailTask && (
        <div
          className={cn(
            'flex items-center gap-2 rounded-interactive bg-destructive/10 px-3 py-2 text-destructive',
            CANVAS_TEXT_SECONDARY,
          )}
        >
          <AlertCircle className="h-4 w-4 shrink-0" />
          {displayError}
        </div>
      )}

      {!detailTask &&
        (tasks.length === 0 ? (
          <div className="flex min-h-56 flex-col items-center justify-center rounded-[12px] bg-foreground/[0.03] px-6 py-10 text-center dark:bg-foreground/[0.04]">
            <span className="inline-grid h-10 w-10 place-items-center rounded-full bg-foreground/[0.04] text-muted-foreground/60 dark:bg-foreground/[0.06]">
              <CheckSquare2 className="h-4 w-4" aria-hidden />
            </span>
            <p className="mt-3 text-body font-medium text-foreground">
              {t('empty')}
            </p>
            <p className={cn('mt-1 max-w-lg', CANVAS_TEXT_SECONDARY)}>
              从一项清晰、可验收的工作开始。任务会保留责任、执行与交付来源。
            </p>
            <Button
              type="button"
              size="sm"
              className="mt-4"
              onClick={() => setCreateOpen(true)}
            >
              {t('createFirst')}
            </Button>
          </div>
        ) : (
          <div
            className="-mx-1 overflow-x-auto pb-3"
            data-testid="project-task-board"
          >
            <div className="grid min-w-[52rem] grid-cols-4 gap-3 px-1">
              {TASK_LANES.map((lane) => (
                <section
                  key={lane.id}
                  className="flex min-h-80 min-w-0 flex-col rounded-[12px] bg-foreground/[0.03] p-2.5 dark:bg-foreground/[0.04]"
                  aria-label={`${lane.title}，${tasksByLane[lane.id].length} 项任务`}
                >
                  <header className="flex items-start justify-between gap-2 px-1 py-1">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            'h-2 w-2 shrink-0 rounded-full',
                            lane.dotClassName,
                          )}
                          aria-hidden
                        />
                        <h3 className="text-body font-medium text-foreground">
                          {lane.title}
                        </h3>
                        <span
                          className={cn(
                            CANVAS_TEXT_MICRO,
                            'tabular-nums text-muted-foreground/60',
                          )}
                        >
                          {tasksByLane[lane.id].length}
                        </span>
                      </div>
                      <p
                        className={cn('mt-0.5 truncate pl-4', CANVAS_TEXT_META)}
                      >
                        {lane.description}
                      </p>
                    </div>
                    {lane.id === 'backlog' && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0 rounded-full text-muted-foreground"
                        aria-label="在待处理中新建任务"
                        onClick={() => setCreateOpen(true)}
                      >
                        <Plus className="h-[1em] w-[1em]" />
                      </Button>
                    )}
                  </header>

                  <div className="mt-2 flex flex-1 flex-col gap-2">
                    {tasksByLane[lane.id].length === 0 ? (
                      <div className="flex min-h-28 flex-1 flex-col items-center justify-center rounded-interactive px-4 text-center text-muted-foreground/60">
                        {lane.id === 'closed' && (
                          <CheckCircle2 className="h-4 w-4" aria-hidden />
                        )}
                        {lane.id === 'cancelled' && (
                          <Ban className="h-4 w-4" aria-hidden />
                        )}
                        {lane.id !== 'closed' && lane.id !== 'cancelled' && (
                          <CircleDashed className="h-4 w-4" aria-hidden />
                        )}
                        <p className={cn('mt-2', CANVAS_TEXT_META)}>
                          {t('emptyColumn')}
                        </p>
                      </div>
                    ) : (
                      tasksByLane[lane.id].map((task) => {
                        const run = task.latest_run;
                        return (
                          <article
                            key={task.id}
                            className="group rounded-[12px] bg-background/90 p-3 transition-colors hover:bg-background dark:bg-background/80 dark:hover:bg-background"
                          >
                            <button
                              type="button"
                              className="-m-1 block w-[calc(100%+0.5rem)] rounded-interactive p-1 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/40"
                              aria-label={`查看任务详情：${task.title}`}
                              onClick={() => void openTaskDetail(task)}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span
                                  className={cn(
                                    CANVAS_TEXT_MICRO,
                                    'font-medium',
                                    task.priority === 'urgent' ||
                                      task.priority === 'high'
                                      ? 'text-destructive'
                                      : 'text-muted-foreground/60',
                                  )}
                                >
                                  {PRIORITY_LABEL[task.priority]}优先级
                                </span>
                                {(task.work_status === 'blocked' ||
                                  task.work_status === 'cancelled') && (
                                  <span
                                    className={cn(
                                      CANVAS_TEXT_MICRO,
                                      'rounded-full px-1.5 py-0.5',
                                      task.work_status === 'blocked'
                                        ? 'bg-destructive/10 text-destructive'
                                        : 'bg-foreground/[0.05] text-muted-foreground/60',
                                    )}
                                  >
                                    {STATUS_LABEL[task.work_status]}
                                  </span>
                                )}
                              </div>
                              <h4 className="mt-1 line-clamp-2 text-body font-medium leading-snug text-foreground">
                                {task.title}
                              </h4>
                              {task.description && (
                                <p
                                  className={cn(
                                    'mt-1 line-clamp-1',
                                    CANVAS_TEXT_SECONDARY,
                                  )}
                                >
                                  {task.description}
                                </p>
                              )}

                              <div className="mt-2 flex min-w-0 items-center gap-1.5">
                                <span
                                  className={cn(
                                    'inline-grid h-5 w-5 shrink-0 place-items-center rounded-full bg-foreground/[0.05] font-medium text-foreground/80',
                                    CANVAS_TEXT_MICRO,
                                  )}
                                >
                                  {task.responsible_user.name
                                    .trim()
                                    .charAt(0) || '人'}
                                </span>
                                <p
                                  className={cn(
                                    'min-w-0 truncate text-foreground/80',
                                    CANVAS_TEXT_META,
                                  )}
                                >
                                  <span className="text-muted-foreground/60">
                                    {task.assignment_status === 'pending'
                                      ? '待确认'
                                      : task.assignment_status === 'rejected'
                                        ? '已拒绝'
                                        : '已接受'}{' '}
                                    ·{' '}
                                  </span>
                                  {task.responsible_user.name}
                                </p>
                              </div>

                              {(task.selected_agent ||
                                task.project_workspace) && (
                                <div
                                  className={cn(
                                    'mt-2 space-y-0.5',
                                    CANVAS_TEXT_META,
                                  )}
                                >
                                  {task.selected_agent && (
                                    <p className="truncate">
                                      Agent · {task.selected_agent.name}
                                    </p>
                                  )}
                                  {task.project_workspace && (
                                    <p className="truncate">
                                      工作空间 · {task.project_workspace.name}
                                    </p>
                                  )}
                                </div>
                              )}
                              {run?.safe_failure_reason && (
                                <p
                                  className={cn(
                                    'mt-2 line-clamp-3 text-destructive',
                                    CANVAS_TEXT_SECONDARY,
                                  )}
                                >
                                  {run.safe_failure_reason}
                                </p>
                              )}
                              {run?.result_summary && (
                                <div className="mt-2 rounded-interactive bg-foreground/[0.03] px-2 py-1.5">
                                  <p className={CANVAS_TEXT_EYEBROW}>
                                    {t('executionResult')}
                                  </p>
                                  <MarkdownRenderer
                                    content={run.result_summary}
                                    className={cn(
                                      'mt-0.5 line-clamp-2 text-foreground/80',
                                      CANVAS_TEXT_SECONDARY,
                                    )}
                                    renderLevel={2}
                                    resourceSpaceId={taskResultSpaceId(
                                      task,
                                      project.id,
                                    )}
                                    linksEnabled={false}
                                  />
                                </div>
                              )}
                              <span
                                className={cn(
                                  'mt-2 flex items-center justify-end gap-0.5 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/60 group-focus-within:text-muted-foreground/60',
                                  CANVAS_TEXT_MICRO,
                                )}
                              >
                                查看详情
                                <ChevronRight
                                  className="h-3.5 w-3.5"
                                  aria-hidden
                                />
                              </span>
                            </button>
                          </article>
                        );
                      })
                    )}
                  </div>
                </section>
              ))}
            </div>
          </div>
        ))}

      {detailTask && (
        <section
          className="min-h-0"
          aria-label="任务详情页"
          data-testid="project-task-detail-page"
        >
          <header className="mb-5 flex items-center justify-between gap-3 border-b border-foreground/[0.07] pb-4">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={closeTaskDetail}
            >
              <ArrowLeft className="mr-1.5 h-[1em] w-[1em]" />
              返回任务列表
            </Button>
            {detailLoading && (
              <Loader2
                className="h-4 w-4 animate-spin text-muted-foreground"
                aria-label="正在更新任务详情"
              />
            )}
          </header>
          <div
            className="overflow-auto"
            data-testid="project-task-detail-scroll"
          >
            <div
              className="grid min-h-[calc(100vh-14rem)] min-w-[52rem] grid-cols-[minmax(0,1fr)_17rem] rounded-[12px] border border-foreground/[0.07]"
              data-testid="project-task-detail-layout"
            >
              <p className="sr-only">{t('detailA11y')}</p>
              <main className="min-w-0 px-8 py-7">
                <div
                  className={cn('flex items-center gap-2', CANVAS_TEXT_META)}
                >
                  <span>{t('breadcrumb')}</span>
                  <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                  <span>{STATUS_LABEL[detailTask.work_status]}</span>
                </div>

                <div className="mt-6">
                  <h1 className="text-title font-semibold leading-tight tracking-[-0.015em] text-foreground">
                    {detailTask.title}
                  </h1>
                  <p className={cn('mt-1', CANVAS_TEXT_META)}>
                    {detailTask.responsible_user.name} 负责 ·{' '}
                    {formatTaskDate(
                      detailTask.created_at,
                      i18n.resolvedLanguage || i18n.language,
                    )}{' '}
                    创建
                  </p>
                  <div className="mt-5 min-h-20 text-body leading-7 text-foreground/90">
                    {detailTask.description || (
                      <span className="text-muted-foreground/60">
                        {t('noDescription')}
                      </span>
                    )}
                  </div>
                </div>

                {detailCanKickoff && (
                  <section
                    className="mt-7 border-t border-foreground/[0.07] pt-6"
                    aria-labelledby="task-kickoff-form"
                  >
                    <h3
                      id="task-kickoff-form"
                      className="text-body font-semibold text-foreground"
                    >
                      {detailTask.work_status === 'blocked'
                        ? '重新运行'
                        : '补充执行说明'}
                    </h3>
                    <p className={cn('mt-1', CANVAS_TEXT_SECONDARY)}>
                      {detailTask.work_status === 'blocked'
                        ? '失败会话不能直接重新发送。请在下方补充说明后创建新的执行；旧的失败记录会保留。'
                        : '写清目标、约束和完成标准，可附带图片或文件，再点右侧开始或再执行。'}
                    </p>
                    <Textarea
                      aria-label="执行补充说明"
                      value={kickoffMessageByTask[detailTask.id] || ''}
                      onChange={(event) =>
                        setKickoffMessageByTask((current) => ({
                          ...current,
                          [detailTask.id]: event.target.value,
                        }))
                      }
                      placeholder="例如：周末团建手册需含目标、行程草案、餐饮预算；参考附图场地照片。"
                      className="mt-3 min-h-[140px] resize-y text-body"
                      disabled={detailIsBusy}
                    />
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <input
                        ref={kickoffImageInputRef}
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={(event) => {
                          addKickoffFiles(event.target.files, 'image');
                          event.target.value = '';
                        }}
                      />
                      <input
                        ref={kickoffFileInputRef}
                        type="file"
                        multiple
                        className="hidden"
                        onChange={(event) => {
                          addKickoffFiles(event.target.files, 'file');
                          event.target.value = '';
                        }}
                      />
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={detailIsBusy}
                        onClick={() => kickoffImageInputRef.current?.click()}
                      >
                        <ImagePlus className="mr-1.5 h-[1em] w-[1em]" />
                        添加图片
                      </Button>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={detailIsBusy}
                        onClick={() => kickoffFileInputRef.current?.click()}
                      >
                        <Paperclip className="mr-1.5 h-[1em] w-[1em]" />
                        添加附件
                      </Button>
                      {kickoffAttachmentsUploading && (
                        <span
                          className={cn(
                            CANVAS_TEXT_MICRO,
                            'text-muted-foreground',
                          )}
                        >
                          {t('uploading')}
                        </span>
                      )}
                    </div>
                    {kickoffAttachments.length > 0 && (
                      <ul className="mt-3 space-y-2">
                        {kickoffAttachments.map((item) => (
                          <li
                            key={item.id}
                            className="flex items-center gap-3 rounded-[10px] border border-foreground/[0.08] bg-foreground/[0.02] px-3 py-2"
                          >
                            {item.type === 'image' &&
                            (item.previewUrl || item.remoteUrl) ? (
                              <img
                                src={item.previewUrl || item.remoteUrl}
                                alt=""
                                className="h-10 w-10 rounded-interactive object-cover"
                              />
                            ) : (
                              <span className="inline-grid h-10 w-10 place-items-center rounded-interactive bg-background text-muted-foreground shadow-sm">
                                <Paperclip className="h-4 w-4" aria-hidden />
                              </span>
                            )}
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-body text-foreground">
                                {item.filename}
                              </span>
                              <span
                                className={cn('mt-0.5 block', CANVAS_TEXT_META)}
                              >
                                {item.status === 'ready' && '已上传'}
                                {item.status === 'uploading' &&
                                  `上传中 ${Math.round((item.uploadProgress || 0) * 100)}%`}
                                {item.status === 'pending' && '等待上传'}
                                {item.status === 'error' &&
                                  (item.error || '上传失败')}
                                {' · '}
                                {formatFileSize(item.size)}
                              </span>
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="shrink-0"
                              disabled={detailIsBusy}
                              onClick={() => removeKickoffAttachment(item.id)}
                            >
                              <X
                                className="h-4 w-4"
                                aria-label={`移除 ${item.filename}`}
                              />
                            </Button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                )}

                <section
                  id="task-detail-conversations"
                  className="mt-7 border-t border-foreground/[0.07] pt-6"
                  aria-labelledby="task-detail-conversations-title"
                  data-testid="project-task-conversations"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <MessageSquare
                        className="h-4 w-4 text-muted-foreground/60"
                        aria-hidden
                      />
                      <h3
                        id="task-detail-conversations-title"
                        className="text-body font-semibold text-foreground"
                      >
                        对话
                      </h3>
                      <span
                        className={cn(
                          CANVAS_TEXT_MICRO,
                          'tabular-nums text-muted-foreground/60',
                        )}
                      >
                        {detailConversations.length}
                      </span>
                    </div>
                    {detailCanStartConversation && (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={detailIsBusy}
                        onClick={() =>
                          void handlePrepareConversation(detailTask)
                        }
                      >
                        {actionKey === `prepare:${detailTask.id}` ? (
                          <Loader2 className="mr-1.5 h-[1em] w-[1em] animate-spin" />
                        ) : (
                          <Plus className="mr-1.5 h-[1em] w-[1em]" />
                        )}
                        新开对话
                      </Button>
                    )}
                  </div>
                  <p className={cn('mt-1', CANVAS_TEXT_SECONDARY)}>
                    任务是容器，下面可挂多条对话。各次执行与准备会话都会留在这里，可随时回看。
                  </p>
                  {detailConversations.length === 0 ? (
                    <div
                      className={cn(
                        'mt-4 rounded-[10px] bg-foreground/[0.03] px-3 py-4',
                        CANVAS_TEXT_SECONDARY,
                      )}
                    >
                      {detailIsMine
                        ? detailRunBusy
                          ? '当前有执行正在进行，结束后可再开新对话。'
                          : detailCanStartConversation
                            ? '还没有对话。可先「新开对话」补充上下文，再开始执行。'
                            : '接受任务并确认工作空间与 Agent 后，才能在此任务下开对话。'
                        : '责任人尚未创建执行对话，或你无权查看会话入口。'}
                    </div>
                  ) : (
                    <ul className="mt-4 space-y-2">
                      {detailConversations.map((conversation) => {
                        const canOpen = Boolean(conversation.session_id);
                        return (
                          <li key={conversation.run_id}>
                            <button
                              type="button"
                              disabled={!canOpen || detailIsBusy}
                              className={cn(
                                'flex w-full min-w-0 items-center gap-3 rounded-[10px] border border-foreground/[0.08] bg-foreground/[0.02] px-3 py-2.5 text-left transition-colors',
                                canOpen
                                  ? 'hover:border-foreground/[0.14] hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40'
                                  : 'cursor-not-allowed opacity-70',
                              )}
                              onClick={() => {
                                if (!conversation.session_id) return;
                                void openRunSessionById(
                                  conversation.session_id,
                                  {
                                    keepDetail: true,
                                    taskId: detailTask.id,
                                    runId: conversation.run_id,
                                    runStatus: conversation.run_status,
                                  },
                                );
                              }}
                            >
                              <span className="inline-grid h-9 w-9 shrink-0 place-items-center rounded-interactive bg-background text-muted-foreground shadow-sm">
                                <MessageSquare
                                  className="h-4 w-4"
                                  aria-hidden
                                />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="flex min-w-0 items-center gap-2">
                                  <span className="truncate text-body font-medium text-foreground">
                                    {conversation.title ||
                                      CONVERSATION_KIND_LABEL[
                                        conversation.kind
                                      ]}
                                  </span>
                                  {conversation.is_active && (
                                    <span
                                      className={cn(
                                        'shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-primary',
                                        CANVAS_TEXT_MICRO,
                                      )}
                                    >
                                      进行中
                                    </span>
                                  )}
                                </span>
                                <span
                                  className={cn(
                                    'mt-0.5 block',
                                    CANVAS_TEXT_META,
                                  )}
                                >
                                  {CONVERSATION_KIND_LABEL[conversation.kind]}
                                  {' · '}
                                  {RUN_STATUS_LABEL[conversation.run_status] ||
                                    conversation.run_status}
                                  {' · '}
                                  {formatTaskDate(
                                    conversation.created_at,
                                    i18n.resolvedLanguage || i18n.language,
                                  )}
                                  {!canOpen && ' · 仅责任人可打开'}
                                </span>
                              </span>
                              {canOpen && (
                                <ExternalLink
                                  className="h-4 w-4 shrink-0 text-muted-foreground/40"
                                  aria-hidden
                                />
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>

                {detailSummary || detailAssets.length > 0 ? (
                  <section
                    className="sticky top-0 z-sticky mt-7 border-y border-foreground/[0.07] bg-background/95 py-5 backdrop-blur-sm"
                    aria-labelledby="task-detail-result"
                  >
                    <div className="flex items-center gap-2">
                      <PackageOpen
                        className="h-4 w-4 text-muted-foreground/60"
                        aria-hidden
                      />
                      <h3
                        id="task-detail-result"
                        className="text-body font-semibold text-foreground"
                      >
                        {detailTask.work_status === 'done'
                          ? '已发布交付物'
                          : '当前中间产物'}
                      </h3>
                    </div>
                    {detailSummary && (
                      <MarkdownRenderer
                        content={detailSummary}
                        className="mt-3 text-body leading-7 text-foreground/90"
                        renderLevel={2}
                        resourceSpaceId={detailResultSpaceId}
                      />
                    )}
                    {activeResultDoc && (
                      <div className="mt-4">
                        {detailTabdocAssets.length > 1 && (
                          <div
                            className="mb-3 flex flex-wrap gap-1.5"
                            role="tablist"
                            aria-label="选择要预览的文档"
                          >
                            {detailTabdocAssets.map((item) => {
                              const selected = item.id === activeResultDoc.id;
                              return (
                                <button
                                  key={item.id}
                                  type="button"
                                  role="tab"
                                  aria-selected={selected}
                                  className={cn(
                                    'max-w-[16rem] truncate rounded-full px-3 py-1 text-caption transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                                    selected
                                      ? 'bg-primary/10 text-primary'
                                      : 'bg-foreground/[0.04] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground',
                                  )}
                                  onClick={() =>
                                    setExpandedResultDocId(item.id)
                                  }
                                >
                                  {item.title}
                                </button>
                              );
                            })}
                          </div>
                        )}
                        <div className="rounded-[10px] border border-foreground/[0.08] bg-foreground/[0.02]">
                          <div className="flex min-w-0 items-center gap-2 border-b border-foreground/[0.06] px-3 py-2">
                            <FileText
                              className="h-4 w-4 shrink-0 text-muted-foreground/60"
                              aria-hidden
                            />
                            <span className="min-w-0 flex-1 truncate text-body font-medium text-foreground">
                              {activeResultDoc.title}
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className={cn(
                                'shrink-0 text-muted-foreground',
                                CANVAS_TEXT_MICRO,
                              )}
                              onClick={() => openResultItem(activeResultDoc)}
                            >
                              <ExternalLink
                                className="mr-1 h-3.5 w-3.5"
                                aria-hidden
                              />
                              打开
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className={cn(
                                'shrink-0 text-muted-foreground',
                                CANVAS_TEXT_MICRO,
                              )}
                              onClick={() =>
                                openResultItem(activeResultDoc, {
                                  openVersionHistory: true,
                                })
                              }
                            >
                              <History
                                className="mr-1 h-3.5 w-3.5"
                                aria-hidden
                              />
                              版本历史
                            </Button>
                          </div>
                          <InlineDocPreview
                            key={activeResultDoc.resource_id}
                            documentId={activeResultDoc.resource_id}
                            className="rounded-none border-0"
                          />
                        </div>
                      </div>
                    )}
                    {detailOtherAssets.length > 0 && (
                      <div className="mt-4 grid gap-2 sm:grid-cols-2">
                        {detailOtherAssets.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            className="group flex min-w-0 items-center gap-3 rounded-[10px] border border-foreground/[0.08] bg-foreground/[0.02] p-3 text-left transition-colors hover:border-foreground/[0.14] hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                            onClick={() => openResultItem(item)}
                          >
                            <span className="inline-grid h-9 w-9 shrink-0 place-items-center rounded-interactive bg-background text-muted-foreground shadow-sm">
                              <FileText className="h-4 w-4" aria-hidden />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-body font-medium text-foreground">
                                {item.title}
                              </span>
                              <span
                                className={cn('mt-0.5 block', CANVAS_TEXT_META)}
                              >
                                {t('cloudDeliverables')}
                              </span>
                            </span>
                            <ChevronRight
                              className="h-4 w-4 shrink-0 text-muted-foreground/30"
                              aria-hidden
                            />
                          </button>
                        ))}
                      </div>
                    )}
                  </section>
                ) : null}

                <section
                  className="mt-7 border-t border-foreground/[0.07] pt-6"
                  aria-labelledby="task-comment-form"
                >
                  <div className="flex items-center gap-2">
                    <MessageSquare
                      className="h-4 w-4 text-muted-foreground/60"
                      aria-hidden
                    />
                    <h3
                      id="task-comment-form"
                      className="text-body font-semibold text-foreground"
                    >
                      {t('comment')}
                    </h3>
                  </div>
                  <Textarea
                    aria-label="任务评论"
                    value={commentDraft}
                    onChange={(event) => setCommentDraft(event.target.value)}
                    placeholder="补充判断、问题或下一步；不会改变任务状态。"
                    className="mt-3 min-h-24 resize-y text-body"
                    maxLength={4000}
                    disabled={detailIsBusy}
                  />
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <p className={CANVAS_TEXT_META}>{t('commentVisible')}</p>
                    <Button
                      type="button"
                      size="sm"
                      disabled={!commentDraft.trim() || detailIsBusy}
                      onClick={() => void handleAddComment()}
                    >
                      {actionKey === `comment:${detailTask.id}` && (
                        <Loader2 className="mr-1.5 h-[1em] w-[1em] animate-spin" />
                      )}
                      发布评论
                    </Button>
                  </div>
                </section>

                <section
                  className="mt-7 border-t border-foreground/[0.07] pt-6"
                  aria-labelledby="task-detail-activity"
                >
                  <div className="flex items-center gap-2">
                    <History
                      className="h-4 w-4 text-muted-foreground/60"
                      aria-hidden
                    />
                    <h3
                      id="task-detail-activity"
                      className="text-body font-semibold text-foreground"
                    >
                      {t('activity')}
                    </h3>
                  </div>
                  <div className="mt-4 space-y-0">
                    {(detailTask.events?.length
                      ? [...detailTask.events].reverse()
                      : [
                          {
                            id: `created-${detailTask.id}`,
                            event_type: 'created',
                            actor: {
                              id: detailTask.created_by.id,
                              name: detailTask.created_by.name,
                            },
                            payload: {},
                            created_at: detailTask.created_at,
                          },
                        ]
                    ).map((event, index, events) => (
                      <div
                        key={event.id}
                        className="relative flex gap-3 pb-5 last:pb-0"
                      >
                        {index < events.length - 1 && (
                          <span
                            className="absolute left-[0.4375rem] top-4 h-[calc(100%-0.5rem)] w-px bg-foreground/[0.08]"
                            aria-hidden
                          />
                        )}
                        <span
                          className="relative mt-1 h-3.5 w-3.5 shrink-0 rounded-full border-[3px] border-background bg-muted-foreground/40 ring-1 ring-foreground/[0.1]"
                          aria-hidden
                        />
                        <div className="min-w-0">
                          <p className="text-body leading-5 text-foreground/90">
                            <span className="font-medium">
                              {event.actor.name || '系统'}
                            </span>
                            <span className="text-muted-foreground">
                              {event.event_type === 'comment'
                                ? ' 留下了评论'
                                : ` ${EVENT_LABEL[event.event_type] || event.event_type}`}
                            </span>
                          </p>
                          {event.event_type === 'comment' &&
                            readEventText(event.payload || {}, 'content') && (
                              <p className="mt-2 whitespace-pre-wrap rounded-[10px] bg-foreground/[0.035] px-3 py-2 text-body leading-6 text-foreground/90">
                                {readEventText(event.payload || {}, 'content')}
                              </p>
                            )}
                          {formatTaskEventDetails(event, detailTask).map(
                            (line, detailIndex) => (
                              <p
                                key={`${event.id}-${detailIndex}`}
                                className={cn('mt-1', CANVAS_TEXT_SECONDARY)}
                              >
                                {line}
                              </p>
                            ),
                          )}
                          <p className={CANVAS_TEXT_META}>
                            {formatTaskDate(
                              event.created_at,
                              i18n.resolvedLanguage || i18n.language,
                            )}
                          </p>
                          {(() => {
                            const sessionId = resolveTaskEventSessionId(
                              event,
                              detailTask,
                            );
                            if (!sessionId) return null;
                            return (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className={cn(
                                  'mt-2 h-7 px-2',
                                  CANVAS_TEXT_MICRO,
                                )}
                                onClick={() => {
                                  const conversation = detailConversations.find(
                                    (item) => item.session_id === sessionId,
                                  );
                                  const eventRunId = readEventText(
                                    event.payload || {},
                                    'run_id',
                                  );
                                  void openRunSessionById(sessionId, {
                                    keepDetail: true,
                                    taskId: detailTask.id,
                                    runId:
                                      conversation?.run_id ||
                                      eventRunId ||
                                      detailTask.latest_run?.id ||
                                      null,
                                    runStatus:
                                      conversation?.run_status ??
                                      detailTask.latest_run?.status ??
                                      null,
                                  });
                                }}
                              >
                                前往对话
                                <ExternalLink className="ml-1 h-3 w-3" />
                              </Button>
                            );
                          })()}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              </main>

              <aside className="border-l border-foreground/[0.07] bg-foreground/[0.025] px-5 py-6">
                {detailHasActions && (
                  <section
                    className="mb-5 border-b border-foreground/[0.07] pb-5"
                    aria-labelledby="task-detail-actions"
                  >
                    <p
                      id="task-detail-actions"
                      className={CANVAS_TEXT_SECTION_LABEL}
                    >
                      操作
                    </p>
                    <div className="mt-3 space-y-2">
                      {detailIsMine &&
                        detailTask.assignment_status === 'pending' && (
                          <div className="grid grid-cols-2 gap-2">
                            <Button
                              type="button"
                              size="sm"
                              disabled={detailIsBusy}
                              onClick={() =>
                                void runDetailAction(
                                  detailTask,
                                  `accept:${detailTask.id}`,
                                  () =>
                                    ProjectApiService.respondTaskAssignment(
                                      project.id,
                                      detailTask.id,
                                      true,
                                    ),
                                  '已接受',
                                )
                              }
                            >
                              <Check className="mr-1.5 h-[1em] w-[1em]" />
                              接受任务
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={detailIsBusy}
                              onClick={() =>
                                void runDetailAction(
                                  detailTask,
                                  `reject:${detailTask.id}`,
                                  () =>
                                    ProjectApiService.respondTaskAssignment(
                                      project.id,
                                      detailTask.id,
                                      false,
                                    ),
                                  '已拒绝任务',
                                )
                              }
                            >
                              <X className="mr-1.5 h-[1em] w-[1em]" />
                              拒绝任务
                            </Button>
                          </div>
                        )}
                      {detailCanConfigure && (
                        <div className="space-y-2">
                          <select
                            aria-label="选择执行工作空间"
                            value={
                              selectedWorkspaceByTask[detailTask.id] ||
                              availableWorkspaces[0]?.id ||
                              ''
                            }
                            onChange={(event) =>
                              setSelectedWorkspaceByTask((current) => ({
                                ...current,
                                [detailTask.id]: event.target.value,
                              }))
                            }
                            disabled={availableWorkspaces.length === 0}
                            className="h-8 w-full rounded-interactive border border-input bg-background px-2 text-body text-foreground"
                          >
                            {availableWorkspaces.length === 0 ? (
                              <option value="">{t('noWorkspace')}</option>
                            ) : (
                              availableWorkspaces.map((workspace) => (
                                <option key={workspace.id} value={workspace.id}>
                                  {workspace.name ||
                                    workspace.working_dir ||
                                    workspace.id}
                                </option>
                              ))
                            )}
                          </select>
                          <select
                            aria-label="选择执行 Agent"
                            value={
                              selectedAgentByTask[detailTask.id] ||
                              availableAgents[0]?.id ||
                              ''
                            }
                            onChange={(event) =>
                              setSelectedAgentByTask((current) => ({
                                ...current,
                                [detailTask.id]: event.target.value,
                              }))
                            }
                            disabled={availableAgents.length === 0}
                            className="h-8 w-full rounded-interactive border border-input bg-background px-2 text-body text-foreground"
                          >
                            {availableAgents.length === 0 ? (
                              <option value="">{t('noAgent')}</option>
                            ) : (
                              availableAgents.map((agent) => (
                                <option key={agent.id} value={agent.id}>
                                  {agent.display_name || agent.name}
                                </option>
                              ))
                            )}
                          </select>
                          {availableWorkspaces.length === 0 ? (
                            <p className={CANVAS_TEXT_SECONDARY}>
                              还没有可用的工作空间，请先在成员页准备默认执行位置。
                            </p>
                          ) : (
                            <p className={CANVAS_TEXT_SECONDARY}>
                              选择这次任务要用的工作空间和
                              Agent，确认后才能开始执行。
                            </p>
                          )}
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            className="w-full"
                            disabled={
                              detailIsBusy ||
                              availableAgents.length === 0 ||
                              availableWorkspaces.length === 0
                            }
                            onClick={() => void handleConfigure(detailTask)}
                          >
                            <Bot className="mr-1.5 h-[1em] w-[1em]" />
                            确认工作空间与 Agent
                          </Button>
                        </div>
                      )}
                      {detailCanKickoff && (
                        <div className="space-y-2">
                          <p className={CANVAS_TEXT_SECONDARY}>
                            {detailTask.work_status === 'blocked'
                              ? '将创建新的执行（保留失败记录），不会在旧会话里直接重新发送。'
                              : '在左侧表单补充文字、图片或附件后开始。'}
                          </p>
                          <Button
                            type="button"
                            size="sm"
                            className="w-full"
                            disabled={
                              detailIsBusy || kickoffAttachmentsUploading
                            }
                            onClick={() => void handleStartRun(detailTask)}
                          >
                            <Play className="mr-1.5 h-[1em] w-[1em]" />
                            {detailTask.work_status === 'blocked'
                              ? '重新运行'
                              : detailCompletedRun
                                ? '再执行一轮'
                                : '开始执行'}
                          </Button>
                        </div>
                      )}
                      {detailCanComplete && (
                        <Button
                          type="button"
                          size="sm"
                          className="w-full"
                          disabled={detailIsBusy}
                          onClick={() => {
                            closeTaskDetail();
                            openReview(detailTask);
                          }}
                        >
                          <CheckSquare2 className="mr-1.5 h-[1em] w-[1em]" />
                          完成
                        </Button>
                      )}
                      {canCancelTask(detailTask, currentUserId) && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="w-full text-destructive hover:text-destructive"
                          disabled={detailIsBusy}
                          onClick={() => {
                            closeTaskDetail();
                            setTaskPendingCancellation(detailTask);
                          }}
                        >
                          <Ban className="mr-1.5 h-[1em] w-[1em]" />
                          {detailTask.work_status === 'in_progress'
                            ? '停止执行'
                            : '取消任务'}
                        </Button>
                      )}
                      {detailHasOpenableConversation && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="w-full"
                          onClick={() =>
                            void handleOpenLatestOrListConversations(detailTask)
                          }
                        >
                          <MessageSquare className="mr-1.5 h-[1em] w-[1em]" />
                          {detailConversations.length > 1
                            ? `查看对话（${detailConversations.length}）`
                            : '打开对话'}
                        </Button>
                      )}
                      {detailCanStartConversation &&
                        !detailHasOpenableConversation && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="w-full"
                            disabled={detailIsBusy}
                            onClick={() =>
                              void handlePrepareConversation(detailTask)
                            }
                          >
                            {actionKey === `prepare:${detailTask.id}` ? (
                              <Loader2 className="mr-1.5 h-[1em] w-[1em] animate-spin" />
                            ) : (
                              <Plus className="mr-1.5 h-[1em] w-[1em]" />
                            )}
                            新开对话
                          </Button>
                        )}
                    </div>
                  </section>
                )}
                <p className={CANVAS_TEXT_SECTION_LABEL}>{t('properties')}</p>
                <dl className="mt-5 space-y-5">
                  <div>
                    <dt
                      className={cn(
                        CANVAS_TEXT_MICRO,
                        'text-muted-foreground/60',
                      )}
                    >
                      {t('status')}
                    </dt>
                    <dd className="mt-1.5 flex items-center gap-2 text-body text-foreground/90">
                      <span
                        className={cn(
                          'h-2 w-2 rounded-full',
                          TASK_LANES.find(
                            (lane) =>
                              lane.id === getTaskLaneId(detailTask.work_status),
                          )?.dotClassName,
                        )}
                        aria-hidden
                      />
                      {STATUS_LABEL[detailTask.work_status]}
                    </dd>
                  </div>
                  <div>
                    <dt
                      className={cn(
                        CANVAS_TEXT_MICRO,
                        'text-muted-foreground/60',
                      )}
                    >
                      {t('assignee')}
                    </dt>
                    <dd className="mt-1.5 flex items-center gap-2 text-body text-foreground/90">
                      <UserRound
                        className="h-4 w-4 text-muted-foreground/60"
                        aria-hidden
                      />
                      {detailTask.responsible_user.name}
                    </dd>
                  </div>
                  <div>
                    <dt
                      className={cn(
                        CANVAS_TEXT_MICRO,
                        'text-muted-foreground/60',
                      )}
                    >
                      {t('priority')}
                    </dt>
                    <dd className="mt-1.5 text-body text-foreground/90">
                      {PRIORITY_LABEL[detailTask.priority]}
                    </dd>
                  </div>
                  <div>
                    <dt
                      className={cn(
                        CANVAS_TEXT_MICRO,
                        'text-muted-foreground/60',
                      )}
                    >
                      Agent
                    </dt>
                    <dd className="mt-1.5 text-body text-foreground/90">
                      {detailTask.selected_agent?.name || '未选择'}
                    </dd>
                  </div>
                  <div>
                    <dt
                      className={cn(
                        CANVAS_TEXT_MICRO,
                        'text-muted-foreground/60',
                      )}
                    >
                      {t('workspace')}
                    </dt>
                    <dd className="mt-1.5 break-words text-body leading-5 text-foreground/90">
                      {detailTask.project_workspace?.name || '未确认'}
                    </dd>
                  </div>
                  <div>
                    <dt
                      className={cn(
                        CANVAS_TEXT_MICRO,
                        'text-muted-foreground/60',
                      )}
                    >
                      {t('createdAt')}
                    </dt>
                    <dd className="mt-1.5 flex items-center gap-2 text-body text-foreground/90">
                      <CalendarDays
                        className="h-4 w-4 text-muted-foreground/60"
                        aria-hidden
                      />
                      {formatTaskDate(
                        detailTask.created_at,
                        i18n.resolvedLanguage || i18n.language,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt
                      className={cn(
                        CANVAS_TEXT_MICRO,
                        'text-muted-foreground/60',
                      )}
                    >
                      {t('published')}
                    </dt>
                    <dd className="mt-1.5 text-body text-foreground/90">
                      {detailTask.work_status === 'done'
                        ? detailAssets.length
                        : '尚未发布'}
                    </dd>
                  </div>
                </dl>
              </aside>
            </div>
          </div>
        </section>
      )}

      <Dialog
        open={Boolean(taskPendingCancellation)}
        onOpenChange={(open) => {
          if (!open && !actionKey) setTaskPendingCancellation(null);
        }}
      >
        <DialogContent closeLabel="关闭取消确认">
          <DialogHeader>
            <DialogTitle>
              {taskPendingCancellation?.work_status === 'in_progress'
                ? '停止并取消任务？'
                : '取消这个任务？'}
            </DialogTitle>
            <DialogDescription>
              {taskPendingCancellation?.work_status === 'in_progress'
                ? 'Agent 会停止当前执行，任务进入“已取消”。已经产生的中间内容仍保留在执行会话中，但不会发布为项目交付物。'
                : '任务会进入“已取消”，已有内容不会发布为项目交付物。'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={Boolean(actionKey)}
              onClick={() => setTaskPendingCancellation(null)}
            >
              继续任务
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={Boolean(actionKey)}
              onClick={() => void handleCancelTask()}
            >
              {actionKey.startsWith('cancel:') && (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              )}
              确认取消
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!open && actionKey) return;
          setCreateOpen(open);
          if (!open) resetCreateDraft();
        }}
      >
        <DialogContent closeLabel="关闭新建任务">
          <DialogHeader>
            <DialogTitle>{t('createTitle')}</DialogTitle>
            <DialogDescription>{t('createDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <label className="block space-y-1.5 text-body font-medium text-foreground">
              任务标题
              <Input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="例如：完成上线前验收"
                autoFocus
              />
            </label>
            <label className="block space-y-1.5 text-body font-medium text-foreground">
              说明
              <Textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="补充范围、约束和验收标准"
                rows={4}
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1.5 text-body font-medium text-foreground">
                指派人
                <select
                  value={responsibleUserId}
                  onChange={(event) => setResponsibleUserId(event.target.value)}
                  className="h-9 w-full rounded-interactive border border-input bg-background px-3 text-body text-foreground"
                >
                  {responsibleOptions.map((member) => (
                    <option key={member.user_id} value={member.user_id}>
                      {memberName(member)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1.5 text-body font-medium text-foreground">
                优先级
                <select
                  value={priority}
                  onChange={(event) =>
                    setPriority(event.target.value as ProjectTaskPriority)
                  }
                  className="h-9 w-full rounded-interactive border border-input bg-background px-3 text-body text-foreground"
                >
                  {(Object.keys(PRIORITY_LABEL) as ProjectTaskPriority[]).map(
                    (value) => (
                      <option key={value} value={value}>
                        {PRIORITY_LABEL[value]}
                      </option>
                    ),
                  )}
                </select>
              </label>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={Boolean(actionKey)}
              onClick={() => {
                setCreateOpen(false);
                resetCreateDraft();
              }}
            >
              {t('cancel')}
            </Button>
            <Button
              type="button"
              disabled={
                !title.trim() || !responsibleUserId || Boolean(actionKey)
              }
              onClick={() => void handleCreate()}
            >
              {actionKey === 'create' && (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              )}
              创建任务
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(reviewTask)}
        onOpenChange={(open) => {
          if (!open && !actionKey) {
            setReviewTask(null);
            setSelectedResultItemIds([]);
          }
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('completeTitle')}</DialogTitle>
            <DialogDescription>
              下面内容会成为 Project
              成员可见的资产。请删除本地路径、凭据、原始日志和不适合团队共享的信息。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <label className="block space-y-1.5 text-body font-medium text-foreground">
              资产标题
              <Input
                value={deliverableTitle}
                onChange={(event) => setDeliverableTitle(event.target.value)}
              />
            </label>
            <label className="block space-y-1.5 text-body font-medium text-foreground">
              团队可见摘要
              <Textarea
                value={reviewSummary}
                onChange={(event) => setReviewSummary(event.target.value)}
                rows={8}
              />
            </label>
            {(taskCompletedRun(reviewTask)?.result_items?.length ?? 0) > 0 ? (
              <section className="space-y-2" aria-label="执行结果交付物">
                <div>
                  <p className="text-body font-medium text-foreground">
                    {t('cloudDeliverables')}
                  </p>
                  <p className={cn('mt-1', CANVAS_TEXT_SECONDARY)}>
                    Agent 已自动加入本次明确交付的云端资产。移除后不会发布到
                    Project。
                  </p>
                </div>
                <div className="space-y-2">
                  {(taskCompletedRun(reviewTask)?.result_items ?? []).map(
                    (item) => {
                      const isSelected = selectedResultItemIds.includes(
                        item.id,
                      );
                      return (
                        <article
                          key={item.id}
                          className={cn(
                            'flex items-start gap-3 rounded-interactive border p-3',
                            isSelected
                              ? 'border-primary/30 bg-primary/[0.04]'
                              : 'border-border bg-foreground/[0.02]',
                          )}
                        >
                          <span className="inline-grid h-8 w-8 shrink-0 place-items-center rounded-interactive bg-foreground/[0.05] text-muted-foreground">
                            <FileText className="h-4 w-4" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-body font-medium text-foreground">
                              {item.title}
                            </p>
                            <p className={cn('mt-0.5', CANVAS_TEXT_META)}>
                              {item.resource_type === 'tabdoc'
                                ? '在线文档'
                                : '云端资产'}
                            </p>
                            {item.preview ? (
                              <p
                                className={cn(
                                  'mt-1 line-clamp-2',
                                  CANVAS_TEXT_SECONDARY,
                                )}
                              >
                                {item.preview}
                              </p>
                            ) : null}
                          </div>
                          <Button
                            type="button"
                            variant={isSelected ? 'secondary' : 'outline'}
                            size="sm"
                            aria-pressed={isSelected}
                            onClick={() =>
                              setSelectedResultItemIds((current) =>
                                isSelected
                                  ? current.filter((id) => id !== item.id)
                                  : [...current, item.id],
                              )
                            }
                          >
                            {isSelected ? (
                              <>
                                <Check className="mr-1.5 h-[1em] w-[1em]" />
                                {t('added')}
                              </>
                            ) : (
                              <>
                                <Plus className="mr-1.5 h-[1em] w-[1em]" />
                                {t('add')}
                              </>
                            )}
                          </Button>
                        </article>
                      );
                    },
                  )}
                </div>
              </section>
            ) : (
              <div
                className={cn(
                  'rounded-interactive bg-foreground/[0.03] p-3',
                  CANVAS_TEXT_SECONDARY,
                )}
              >
                本次执行没有声明云端交付物；发布后仅保留团队可见摘要。
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={Boolean(actionKey)}
              onClick={() => setReviewTask(null)}
            >
              {t('continueReview')}
            </Button>
            <Button
              type="button"
              disabled={!reviewSummary.trim() || Boolean(actionKey)}
              onClick={() => void handleAcceptResult()}
            >
              {reviewTask && actionKey === `review:${reviewTask.id}` && (
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              )}
              确认完成并发布
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
};
