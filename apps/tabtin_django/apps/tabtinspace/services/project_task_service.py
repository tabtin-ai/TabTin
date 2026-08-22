"""Project Task 的责任流与执行配置领域服务。"""

from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from apps.agent.models import Agent
from apps.tabtinspace.models import (
    ContextItem,
    Project,
    ProjectMembership,
    ProjectMemberWorkspace,
    ProjectTask,
    ProjectTaskDeliverable,
    ProjectTaskEvent,
    ProjectTaskRun,
    SpaceActivityEvent,
)
from apps.tabtinspace.services.base import BaseService, ServiceError
from apps.tabtinspace.services.project_task_preview_access import (
    PREVIEWABLE_WORK_STATUSES,
)
from apps.tabtinspace.services.space_activity_service import (
    record_team_space_activity,
    resolve_user_display_name,
)

User = get_user_model()
logger = logging.getLogger(__name__)

# agent.user.project_task_invalidated 允许的 payload 键——禁止夹带私有正文 / session。
_PROJECT_TASK_INVALIDATION_PAYLOAD_KEYS = frozenset({
    'project_id',
    'task_id',
    'event_type',
    'version',
})


def publish_project_task_invalidated(
    *,
    project_id: str,
    task_id: str,
    event_type: str,
    version: int,
) -> None:
    """向 Project 全部 active 成员广播最小化任务失效事件。

    走 ``publish_to_user`` 用户级通道，不新增 WS topic validator。
    payload 仅含 project_id / task_id / event_type / version。
    """
    try:
        from apps.services.common.agent_protocol.constants import AgentUserEvent
        from apps.services.common.agent_protocol.namespace import user_event_type
        from apps.services.common.ws.bus import publish_to_user
        from apps.services.common.ws.protocol import build_envelope, new_event_id

        payload = {
            'project_id': str(project_id),
            'task_id': str(task_id),
            'event_type': str(event_type or ''),
            'version': int(version),
        }
        if set(payload) != _PROJECT_TASK_INVALIDATION_PAYLOAD_KEYS:
            logger.error(
                '[ProjectTask] invalidation payload keys drifted: %s',
                sorted(payload),
            )
            return

        member_ids = list(
            ProjectMembership.objects.filter(
                project_id=project_id,
                is_active=True,
                status=ProjectMembership.Status.ACTIVE,
                user_id__isnull=False,
            )
            .values_list('user_id', flat=True)
            .distinct()
        )
        event_name = user_event_type(AgentUserEvent.PROJECT_TASK_INVALIDATED)
        for user_id in member_ids:
            envelope = build_envelope(event_name, new_event_id(), payload)
            publish_to_user(str(user_id), envelope)
    except Exception:
        logger.warning(
            '[ProjectTask] project_task_invalidated publish failed: '
            'project=%s task=%s event=%s version=%s',
            str(project_id)[:8],
            str(task_id)[:8],
            event_type,
            version,
            exc_info=True,
        )


def schedule_project_task_invalidation(task: ProjectTask, event_type: str) -> None:
    """事务提交后广播任务失效；调用方须已写完 version。"""
    project_id = str(task.project_id)
    task_id = str(task.id)
    version = int(task.version)
    safe_event_type = str(event_type or '')

    def _publish() -> None:
        publish_project_task_invalidated(
            project_id=project_id,
            task_id=task_id,
            event_type=safe_event_type,
            version=version,
        )

    transaction.on_commit(_publish)


class ProjectTaskService:
    """所有 Task 命令都经本服务校验 Project 成员、责任人与私有执行现场。"""

    def __init__(self, *, user: Any):
        self.user = user

    def _load_project(self, project_id: UUID) -> Project:
        project = Project.objects.filter(
            id=project_id,
            is_archived=False,
            trashed_at__isnull=True,
        ).first()
        if project is None:
            raise ServiceError('PROJECT_NOT_FOUND', 'Project 不存在', 404)
        if not self._is_member(project, self.user):
            raise ServiceError('PERMISSION_DENIED', '只有 Project 成员可以查看任务', 403)
        return project

    @staticmethod
    def _is_member(project: Project, user: Any) -> bool:
        return bool(user) and ProjectMembership.objects.filter(
            project=project,
            user_id=user.id,
            is_active=True,
            status=ProjectMembership.Status.ACTIVE,
        ).exists()

    def _load_member(self, project: Project, user_id: UUID):
        membership = ProjectMembership.objects.filter(
            project=project,
            user_id=user_id,
            is_active=True,
            status=ProjectMembership.Status.ACTIVE,
        ).select_related('user').first()
        if membership is None or membership.user is None:
            raise ServiceError('RESPONSIBLE_USER_INVALID', '责任人必须是当前 Project 的生效成员', 400)
        return membership.user

    def _load_task(self, project_id: UUID, task_id: UUID, *, for_update: bool = False) -> ProjectTask:
        project = self._load_project(project_id)
        queryset = ProjectTask.objects.select_related(
            'project',
            'created_by',
            'responsible_user',
            'selected_agent',
            'project_member_workspace__workspace__device',
        )
        if for_update:
            # selected_agent / workspace 均可空，PG 不允许锁外连接的 nullable 侧；
            # 状态命令只需要锁 Task 自身。
            queryset = queryset.select_for_update(of=('self',))
        task = queryset.filter(id=task_id, project=project).first()
        if task is None:
            raise ServiceError('TASK_NOT_FOUND', '任务不存在', 404)
        return task

    @staticmethod
    def _event(task: ProjectTask, actor: Any, event_type: str, payload: dict | None = None) -> None:
        ProjectTaskEvent.objects.create(
            task=task,
            actor=actor,
            actor_name=resolve_user_display_name(actor),
            event_type=event_type,
            payload=payload or {},
        )

    @staticmethod
    def _activity(task: ProjectTask, actor: Any, event_type: str, metadata: dict | None = None) -> None:
        project = task.project
        transaction.on_commit(lambda: record_team_space_activity(
            project,
            event_type,
            actor_user=actor,
            target_type='task',
            target_id=str(task.id),
            target_name=task.title,
            metadata=metadata or {},
        ))

    @staticmethod
    def _serialize_user(user: Any) -> dict:
        return {
            'id': str(user.id),
            'name': resolve_user_display_name(user),
        }

    def serialize_task(self, task: ProjectTask, *, include_events: bool = False) -> dict:
        workspace_link = task.project_member_workspace
        is_responsible = str(task.responsible_user_id) == str(self.user.id)
        # ：未完成任务上，非责任的 Project 成员默认可读 result_summary/
        # result_items（读中间产物不再以「先给大家看」为门槛）。private 字段
        # （会话 / 绑定快照 / 原始失败原因）仍只对责任人开放。旧 project_preview
        # 开关保留为向后兼容的显式放开（覆盖已完成任务等场景）。
        include_result_preview = (
            is_responsible
            or task.work_status in PREVIEWABLE_WORK_STATUSES
            or task.result_visibility == ProjectTask.ResultVisibility.PROJECT_PREVIEW
        )
        data = {
            'id': str(task.id),
            'project_id': str(task.project_id),
            'title': task.title,
            'description': task.description,
            'priority': task.priority,
            'created_by': self._serialize_user(task.created_by),
            'responsible_user': self._serialize_user(task.responsible_user),
            'assignment_status': task.assignment_status,
            'work_status': task.work_status,
            'selected_agent': ({
                'id': str(task.selected_agent_id),
                'name': task.selected_agent.name,
            } if task.selected_agent_id else None),
            'project_workspace': ({
                'id': str(workspace_link.workspace_id),
                'name': workspace_link.workspace.name,
                'device_status': workspace_link.workspace.device.status,
                'confirmed_at': task.workspace_confirmed_at.isoformat()
                    if task.workspace_confirmed_at else None,
            } if workspace_link and is_responsible else None),
            'workspace_confirmed': bool(task.workspace_confirmed_at),
            'execution_ready': bool(
                task.assignment_status == ProjectTask.AssignmentStatus.ACCEPTED
                and task.selected_agent_id
                and task.project_member_workspace_id
                and task.workspace_confirmed_at
            ),
            'result_summary': task.result_summary,
            'result_visibility': task.result_visibility,
            'version': task.version,
            'created_at': task.created_at.isoformat(),
            'updated_at': task.updated_at.isoformat(),
        }
        runs = list(task.runs.select_related('chat_session').all())
        latest_run = runs[0] if runs else None
        latest_completed_run = next(
            (run for run in runs if run.status == ProjectTaskRun.Status.COMPLETED),
            None,
        )
        data['latest_run'] = self.serialize_run(
            latest_run,
            include_private=is_responsible,
            include_result_preview=include_result_preview,
        ) if latest_run else None
        # 新开对话会把 preparing Run 顶到 latest_run；完成发布仍看最近一次成功结果。
        data['latest_completed_run'] = self.serialize_run(
            latest_completed_run,
            include_private=is_responsible,
            include_result_preview=include_result_preview,
        ) if latest_completed_run else None
        data['conversations'] = self.serialize_conversations(
            task,
            include_private=is_responsible,
            runs=runs,
        )
        data['deliverables'] = [
            {
                'id': str(deliverable.id),
                'context_item_id': str(deliverable.context_item_id),
                'title': deliverable.context_item.title,
                'item_type': deliverable.context_item.item_type,
                'resource_id': deliverable.context_item.resource_id,
                'preview': deliverable.context_item.preview,
                'metadata': deliverable.context_item.metadata,
                'created_at': deliverable.created_at.isoformat(),
            }
            for deliverable in task.deliverables.select_related('context_item').all()
        ]
        if include_events:
            data['events'] = [
                {
                    'id': str(event.id),
                    'event_type': event.event_type,
                    'actor': {
                        'id': str(event.actor_id) if event.actor_id else None,
                        'name': event.actor_name,
                    },
                    'payload': (
                        event.payload
                        if is_responsible
                        else {
                            key: value
                            for key, value in (event.payload or {}).items()
                            if key != 'chat_session_id'
                        }
                    ),
                    'created_at': event.created_at.isoformat(),
                }
                for event in task.events.select_related('actor').all()
            ]
        return data

    @staticmethod
    def serialize_run(
        run: ProjectTaskRun,
        *,
        include_private: bool = True,
        include_result_preview: bool | None = None,
    ) -> dict:
        """序列化执行记录。

        - ``include_private``：责任人专属字段（会话、绑定快照、原始失败原因）
        - ``include_result_preview``：结果摘要与候选产物；默认跟随 ``include_private``。
           起，未完成任务对 Project 成员单独放开（见 ``serialize_task``），
          与 ``include_private`` 解耦。
        """
        show_results = include_private if include_result_preview is None else include_result_preview
        return {
            'id': str(run.id),
            'status': run.status,
            'rerun_of_id': str(run.rerun_of_id) if run.rerun_of_id else None,
            'chat_session_id': (
                str(run.chat_session_id) if include_private and run.chat_session_id else None
            ),
            'result_summary': run.result_summary if show_results else '',
            'result_items': run.result_items if show_results else [],
            'safe_failure_reason': run.safe_failure_reason if include_private else '',
            'binding': run.binding_snapshot if include_private else {},
            'started_at': run.started_at.isoformat() if run.started_at else None,
            'ended_at': run.ended_at.isoformat() if run.ended_at else None,
            'created_at': run.created_at.isoformat(),
        }

    @staticmethod
    def serialize_conversations(
        task: ProjectTask,
        *,
        include_private: bool,
        runs: list[ProjectTaskRun] | None = None,
    ) -> list[dict]:
        """序列化任务下全部执行/准备会话；session_id 仅责任人可见。"""
        active_statuses = {
            ProjectTaskRun.Status.PREPARING,
            ProjectTaskRun.Status.PENDING,
            ProjectTaskRun.Status.RUNNING,
        }
        run_list = (
            runs
            if runs is not None
            else list(task.runs.select_related('chat_session').all())
        )
        conversations: list[dict] = []
        for run in run_list:
            session = getattr(run, 'chat_session', None)
            title = (session.title if session and session.title else '') or (
                '执行' if task.title else ''
            )
            conversations.append({
                'session_id': (
                    str(run.chat_session_id)
                    if include_private and run.chat_session_id
                    else None
                ),
                'run_id': str(run.id),
                'kind': (
                    'preparation'
                    if run.status == ProjectTaskRun.Status.PREPARING
                    else 'execution'
                ),
                'run_status': run.status,
                'rerun_of_id': str(run.rerun_of_id) if run.rerun_of_id else None,
                'title': title,
                'is_active': run.status in active_statuses,
                'created_at': run.created_at.isoformat(),
            })
        return conversations

    def list_tasks(self, *, project_id: UUID) -> list[dict]:
        project = self._load_project(project_id)
        tasks = ProjectTask.objects.filter(project=project).select_related(
            'project', 'created_by', 'responsible_user', 'selected_agent',
            'project_member_workspace__workspace__device',
        )
        return [self.serialize_task(task) for task in tasks]

    def list_inbox(self, *, project_id: UUID) -> list[dict]:
        project = self._load_project(project_id)
        tasks = ProjectTask.objects.filter(
            project=project,
            responsible_user=self.user,
        ).exclude(
            work_status__in=[ProjectTask.WorkStatus.DONE, ProjectTask.WorkStatus.CANCELLED],
        ).select_related(
            'project', 'created_by', 'responsible_user', 'selected_agent',
            'project_member_workspace__workspace__device',
        )
        return [self.serialize_task(task) for task in tasks]

    def list_tasks_for_agent(
        self,
        *,
        organization_id: UUID,
        agent_id: UUID,
        cursor: str = '',
        limit: int = 20,
    ) -> dict:
        """跨 Project 列出指定 Agent 作为执行 Agent 的任务。

        仅返回当前用户有 active Project 成员资格、且 Project 属于该组织的任务；
        按 ``updated_at`` 降序分页，游标为上一页末条 task id。
        """
        if not BaseService(user=self.user).check_organization_permission(
            str(organization_id),
            'viewer',
        ):
            raise ServiceError('PERMISSION_DENIED', '无权访问该组织', 403)

        agent = Agent.objects.filter(
            id=agent_id,
            organization_id=organization_id,
        ).only('id').first()
        if agent is None:
            raise ServiceError('AGENT_NOT_FOUND', 'Agent 不存在或不属于该组织', 404)

        limit = max(1, min(limit, 50))

        member_project_ids = ProjectMembership.objects.filter(
            user_id=self.user.id,
            is_active=True,
            status=ProjectMembership.Status.ACTIVE,
            project__organization_id=organization_id,
            project__is_archived=False,
            project__trashed_at__isnull=True,
        ).values_list('project_id', flat=True)

        queryset = ProjectTask.objects.filter(
            selected_agent_id=agent_id,
            project_id__in=member_project_ids,
        ).select_related(
            'project',
            'created_by',
            'responsible_user',
            'selected_agent',
            'project_member_workspace__workspace__device',
        ).prefetch_related(
            'runs__chat_session',
            'deliverables__context_item',
        ).order_by('-updated_at', '-created_at', '-id')

        cursor = (cursor or '').strip()
        if cursor:
            try:
                cursor_id = UUID(cursor)
            except (TypeError, ValueError):
                raise ServiceError('TASK_CURSOR_INVALID', '分页游标无效', 400)
            cursor_task = ProjectTask.objects.filter(
                id=cursor_id,
                selected_agent_id=agent_id,
                project_id__in=member_project_ids,
            ).only('id', 'updated_at', 'created_at').first()
            if cursor_task is None:
                raise ServiceError('TASK_CURSOR_INVALID', '分页游标无效', 400)
            queryset = queryset.filter(
                Q(updated_at__lt=cursor_task.updated_at)
                | Q(
                    updated_at=cursor_task.updated_at,
                    created_at__lt=cursor_task.created_at,
                )
                | Q(
                    updated_at=cursor_task.updated_at,
                    created_at=cursor_task.created_at,
                    id__lt=cursor_task.id,
                )
            )

        page = list(queryset[: limit + 1])
        has_more = len(page) > limit
        page = page[:limit]

        tasks = []
        for task in page:
            item = self.serialize_task(task)
            item['project'] = {
                'id': str(task.project_id),
                'name': task.project.name,
            }
            tasks.append(item)

        return {
            'tasks': tasks,
            'next_cursor': str(page[-1].id) if has_more and page else None,
            'has_more': has_more,
        }

    def get_task(self, *, project_id: UUID, task_id: UUID) -> dict:
        return self.serialize_task(self._load_task(project_id, task_id), include_events=True)

    def _resolve_current_task_run(self, *, session_id: str) -> ProjectTaskRun:
        """从受认证的执行会话解析当前 Run；责任人双重校验（session user / run / task）。"""
        thread_id = (session_id or '').strip()
        if not thread_id:
            raise ServiceError('PROJECT_TASK_SESSION_REQUIRED', '缺少当前执行会话', 400)

        # CLI 的 TABTIN_THREAD_ID 可能是 runtime thread_id，也可能是
        # ``chat-session-<uuid>`` / 原始 session UUID；统一走既有解析约定。
        from django.core.exceptions import ValidationError

        from apps.chat.conversation.utils import resolve_chat_session

        try:
            session = resolve_chat_session(thread_id)
        except (ValueError, ValidationError):
            session = None
        if session is None:
            raise ServiceError('CHAT_SESSION_NOT_FOUND', '当前执行会话不存在', 404)
        if str(session.user_id) != str(self.user.id):
            raise ServiceError('PERMISSION_DENIED', '不能读取其他成员的执行会话', 403)

        run = ProjectTaskRun.objects.select_related('task', 'task__project', 'workspace').filter(
            chat_session_id=session.id,
        ).order_by('-created_at').first()
        if run is None:
            raise ServiceError(
                'PROJECT_TASK_SESSION_REQUIRED',
                '当前会话不是 Project Task 执行会话',
                400,
            )
        # Task 的当前责任人和 Run 的不可变责任人都必须是调用者。双重校验让
        # 转派、历史 Run 或异常数据都不能把另一人的工作面暴露给当前会话。
        if (
            str(run.responsible_user_id) != str(self.user.id)
            or str(run.task.responsible_user_id) != str(self.user.id)
        ):
            raise ServiceError('PERMISSION_DENIED', '只有 Task 责任人可以操作当前工作面', 403)
        return run

    def get_current_task_workbench(self, *, session_id: str) -> dict:
        """从受认证的执行会话推导当前 Task 的工作面，绝不接受客户端 Task ID。"""
        run = self._resolve_current_task_run(session_id=session_id)
        return self.get_task_workbench(
            project_id=run.task.project_id,
            task_id=run.task_id,
        )

    @transaction.atomic
    def create_blank_task_resource(
        self,
        *,
        session_id: str,
        resource_type: str,
        title: str = '',
    ) -> dict:
        """空白直建 TabDoc/TabData，并原子追加到当前 Run.result_items（ Task 6）。"""
        from apps.tabtinspace.services.project_task_results import (
            USER_BLANK_ORIGIN,
            normalize_resource_type,
        )
        from apps.tabtinspace.services.project_task_workbench_resources import (
            project_task_workbench_resources,
        )
        from apps.tabtinspace.services.resource_bridge import ResourceBridge

        run = self._resolve_current_task_run(session_id=session_id)
        # Task → Run 锁序与 start_run / cancel / finish 一致，避免反向死锁。
        task = ProjectTask.objects.select_for_update().select_related('project').get(
            id=run.task_id,
        )
        run = ProjectTaskRun.objects.select_for_update().select_related('workspace').get(
            id=run.id,
        )
        if (
            str(run.responsible_user_id) != str(self.user.id)
            or str(task.responsible_user_id) != str(self.user.id)
        ):
            raise ServiceError('PERMISSION_DENIED', '只有 Task 责任人可以创建任务资源', 403)

        normalized = normalize_resource_type(str(resource_type or ''))
        if normalized not in {'tabdoc', 'tabdata'}:
            raise ServiceError(
                'INVALID_RESOURCE_TYPE',
                '仅支持创建空白文档或多维表',
                400,
            )
        if task.work_status not in {
            ProjectTask.WorkStatus.IN_PROGRESS,
            ProjectTask.WorkStatus.IN_REVIEW,
        }:
            raise ServiceError(
                'TASK_NOT_EDITABLE',
                '当前任务状态不允许创建资源',
                409,
            )

        organization_id = str(task.project.organization_id)
        clean_title = (title or '').strip()

        try:
            if normalized == 'tabdoc':
                from apps.tabdoc.services.document_service import DocumentService

                resource = DocumentService(user=self.user).create_document(
                    organization_id=organization_id,
                    title=clean_title,
                )
                resource_id = str(resource.id)
                fallback_title = getattr(resource, 'title', None) or clean_title or '未命名文档'
            else:
                from apps.tabdata.services.table_service import TableService

                resource = TableService(user=self.user).create_table(
                    organization_id=task.project.organization_id,
                    name=clean_title or '未命名多维表',
                    use_default_fields=True,
                )
                if resource is None:
                    raise ServiceError('PERMISSION_DENIED', '没有权限创建多维表', 403)
                resource_id = str(resource.id)
                fallback_title = getattr(resource, 'name', None) or clean_title or '未命名多维表'
        except ServiceError:
            raise
        except PermissionError as exc:
            raise ServiceError('PERMISSION_DENIED', str(exc) or '没有权限创建资源', 403) from exc
        except Exception as exc:
            # EntitlementLimitExceeded 是 ValueError 子类，须先于通用 ValueError 识别。
            from apps.services.billing.services.entitlement_limits_service import (
                EntitlementLimitExceeded,
            )
            from apps.users.membership.exceptions import MembershipException

            if isinstance(exc, (MembershipException, EntitlementLimitExceeded)):
                raise ServiceError('QUOTA_EXCEEDED', str(exc) or '已超出资源配额', 409) from exc
            if isinstance(exc, ValueError):
                raise ServiceError('INVALID_RESOURCE', str(exc) or '创建资源失败', 400) from exc
            raise

        # DocumentService / TableService 经 on_commit 延迟 on_create；测试事务不提交，
        # 这里同步 upsert，保证 ContextItem 立即可投影。
        context_item = ResourceBridge.on_update(resource, user=self.user)
        if context_item is None:
            raise ServiceError('CONTEXT_ITEM_SYNC_FAILED', '资源索引同步失败', 500)

        snapshot = {
            'id': str(context_item.id),
            'context_item_id': str(context_item.id),
            'resource_type': normalized,
            'resource_id': resource_id,
            'item_type': context_item.item_type,
            'title': context_item.title or fallback_title,
            'preview': (context_item.preview or '')[:2000],
            'resource_space_id': str(
                context_item.space_id or run.workspace_id or ''
            ),
            'origin': USER_BLANK_ORIGIN,
        }

        existing = list(run.result_items or [])
        pointer = (normalized, resource_id)
        already = False
        for item in existing:
            if not isinstance(item, dict):
                continue
            item_type = normalize_resource_type(
                str(item.get('resource_type') or item.get('item_type') or ''),
            )
            item_id = str(item.get('resource_id') or '').strip()
            if (item_type, item_id) == pointer:
                already = True
                break
        if not already:
            existing.append(snapshot)
            run.result_items = existing
            run.save(update_fields=['result_items', 'updated_at'])

        resources = project_task_workbench_resources(
            task=task,
            user=self.user,
            latest_run=run,
            is_responsible=True,
        )
        for row in resources:
            if (
                row.get('resource_type') == normalized
                and str(row.get('resource_id') or '') == resource_id
            ):
                return row

        # 投影未命中时仍返回与 workbench resources[] 等价的公开字段。
        primary_pointer = None
        for raw in (run.result_items or []):
            if not isinstance(raw, dict):
                continue
            primary_pointer = (
                normalize_resource_type(
                    str(raw.get('resource_type') or raw.get('item_type') or ''),
                ),
                str(raw.get('resource_id') or '').strip(),
            )
            if primary_pointer[0] and primary_pointer[1]:
                break
            primary_pointer = None
        space_id = context_item.space_id or run.workspace_id
        fallback = {
            'context_item_id': str(context_item.id),
            'resource_type': normalized,
            'resource_id': resource_id,
            'title': context_item.title or fallback_title,
            'preview': context_item.preview or '',
            'summary': {},
            'organization_id': organization_id,
            'source': 'candidate',
            'task_run_id': str(run.id),
            'is_primary': pointer == primary_pointer,
            'can_open': True,
            'created_at': (
                context_item.created_at.isoformat()
                if getattr(context_item, 'created_at', None)
                else None
            ),
            'updated_at': (
                context_item.updated_at.isoformat()
                if getattr(context_item, 'updated_at', None)
                else None
            ),
            'last_visited_at': None,
        }
        if space_id:
            fallback['resource_space_id'] = str(space_id)
        return fallback

    def list_task_feedback(
        self,
        *,
        project_id: UUID,
        task_id: UUID,
        cursor: str = '',
        limit: int = 50,
    ) -> dict:
        """按不可变事件游标增量读取当前 Task 的公开人工评论。"""
        task = self._load_task(project_id, task_id)
        limit = max(1, min(limit, 100))
        comments = ProjectTaskEvent.objects.filter(
            task=task,
            event_type='comment',
            payload__visibility='project',
        ).order_by('created_at', 'id')

        cursor = (cursor or '').strip()
        if cursor:
            try:
                cursor_id = UUID(cursor)
            except (TypeError, ValueError):
                raise ServiceError('TASK_FEEDBACK_CURSOR_INVALID', '反馈游标无效', 400)
            cursor_event = comments.filter(id=cursor_id).only('id', 'created_at').first()
            if cursor_event is None:
                # 游标必须是本 Task 的公开评论，不能把其他 Task 的事件 ID 当作分页能力使用。
                raise ServiceError('TASK_FEEDBACK_CURSOR_INVALID', '反馈游标无效', 400)
            comments = comments.filter(
                Q(created_at__gt=cursor_event.created_at)
                | Q(created_at=cursor_event.created_at, id__gt=cursor_event.id)
            )

        page = list(comments[:limit + 1])
        has_more = len(page) > limit
        page = page[:limit]
        feedback = [
            {
                'id': str(event.id),
                'author': event.actor_name,
                'content': str((event.payload or {}).get('content') or ''),
                'created_at': event.created_at.isoformat(),
            }
            for event in page
        ]
        return {
            'feedback': feedback,
            'next_cursor': str(page[-1].id) if has_more and page else None,
            'has_more': has_more,
        }

    def get_task_workbench(self, *, project_id: UUID, task_id: UUID) -> dict:
        """返回给 Agent CLI 使用的脱敏 Task 工作面，不复用 Electron 详情 DTO。"""
        from apps.tabtinspace.services.project_task_workbench_resources import (
            project_task_workbench_resources,
        )

        task = self._load_task(project_id, task_id)
        is_responsible = str(task.responsible_user_id) == str(self.user.id)
        comments = [
            {
                'id': str(event.id),
                'author': event.actor_name,
                'content': str((event.payload or {}).get('content') or ''),
                'created_at': event.created_at.isoformat(),
            }
            for event in task.events.filter(event_type='comment').order_by('created_at', 'id')
        ]
        deliverables = [
            {
                'id': str(deliverable.id),
                'title': deliverable.context_item.title,
                'item_type': deliverable.context_item.item_type,
                'resource_id': deliverable.context_item.resource_id,
                'preview': deliverable.context_item.preview,
                'created_at': deliverable.created_at.isoformat(),
            }
            for deliverable in task.deliverables.select_related('context_item').all()
        ]
        latest_run = task.runs.select_related('workspace').first()
        workbench = {
            'project': {'id': str(task.project_id), 'name': task.project.name},
            'task': {
                'id': str(task.id),
                'title': task.title,
                'description': task.description,
                'status': task.work_status,
                'version': task.version,
                'responsible_user': self._serialize_user(task.responsible_user),
            },
            'feedback': comments,
            'deliverables': deliverables,
            'policy': {
                'may_modify_primary': is_responsible and task.work_status in {
                    ProjectTask.WorkStatus.IN_PROGRESS,
                    ProjectTask.WorkStatus.IN_REVIEW,
                },
                'may_present_delivery': is_responsible and task.work_status in {
                    ProjectTask.WorkStatus.IN_PROGRESS,
                    ProjectTask.WorkStatus.IN_REVIEW,
                },
                'may_accept_or_publish': False,
            },
            # ：移动端 Task App 首页消费；additive，不改 CLI 既有字段。
            'resources': project_task_workbench_resources(
                task=task,
                user=self.user,
                latest_run=latest_run,
                is_responsible=is_responsible,
            ),
        }
        if not is_responsible:
            return workbench

        if latest_run is None:
            workbench['run'] = None
            workbench['primary_artifact'] = None
            return workbench

        safe_items = [
            {
                key: item[key]
                for key in (
                    'resource_type', 'resource_id', 'resource_space_id', 'title',
                    'item_type', 'preview_url', 'mime_type',
                )
                if key in item
            }
            for item in (latest_run.result_items or [])
            if isinstance(item, dict)
            and item.get('resource_type')
            and item.get('resource_id')
        ]
        workbench['run'] = {
            'id': str(latest_run.id),
            'status': latest_run.status,
            'workspace_id': str(latest_run.workspace_id),
            'result_summary': latest_run.result_summary,
            'artifacts': safe_items,
        }
        workbench['primary_artifact'] = next(iter(safe_items), None)
        return workbench

    @transaction.atomic
    def add_comment(self, *, project_id: UUID, task_id: UUID, content: str) -> dict:
        """追加一条所有 Project 成员可见的人工评论，不改变任务状态。"""
        task = self._load_task(project_id, task_id, for_update=True)
        clean_content = (content or '').strip()
        if not clean_content:
            raise ServiceError('TASK_COMMENT_REQUIRED', '评论不能为空', 400)
        if len(clean_content) > 4000:
            raise ServiceError('TASK_COMMENT_TOO_LONG', '评论最多 4000 个字符', 400)

        # 评论也是不可变时间线事件：既能与状态记录按时间统一呈现，也为后续 Agent
        # 提供明确、可审计的协作上下文。payload 保持结构化，避免 AI 只能解析展示文案。
        self._event(task, self.user, 'comment', {
            'content': clean_content,
            'content_format': 'plain_text',
            'visibility': 'project',
            'source': 'human',
        })
        # 不改变业务状态，但让看板排序、刷新和后续同步能感知到新的协作上下文。
        task.version += 1
        task.save(update_fields=['version', 'updated_at'])
        schedule_project_task_invalidation(task, 'comment')
        return self.serialize_task(self._load_task(project_id, task_id), include_events=True)

    @transaction.atomic
    def create_task(
        self,
        *,
        project_id: UUID,
        title: str,
        description: str = '',
        priority: str = ProjectTask.Priority.MEDIUM,
        responsible_user_id: UUID,
    ) -> dict:
        project = self._load_project(project_id)
        clean_title = (title or '').strip()
        if not clean_title:
            raise ServiceError('TASK_TITLE_REQUIRED', '任务标题不能为空', 400)
        if priority not in ProjectTask.Priority.values:
            raise ServiceError('TASK_PRIORITY_INVALID', '任务优先级不合法', 400)
        responsible_user = self._load_member(project, responsible_user_id)
        self_assigned = str(responsible_user.id) == str(self.user.id)
        task = ProjectTask.objects.create(
            project=project,
            title=clean_title,
            description=(description or '').strip(),
            priority=priority,
            created_by=self.user,
            responsible_user=responsible_user,
            assignment_status=(
                ProjectTask.AssignmentStatus.ACCEPTED
                if self_assigned else ProjectTask.AssignmentStatus.PENDING
            ),
        )
        created_payload = {
            'title': task.title,
            'description': task.description,
            'priority': task.priority,
            'responsible_user_id': str(responsible_user.id),
            'responsible_user_name': resolve_user_display_name(responsible_user),
            'assignment_status': task.assignment_status,
            'self_assigned': self_assigned,
        }
        self._event(task, self.user, 'created', created_payload)
        self._activity(task, self.user, SpaceActivityEvent.EventType.TASK_CREATED, created_payload)
        schedule_project_task_invalidation(task, 'created')
        return self.serialize_task(self._load_task(project.id, task.id))

    @transaction.atomic
    def create_tasks(self, *, project_id: UUID, task_specs: list[dict[str, Any]]) -> list[dict]:
        """原子创建一组 AI 编排任务；任一任务不合法时整批回滚。"""
        if not task_specs:
            raise ServiceError('TASK_BATCH_EMPTY', '至少需要创建一项任务', 400)
        if len(task_specs) > 20:
            raise ServiceError('TASK_BATCH_TOO_LARGE', '单次最多创建 20 项任务', 400)

        self._load_project(project_id)
        return [
            self.create_task(
                project_id=project_id,
                title=spec.get('title', ''),
                description=spec.get('description', ''),
                priority=spec.get('priority', ProjectTask.Priority.MEDIUM),
                responsible_user_id=spec.get('responsible_user_id'),
            )
            for spec in task_specs
        ]

    @transaction.atomic
    def respond_assignment(self, *, project_id: UUID, task_id: UUID, accept: bool) -> dict:
        task = self._load_task(project_id, task_id, for_update=True)
        if str(task.responsible_user_id) != str(self.user.id):
            raise ServiceError('TASK_RESPONSIBLE_ONLY', '只有当前责任人可以响应指派', 403)
        if task.assignment_status != ProjectTask.AssignmentStatus.PENDING:
            raise ServiceError('TASK_ASSIGNMENT_ALREADY_RESPONDED', '这次指派已经响应', 409)
        task.assignment_status = (
            ProjectTask.AssignmentStatus.ACCEPTED
            if accept else ProjectTask.AssignmentStatus.REJECTED
        )
        task.selected_agent = None
        task.project_member_workspace = None
        task.workspace_confirmed_at = None
        task.version += 1
        task.save(update_fields=[
            'assignment_status', 'selected_agent', 'project_member_workspace',
            'workspace_confirmed_at', 'version', 'updated_at',
        ])
        event_type = 'assignment_accepted' if accept else 'assignment_rejected'
        activity_type = (
            SpaceActivityEvent.EventType.TASK_ACCEPTED
            if accept else SpaceActivityEvent.EventType.TASK_REJECTED
        )
        self._event(task, self.user, event_type)
        self._activity(task, self.user, activity_type)
        schedule_project_task_invalidation(task, event_type)
        return self.serialize_task(self._load_task(project_id, task_id))

    @transaction.atomic
    def configure_execution(
        self,
        *,
        project_id: UUID,
        task_id: UUID,
        agent_id: UUID,
        workspace_id: UUID,
    ) -> dict:
        task = self._load_task(project_id, task_id, for_update=True)
        if str(task.responsible_user_id) != str(self.user.id):
            raise ServiceError('TASK_RESPONSIBLE_ONLY', '只有当前责任人可以选择执行配置', 403)
        if task.assignment_status != ProjectTask.AssignmentStatus.ACCEPTED:
            raise ServiceError('TASK_NOT_ACCEPTED', '请先接受任务再选择执行配置', 409)
        agent = Agent.objects.filter(
            id=agent_id,
            organization_id=task.project.organization_id,
            owner_user_id=self.user.id,
            is_active=True,
        ).first()
        # 终态：Project 不再持 Agent-scope membership；成员可用自己拥有的任意 Agent 执行任务。
        if agent is None:
            raise ServiceError('TASK_AGENT_INVALID', '只能选择自己拥有的 Agent', 400)

        # 责任人显式选择自己拥有的 Workspace；可改绑当前 Project 的伴生关联（非静默借用）。
        from apps.tabtinspace.models import Workspace
        from apps.tabtinspace.services.membership_utils import ensure_user_membership

        workspace = (
            Workspace.objects
            .select_related('device')
            .filter(
                id=workspace_id,
                organization_id=task.project.organization_id,
                created_by_id=self.user.id,
            )
            .first()
        )
        if workspace is None:
            raise ServiceError('TASK_WORKSPACE_INVALID', '只能选择自己拥有的 Workspace', 400)

        workspace_link = ProjectMemberWorkspace.objects.select_related('workspace').filter(
            project=task.project,
            user=self.user,
        ).first()
        if workspace_link is None:
            workspace_link = ProjectMemberWorkspace.objects.create(
                project=task.project,
                user=self.user,
                workspace=workspace,
            )
        elif workspace_link.workspace_id != workspace.id:
            workspace_link.workspace = workspace
            workspace_link.save(update_fields=['workspace', 'updated_at'])
            workspace_link = (
                ProjectMemberWorkspace.objects
                .select_related('workspace')
                .get(id=workspace_link.id)
            )
        ensure_user_membership(workspace, self.user.id, 'owner')

        task.selected_agent = agent
        task.project_member_workspace = workspace_link
        task.workspace_confirmed_at = timezone.now()
        task.version += 1
        task.save(update_fields=[
            'selected_agent', 'project_member_workspace', 'workspace_confirmed_at',
            'version', 'updated_at',
        ])
        execution_payload = {
            'agent_id': str(agent.id),
            'agent_name': agent.name,
            'workspace_id': str(workspace_link.workspace_id),
            'workspace_name': workspace_link.workspace.name,
        }
        self._event(task, self.user, 'execution_configured', execution_payload)
        self._activity(
            task,
            self.user,
            SpaceActivityEvent.EventType.TASK_EXECUTION_CONFIGURED,
            execution_payload,
        )
        schedule_project_task_invalidation(task, 'execution_configured')
        return self.serialize_task(self._load_task(project_id, task_id))

    _ACTIVE_RUN_STATUSES = (
        ProjectTaskRun.Status.PREPARING,
        ProjectTaskRun.Status.PENDING,
        ProjectTaskRun.Status.RUNNING,
    )

    def _assert_can_prepare_or_start(self, task: ProjectTask) -> None:
        if str(task.responsible_user_id) != str(self.user.id):
            raise ServiceError('TASK_RESPONSIBLE_ONLY', '只有当前责任人可以准备或启动执行', 403)
        if task.assignment_status != ProjectTask.AssignmentStatus.ACCEPTED:
            raise ServiceError('TASK_NOT_ACCEPTED', '请先接受任务再启动执行', 409)
        if not task.selected_agent_id or not task.project_member_workspace_id or not task.workspace_confirmed_at:
            raise ServiceError('TASK_EXECUTION_NOT_READY', '请先确认 Agent 与自己的 Project Workspace', 409)
        # 过程态（含存量 in_review）在无活跃 Run 时可继续准备 / 再开一轮。
        if task.work_status not in [
            ProjectTask.WorkStatus.TODO,
            ProjectTask.WorkStatus.BLOCKED,
            ProjectTask.WorkStatus.IN_PROGRESS,
            ProjectTask.WorkStatus.IN_REVIEW,
        ]:
            raise ServiceError('TASK_RUN_STATUS_INVALID', '当前任务状态不能启动或重跑', 409)

    def _create_preparing_run(self, task: ProjectTask) -> ProjectTaskRun:
        from apps.tabtinspace.services.project_task_runtime import create_execution_session

        workspace = task.project_member_workspace.workspace
        device = workspace.device
        if device.control_status != 'active' or device.status not in ['online', 'busy']:
            raise ServiceError('TASK_DEVICE_OFFLINE', '执行设备当前不可用，请上线后再试', 409)
        if ProjectTaskRun.objects.filter(task=task, status__in=self._ACTIVE_RUN_STATUSES).exists():
            raise ServiceError('TASK_RUN_ALREADY_ACTIVE', '任务已经在执行中', 409)

        previous_run = task.runs.first()
        run = ProjectTaskRun.objects.create(
            task=task,
            status=ProjectTaskRun.Status.PREPARING,
            rerun_of=previous_run if previous_run and previous_run.status == ProjectTaskRun.Status.FAILED else None,
            responsible_user=self.user,
            agent=task.selected_agent,
            workspace=workspace,
            device=device,
            binding_snapshot={
                'responsible_user_id': str(self.user.id),
                'responsible_user_name': resolve_user_display_name(self.user),
                'agent_id': str(task.selected_agent_id),
                'agent_name': task.selected_agent.name,
                'workspace_id': str(workspace.id),
                'workspace_name': workspace.name,
                'device_id': str(device.id),
                'device_name': device.name,
            },
        )
        create_execution_session(run)
        self._event(task, self.user, 'run_prepared', {
            'run_id': str(run.id),
            'chat_session_id': str(run.chat_session_id) if run.chat_session_id else None,
        })
        return run

    @transaction.atomic
    def prepare_run(self, *, project_id: UUID, task_id: UUID) -> dict:
        """创建准备中的执行与会话，供责任人补充上下文；此时不派发 Agent。"""
        task = self._load_task(project_id, task_id, for_update=True)
        self._assert_can_prepare_or_start(task)

        preparing = task.runs.filter(status=ProjectTaskRun.Status.PREPARING).select_related(
            'chat_session',
        ).first()
        if preparing is None:
            preparing = self._create_preparing_run(task)
        elif preparing.chat_session_id is None:
            from apps.tabtinspace.services.project_task_runtime import create_execution_session
            create_execution_session(preparing)

        return {
            'task': self.serialize_task(self._load_task(project_id, task_id)),
            'run': self.serialize_run(preparing),
        }

    @transaction.atomic
    def start_run(
        self,
        *,
        project_id: UUID,
        task_id: UUID,
        message: str = '',
        attachments: list | None = None,
    ) -> dict:
        """正式开跑：若尚无准备中会话则自动创建，并把责任人补充（文字/附件）写入对话。"""
        from apps.tabtinspace.services.project_task_runtime import (
            append_kickoff_message,
            normalize_kickoff_attachments,
        )

        task = self._load_task(project_id, task_id, for_update=True)
        self._assert_can_prepare_or_start(task)

        if ProjectTaskRun.objects.filter(
            task=task,
            status__in=[ProjectTaskRun.Status.PENDING, ProjectTaskRun.Status.RUNNING],
        ).exists():
            raise ServiceError('TASK_RUN_ALREADY_ACTIVE', '任务已经在执行中', 409)

        run = task.runs.filter(status=ProjectTaskRun.Status.PREPARING).select_related(
            'chat_session',
        ).first()
        if run is None:
            run = self._create_preparing_run(task)
        elif run.chat_session_id is None:
            from apps.tabtinspace.services.project_task_runtime import create_execution_session
            create_execution_session(run)

        kickoff_attachments = normalize_kickoff_attachments(attachments)
        kickoff = (message or '').strip()
        append_kickoff_message(
            run.chat_session,
            user=self.user,
            message=kickoff,
            attachments=kickoff_attachments,
            task_id=str(task.id),
            run_id=str(run.id),
        )
        if kickoff_attachments:
            snapshot = dict(run.binding_snapshot or {})
            snapshot['kickoff_attachments'] = kickoff_attachments
            run.binding_snapshot = snapshot

        run.status = ProjectTaskRun.Status.PENDING
        run.save(update_fields=['status', 'binding_snapshot', 'updated_at'] if kickoff_attachments else ['status', 'updated_at'])
        task.work_status = ProjectTask.WorkStatus.IN_PROGRESS
        task.version += 1
        task.save(update_fields=['work_status', 'version', 'updated_at'])
        self._event(task, self.user, 'run_started', {
            'run_id': str(run.id),
            'chat_session_id': str(run.chat_session_id) if run.chat_session_id else None,
            'has_kickoff_message': bool(kickoff),
            'attachment_count': len(kickoff_attachments),
        })
        schedule_project_task_invalidation(task, 'run_started')
        # 团队动态中的 Agent run 生命周期由 relay_trace_writer 以真实 runtime
        # trace 为唯一来源。这里仅写 Task 自己的不可变业务事件；若再写一条
        # agent_run_started，用户会在动态流看到“发起 Agent 任务”两次。

        def enqueue() -> None:
            from apps.tabtinspace.tasks import execute_project_task_run
            try:
                execute_project_task_run.delay(str(run.id))
            except Exception:
                from apps.tabtinspace.services.project_task_runtime import (
                    fail_project_task_run_dispatch,
                )
                fail_project_task_run_dispatch(str(run.id))

        transaction.on_commit(enqueue, robust=True)
        return {
            'task': self.serialize_task(self._load_task(project_id, task_id)),
            'run': self.serialize_run(run),
        }

    @transaction.atomic
    def set_result_visibility(
        self,
        *,
        project_id: UUID,
        task_id: UUID,
        result_visibility: str,
    ) -> dict:
        """责任人调整完成前结果预览可见性；不改变 work_status。

        ：此开关已**降级**——未完成任务上，同 Project 有效成员默认即可读候选
        产物（见 ``serialize_task`` / ``project_task_preview_access``），
        ``project_preview`` 不再是打开候选 TabDoc 正文的必要条件。保留该 API 仅用于
        向后兼容与已完成任务等旁支场景，不再作为读中间产物的门槛。
        """
        task = self._load_task(project_id, task_id, for_update=True)
        if str(task.responsible_user_id) != str(self.user.id):
            raise ServiceError('TASK_RESPONSIBLE_ONLY', '只有当前责任人可以调整结果可见性', 403)
        if result_visibility not in ProjectTask.ResultVisibility.values:
            raise ServiceError('TASK_RESULT_VISIBILITY_INVALID', '结果可见性不合法', 400)
        if task.result_visibility == result_visibility:
            return self.serialize_task(task, include_events=True)

        previous = task.result_visibility
        task.result_visibility = result_visibility
        task.version += 1
        task.save(update_fields=['result_visibility', 'version', 'updated_at'])
        self._event(task, self.user, 'result_visibility_changed', {
            'from': previous,
            'to': result_visibility,
            'result_visibility': result_visibility,
        })
        self._activity(
            task,
            self.user,
            SpaceActivityEvent.EventType.TASK_RESULT_PREVIEW_CHANGED,
            {
                'from': previous,
                'to': result_visibility,
                'result_visibility': result_visibility,
            },
        )
        schedule_project_task_invalidation(task, 'result_visibility_changed')
        return self.serialize_task(self._load_task(project_id, task_id), include_events=True)

    @transaction.atomic
    def cancel_task(self, *, project_id: UUID, task_id: UUID) -> dict:
        """由责任人终止未完成任务，并取消仍在运行的 Agent 执行。"""
        task = self._load_task(project_id, task_id)
        if str(task.responsible_user_id) != str(self.user.id):
            raise ServiceError('TASK_RESPONSIBLE_ONLY', '只有当前责任人可以取消任务', 403)

        # 所有 Task/Run 状态命令统一先锁 Task、再锁 Run。这样与 start_run 的
        # Task 锁串行，取消不会漏掉另一事务刚创建但尚未提交的 active Run。
        task = ProjectTask.objects.select_for_update().get(id=task.id)
        if task.work_status == ProjectTask.WorkStatus.CANCELLED:
            return self.serialize_task(task, include_events=True)
        if task.work_status == ProjectTask.WorkStatus.DONE:
            raise ServiceError('TASK_ALREADY_DONE', '已完成的任务不能取消', 409)

        active_run = task.runs.select_for_update().filter(
            status__in=[
                ProjectTaskRun.Status.PREPARING,
                ProjectTaskRun.Status.PENDING,
                ProjectTaskRun.Status.RUNNING,
            ],
        ).first()
        if active_run is not None:
            active_run.status = ProjectTaskRun.Status.CANCELLED
            active_run.ended_at = timezone.now()
            active_run.save(update_fields=['status', 'ended_at', 'updated_at'])

        task.work_status = ProjectTask.WorkStatus.CANCELLED
        task.version += 1
        task.save(update_fields=['work_status', 'version', 'updated_at'])
        self._event(task, self.user, 'task_cancelled', {
            'run_id': str(active_run.id) if active_run else None,
        })
        schedule_project_task_invalidation(task, 'task_cancelled')
        return self.serialize_task(
            self._load_task(project_id, task_id),
            include_events=True,
        )

    @transaction.atomic
    def accept_result(
        self,
        *,
        project_id: UUID,
        task_id: UUID,
        result_summary: str = '',
        deliverable_title: str = '',
        result_item_ids: list[UUID] | None = None,
    ) -> dict:
        """责任人确认完成，并将摘要与选中的云端交付物发布到 Project。"""
        task = self._load_task(project_id, task_id, for_update=True)
        if str(task.responsible_user_id) != str(self.user.id):
            raise ServiceError('TASK_RESPONSIBLE_ONLY', '只有当前责任人可以完成任务', 403)
        # in_review 仅兼容存量；主路径为 in_progress + 已完成 Run。
        if task.work_status not in {
            ProjectTask.WorkStatus.IN_PROGRESS,
            ProjectTask.WorkStatus.IN_REVIEW,
        }:
            raise ServiceError('TASK_NOT_IN_REVIEW', '当前任务还不能标记完成', 409)
        if ProjectTaskRun.objects.filter(task=task, status__in=self._ACTIVE_RUN_STATUSES).exists():
            raise ServiceError(
                'TASK_RUN_ALREADY_ACTIVE',
                '当前还有进行中的执行，请先结束或取消后再标记完成',
                409,
            )
        run = task.runs.filter(status=ProjectTaskRun.Status.COMPLETED).first()
        if run is None:
            raise ServiceError('TASK_RUN_NOT_COMPLETED', '没有可完成的执行结果', 409)

        summary = (result_summary or run.result_summary or '').strip()
        if not summary:
            raise ServiceError('TASK_RESULT_REQUIRED', '完成摘要不能为空', 400)
        title = (deliverable_title or f'{task.title} · 交付结果').strip()[:255]
        # 终态：Project 资产直挂 :class:`Project`（``project`` FK）。
        item = ContextItem.objects.create(
            project=task.project,
            item_type='team_asset',
            title=title,
            preview=summary[:2000],
            status='active',
            resource_id=f'project_task_run:{run.id}',
            metadata={
                'asset_kind': 'task_deliverable',
                'asset_source': {
                    'kind': 'ai_deliverable',
                    'task_id': str(task.id),
                    'task_run_id': str(run.id),
                    'chat_session_id': str(run.chat_session_id) if run.chat_session_id else None,
                },
            },
            created_by=self.user,
            updated_by=self.user,
        )
        ProjectTaskDeliverable.objects.create(
            task=task,
            task_run=run,
            context_item=item,
            published_by=self.user,
        )
        published_items = self._publish_result_items(
            task=task,
            run=run,
            result_item_ids=result_item_ids,
        )
        task.result_summary = summary
        task.work_status = ProjectTask.WorkStatus.DONE
        task.version += 1
        task.save(update_fields=['result_summary', 'work_status', 'version', 'updated_at'])
        self._event(task, self.user, 'result_accepted', {
            'run_id': str(run.id),
            'context_item_id': str(item.id),
            'published_context_item_ids': [str(asset.id) for asset in published_items],
        })
        self._activity(
            task,
            self.user,
            SpaceActivityEvent.EventType.TASK_COMPLETED,
            {'run_id': str(run.id), 'context_item_id': str(item.id)},
        )
        schedule_project_task_invalidation(task, 'result_accepted')
        transaction.on_commit(lambda: self._publish_deliverable_activity(task, item))
        for published_item in published_items:
            transaction.on_commit(
                lambda asset=published_item: self._publish_deliverable_activity(task, asset)
            )
        return self.serialize_task(self._load_task(project_id, task_id), include_events=True)

    def _publish_result_items(
        self,
        *,
        task: ProjectTask,
        run: ProjectTaskRun,
        result_item_ids: list[UUID] | None,
    ) -> list[ContextItem]:
        candidates = run.result_items if isinstance(run.result_items, list) else []
        candidates_by_id = {
            str(candidate.get('id')): candidate
            for candidate in candidates
            if isinstance(candidate, dict) and candidate.get('id')
        }
        selected_ids = (
            []
            if result_item_ids is None
            else [str(candidate_id) for candidate_id in result_item_ids]
        )
        unknown_ids = [candidate_id for candidate_id in selected_ids if candidate_id not in candidates_by_id]
        if unknown_ids:
            raise ServiceError(
                'TASK_RESULT_ITEM_INVALID',
                '执行结果包含无效或不属于本次执行的交付物',
                400,
            )
        if not selected_ids:
            return []

        from apps.tabtinspace.services.project_task_results import execution_source_item_q

        source_items = {
            str(source.id): source
            for source in ContextItem.objects.filter(
                execution_source_item_q(run),
                id__in=selected_ids,
                is_archived=False,
                trashed_at__isnull=True,
            )
        }
        if len(source_items) != len(set(selected_ids)):
            raise ServiceError(
                'TASK_RESULT_ITEM_UNAVAILABLE',
                '部分交付物已不存在或不属于本次执行现场',
                409,
            )

        published: list[ContextItem] = []
        for source_id in dict.fromkeys(selected_ids):
            source = source_items[source_id]
            metadata = dict(source.metadata or {})
            metadata['asset_kind'] = (
                'tabdoc' if source.item_type == 'tabdoc'
                else metadata.get('asset_kind') or source.item_type
            )
            metadata['asset_source'] = {
                'kind': 'task_deliverable',
                'task_id': str(task.id),
                'task_run_id': str(run.id),
                'source_context_item_id': str(source.id),
                'member_user_id': str(run.responsible_user_id),
            }
            if source.item_type == 'tabdoc':
                from apps.tabdoc.models import Document, DocumentPermission, DocumentShare
                from apps.tabdoc.services.document_service import DocumentService

                # ：新建 TabDoc 可为 org-only（space_id 空），仍属本次执行组织。
                document = Document.objects.select_for_update().filter(
                    id=source.resource_id,
                    organization_id=task.project.organization_id,
                    trashed_at__isnull=True,
                ).filter(
                    Q(space_id=run.workspace_id) | Q(space_id__isnull=True),
                ).first()
                if document is None:
                    raise ServiceError(
                        'TASK_RESULT_DOCUMENT_UNAVAILABLE',
                        '在线文档已不存在或不属于本次执行现场',
                        409,
                    )
                # 发布会改宿主、owner 与 ACL，必须具备文档管理权限；同组织成员
                # 身份本身不足以提升他人的 org-only 文档。
                if not DocumentService(user=self.user).check_document_permission(
                    document,
                    required_role='admin',
                ):
                    raise ServiceError(
                        'TASK_RESULT_DOCUMENT_FORBIDDEN',
                        '没有权限将这篇在线文档发布到 Project',
                        403,
                    )
                # TabDoc 权限回退到 document.space；发布时将同一份文档提升到
                # Project，所有生效 Project 成员即可按其成员角色协作编辑。
                document.space_id = task.project_id
                # Project 是协作宿主而非某位成员的私有资产。清空原 owner，避免
                # 责任人在离开 Project 后仍通过 owner 直通权限继续访问。
                document.owner_id = None
                document.is_private = False
                document.updated_by = self.user
                document.save(update_fields=[
                    'space_id', 'owner_id', 'is_private', 'updated_by', 'updated_at',
                ])
                # 已有公开/组织分享链接是独立于 DocumentPermission 的访问通道，
                # 发布到 Project 时也必须一并失效，不能把私有草稿的链接带入。
                DocumentShare.objects.filter(document=document, is_active=True).update(is_active=False)
                project_roles = {
                    'owner': 'admin',
                    'admin': 'admin',
                    'editor': 'editor',
                    'viewer': 'viewer',
                }
                # 提升为 Project 交付物后，旧 Workspace 的指定用户 / Agent / 非标准
                # 角色授权不得继续生效，否则非 Project 成员仍能打开原私有文档。
                DocumentPermission.objects.filter(document=document, is_active=True).exclude(
                    subject_type='role',
                    subject_id__in=project_roles,
                ).update(is_active=False)
                for project_role, permission in project_roles.items():
                    updated = DocumentPermission.objects.filter(
                        document=document,
                        subject_type='role',
                        subject_id=project_role,
                        is_active=True,
                    ).update(permission=permission, granted_by=str(self.user.id))
                    if not updated:
                        DocumentPermission.objects.create(
                            document=document,
                            subject_type='role',
                            subject_id=project_role,
                            permission=permission,
                            is_active=True,
                            created_by=self.user,
                            granted_by=str(self.user.id),
                        )
                # org-only → Project 时必须清 organization，满足宿主互斥约束。
                source.workspace = None
                source.organization = None
                source.project = task.project
                source.metadata = metadata
                source.updated_by = self.user
                source.save(update_fields=[
                    'workspace', 'organization', 'project', 'metadata', 'updated_by', 'updated_at',
                ])
                project_item = source
            else:
                project_item = ContextItem.objects.create(
                    project=task.project,
                    item_type=source.item_type,
                    title=source.title,
                    preview=source.preview,
                    status=source.status or 'active',
                    resource_id=source.resource_id,
                    metadata=metadata,
                    created_by=self.user,
                    updated_by=self.user,
                )
            ProjectTaskDeliverable.objects.create(
                task=task,
                task_run=run,
                context_item=project_item,
                published_by=self.user,
            )
            published.append(project_item)
        return published

    @staticmethod
    def _publish_deliverable_activity(task: ProjectTask, item: ContextItem) -> None:
        from apps.tabtinspace.services.resource_bridge import ResourceBridge

        ResourceBridge._update_search_vector(item.id)
        record_team_space_activity(
            task.project,
            SpaceActivityEvent.EventType.ASSET_CREATED,
            actor_user=item.created_by,
            target_type='asset',
            target_id=str(item.id),
            target_name=item.title,
            metadata={
                'asset_kind': item.metadata.get('asset_kind', 'task_deliverable'),
                'task_id': str(task.id),
            },
        )


__all__ = ['ProjectTaskService']
