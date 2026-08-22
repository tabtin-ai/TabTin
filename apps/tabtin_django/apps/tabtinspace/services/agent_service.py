"""
AgentService - Agent 身份/能力/配置的 CRUD

Agent 是身份/能力/配置的 SSOT（Single Source of Truth）：
- 身份：name, owner_user, custom_rules
- 能力配置：agent_config、preferred_model_id、suggested_prompts
- 执行设备、目录、信任与审批归 Workspace，不在 Agent 双写
"""
import copy
import logging
from typing import Optional, Dict, Any, List, Tuple
from uuid import UUID
from django.db import IntegrityError, models, transaction
from django.db.models.deletion import ProtectedError
from django.utils import timezone

from apps.agent.models import Agent
from apps.services.common.agent_avatar_registry import is_builtin_agent_avatar_key
from apps.services.common.device_capability_registry import DEVICE_RUNTIME_TYPES, is_user_level_device
from apps.tabtinspace.models import Collection, Device, Workspace, Organization
from apps.tabtinspace.memory_defaults import (
    MEMORY_DEFAULTS_V2 as _MEMORY_DEFAULTS,
    VALID_OBSERVER_MODES as _VALID_OBSERVER_MODES,
    VALID_SESSION_SUMMARIZATION_STRATEGIES as _VALID_SS_STRATEGIES,
)
from apps.tabtinspace.agent_config_v2 import (
    V2_SCHEMA_VERSION,
    build_default_agent_config_v2,
    migrate_v1_to_v2,
)
from apps.services.common.db_router import postgres_app_db_alias
from .base import BaseService
from apps.tabtinspace.services.space_sync import publish_space_list_change

_logger = logging.getLogger(__name__)

# Wave 1-B：workspace 创建时自动预置的「规划」Collection 配置。
# Plan 模式产出的文档将归属于此 Collection（W1-C / W2-A 实现）。
#
# - i18n：当前硬编码中文，英文环境用户会看到「规划」而非 "Planning"。
#   方案 A 选定原因：Collection.name 是 CharField 无 i18n 字段，落库后
#   语言切换不会跟随，creator locale 路径在多成员多语言协作下仍不一致；
#   后续 Wave 若要做需引入 Collection 模型层的 i18n 字段或 slug+展示名分离。
# - 同名常量在 migration 0041/0042 中重复定义；migration 自包含原则不允许
#   import 业务模块，需在新增/修改时同步更新两处。
_PLANNING_COLLECTION_SYSTEM_KEY = "planning_root"
_PLANNING_COLLECTION_NAME = "规划"
_PLANNING_COLLECTION_ICON = "📋"
_PLANNING_COLLECTION_ORDER = 0

MAX_CUSTOM_BOT_AGENTS = 5


class AgentService(BaseService):
    """Agent CRUD 服务"""

    VALID_PRESETS = {'cautious', 'collaborative', 'full_auto'}
    VALID_CATEGORIES = {'read', 'write', 'install', 'delete_system', 'script'}
    VALID_ACTIONS = {'auto', 'confirm'}
    VALID_AGENT_BACKEND_TYPES = {'builtin'}
    CURRENT_BACKEND_CONFIG_VERSION = V2_SCHEMA_VERSION
    _DEPRECATED_BACKEND_FIELDS = {'execution_mode', 'legacy_mode', 'skip_permissions'}

    VALID_RUNTIME_PLANES = {'local', 'cloud'}
    VALID_COMMAND_EXECUTION = {'sandboxed', 'regular', 'blocked'}
    VALID_TERMINAL_MODES = {'tabtin_only', 'sandboxed', 'regular', 'blocked'}
    VALID_SANDBOX_LEVEL = {'filesystem', 'complete'}
    VALID_FILE_ACCESS = {'workspace', 'organization', 'strict', 'custom'}
    VALID_NETWORK_MODE = {'allowed', 'blocked', 'custom'}
    VALID_SWITCH_ACTIONS = {'allow', 'confirm', 'block'}
    VALID_SQL_MODES = {'read_only', 'read_write', 'blocked'}
    VALID_OPERATION_SWITCH_KEYS = {
        'git_read', 'git_push', 'git_destructive', 'rm', 'mv',
        'db_write', 'db_schema', 'package_install',
        'curl_read', 'curl_mutate', 'docker', 'kubectl', 'ssh',
    }
    VALID_DEVICE_PERMISSION_KEYS = {
        'read_contacts', 'read_sms', 'send_sms', 'read_calendar',
        'get_location', 'read_media', 'screen_capture', 'screen_tap',
        'launch_app', 'set_system',
    }

    MEMORY_DEFAULTS = _MEMORY_DEFAULTS
    VALID_OBSERVER_MODES = _VALID_OBSERVER_MODES
    VALID_SESSION_SUMMARIZATION_STRATEGIES = _VALID_SS_STRATEGIES

    # ── v2 形状 SSoT（W2.1.0 决议 §2）─────────────────────────────────
    # DEFAULT_AGENT_CONFIG 由 build_default_agent_config_v2 构造，保证：
    #   - schema_version=2 / runtime_plane=local / capabilities.overrides 7 分组
    #   - conversation.cross_turn_memory + max_history_messages
    #   - agent_backend.type=builtin（VALID_AGENT_BACKEND_TYPES）
    #   - 顶层 workspace_root + git_status
    #   - **不带** memory（D2 / 由 TabMemo 后续专题处理）
    # 调用方应把它当不可变模板：每次 prepare 用 deepcopy。
    DEFAULT_AGENT_CONFIG = build_default_agent_config_v2()

    def get_agent(self, agent_id: UUID) -> Optional[Agent]:
        agent = Agent.objects.filter(id=agent_id).first()
        if not agent:
            return None
        if not self.check_agent_owner(agent):
            return None
        return agent

    def _prepare_agent_creation(
        self,
        organization_id: UUID,
        name: str,
        agent_type: str = 'bot',
        *,
        custom_rules: Optional[str] = None,
        goal: Optional[str] = None,
        agent_config: Optional[Dict[str, Any]] = None,
        template_id: Optional[str] = None,
        avatar_key: Optional[str] = None,
        raise_on_error: bool = False,
        system_provisioning: bool = False,
    ) -> Optional[Dict[str, Any]]:
        """准备 Agent 创建所需的全部字段。

        包含：权限检查、Organization 查询、设备绑定、
        配置构建（DEFAULT_AGENT_CONFIG → MEMORY_DEFAULTS → agent_config merge）。

        Args:
            raise_on_error: True 时权限/查询失败抛 ServiceError；False 时返回 None。
            system_provisioning: 仅供服务端首发阵容补建。列表接口允许 viewer，
                但系统仍需为该用户创建其私有模板 Agent；外部创建路径不得传入。

        Returns:
            用于 Agent.objects.create(**result) 的字典，或 None（raise_on_error=False 时失败）。
        """
        from .base import ServiceError

        if agent_type != 'bot':
            if raise_on_error:
                raise ServiceError('AGENT_TYPE_INVALID', 'Agent 类型仅支持 bot', 400)
            return None

        required_role = 'viewer' if system_provisioning else 'editor'
        if not self.check_organization_permission(str(organization_id), required_role):
            if raise_on_error:
                raise ServiceError('PERMISSION_DENIED', '无权限或组织不存在', 403)
            return None

        user_supplied_name = name
        if user_supplied_name and '{owner}' in user_supplied_name:
            if raise_on_error:
                raise ServiceError(
                    'AGENT_NAME_RESERVED_TOKEN',
                    '手动设置的 Agent 名称不能包含 {owner}',
                    400,
                )
            return None

        template = None
        if template_id:
            from apps.services.common.agent_template_registry import get_agent_template

            template = get_agent_template(template_id)
            if template is None:
                if raise_on_error:
                    raise ServiceError(
                        'TEMPLATE_NOT_FOUND',
                        f'Agent 模板不存在: {template_id}',
                        404,
                    )
                return None

        selected_avatar_key = (avatar_key or '').strip()
        if selected_avatar_key:
            if not is_builtin_agent_avatar_key(selected_avatar_key):
                if raise_on_error:
                    raise ServiceError(
                        'AGENT_AVATAR_INVALID',
                        f'未知的品牌头像: {selected_avatar_key}',
                        400,
                    )
                return None

        try:
            organization_query = Organization.objects
            if template is None:
                organization_query = organization_query.select_for_update()
            organization = organization_query.get(id=organization_id)
        except Organization.DoesNotExist:
            if raise_on_error:
                raise ServiceError('ORGANIZATION_NOT_FOUND', '组织不存在', 404)
            return None

        if template is None and self.user:
            # ：系统默认小Tin 不计自建配额
            custom_agent_count = Agent.objects.filter(
                organization_id=organization_id,
                owner_user_id=self.user.id,
                type='bot',
                template_id='',
                is_active=True,
                is_default=False,
            ).count()
            if custom_agent_count >= MAX_CUSTOM_BOT_AGENTS:
                if raise_on_error:
                    raise ServiceError(
                        'AGENT_LIMIT_EXCEEDED',
                        f'Agent 数量已达上限（{MAX_CUSTOM_BOT_AGENTS} 个）',
                        409,
                    )
                return None

        # v2 default: 不带 memory（D2 / TabMemo 后续专题），需要 memory 的
        # incoming agent_config 通过 _validate_and_merge_config 显式注入。
        final_config = copy.deepcopy(self.DEFAULT_AGENT_CONFIG)

        suggested_prompts = list(template.suggested_prompts) if template else []

        if agent_config:
            self._validate_and_merge_config(final_config, agent_config)

        agent_settings: Dict[str, Any] = {}
        if template:
            name = name or template.name
            # 长 persona 仍只作模板说明；仅注入刻意保持简短的 initial_rules，
            # 给用户一个可编辑起点，不用大段提示词限制模型能力。
            if custom_rules is None:
                custom_rules = template.initial_rules
            goal = goal or template.goal
            if template.welcome_message:
                agent_settings['welcome_message'] = template.welcome_message
            if template.icon:
                agent_settings['icon'] = template.icon
            if template.default_mode:
                agent_settings['default_mode'] = template.default_mode
            if not selected_avatar_key:
                selected_avatar_key = template.avatar_key
        if selected_avatar_key:
            agent_settings['avatar_key'] = selected_avatar_key

        if not name.strip():
            if raise_on_error:
                raise ServiceError('AGENT_NAME_REQUIRED', 'Agent 名称不能为空', 400)
            return None

        from apps.tabtinspace.services.onboarding_defaults import (
            strip_reserved_provision_source,
        )

        return {
            'organization': organization,
            'owner_user': self.user,
            'name': name,
            'type': 'bot',
            # 用户/模板创建不得写入 system_default provenance
            'settings': strip_reserved_provision_source(agent_settings),
            'custom_rules': custom_rules or '',
            'goal': goal or '',
            'agent_config': final_config,
            'suggested_prompts': suggested_prompts,
            'template_id': template.id if template else '',
            'template_version': template.version if template else '',
            'template_skills': template.skills if template else (),
        }

    @staticmethod
    def _copy_template_skills(agent: Agent, canonical_keys) -> None:
        if not canonical_keys:
            return

        from apps.skills.models import AgentSkillLink

        links = []
        for canonical_key in dict.fromkeys(canonical_keys):
            source, separator, _identifier = canonical_key.partition(':')
            if not separator or source not in {'platform', 'app', 'device'}:
                raise ValueError(
                    f'模板 Skill canonical key 非法: {canonical_key}',
                )
            links.append(
                AgentSkillLink(
                    agent=agent,
                    skill_canonical_key=canonical_key,
                    source=source,
                    enabled=True,
                )
            )
        AgentSkillLink.objects.bulk_create(links)

    @classmethod
    def _ensure_template_skills_enabled(cls, agent: Agent, canonical_keys) -> None:
        """幂等补齐模板能力基线，并修复曾被关闭的历史携带行。"""
        from apps.skills.models import AgentSkillLink

        keys = tuple(dict.fromkeys(canonical_keys))
        if not keys:
            return
        existing_keys = set(
            AgentSkillLink.objects.filter(
                agent=agent,
                skill_canonical_key__in=keys,
            ).values_list('skill_canonical_key', flat=True)
        )
        cls._copy_template_skills(
            agent,
            [key for key in keys if key not in existing_keys],
        )
        AgentSkillLink.objects.filter(
            agent=agent,
            skill_canonical_key__in=keys,
            enabled=False,
        ).update(enabled=True)

    @transaction.atomic(using=postgres_app_db_alias())
    def create_agent(
        self,
        organization_id: UUID,
        name: str,
        agent_type: str = 'bot',
        custom_rules: Optional[str] = None,
        goal: Optional[str] = None,
        agent_config: Optional[Dict[str, Any]] = None,
        template_id: Optional[str] = None,
        avatar_key: Optional[str] = None,
    ) -> Agent:
        """创建 Agent。

        Raises:
            ServiceError: 权限不足或组织不存在。
        """
        prepared = self._prepare_agent_creation(
            organization_id, name, agent_type,
            custom_rules=custom_rules,
            goal=goal,
            agent_config=agent_config,
            template_id=template_id,
            avatar_key=avatar_key,
            raise_on_error=True,
        )
        from .base import ServiceError

        template_skills = prepared.pop('template_skills')
        agent = Agent.objects.create(**prepared)
        try:
            self._copy_template_skills(agent, template_skills)
        except ValueError as exc:
            # 同事务回滚：模板 Skill 非法/不存在时不能留下半个 Agent。
            raise ServiceError(
                'TEMPLATE_SKILL_INVALID',
                str(exc),
                400,
            ) from exc
        return agent

    def _resolve_request_device_id(self, device_fingerprint: Optional[str]) -> Optional[str]:
        """把请求方上报的设备 fingerprint 解析为其 control 设备 id（字符串）。

        与创建 / 绑定口径一致：按「fingerprint + 当前用户 + control 角色」定位
        （fingerprint 全局唯一）。解析不到返回 None —— 调用方据此判定「无法证明是
        绑定设备」并拒绝目录修改。
        """
        if not device_fingerprint or not self.user:
            return None
        device = Device.objects.filter(
            fingerprint=device_fingerprint,
            user_id=self.user.id,
            role='control',
        ).first()
        return str(device.id) if device else None

    @transaction.atomic(using=postgres_app_db_alias())
    def update_agent(
        self,
        agent_id: UUID,
        name: Optional[str] = None,
        custom_rules: Optional[str] = None,
        goal: Optional[str] = None,
        suggested_prompts: Optional[List[str]] = None,
        agent_config: Optional[Dict[str, Any]] = None,
        avatar_url: Optional[str] = None,
        update_avatar_url: bool = False,
        avatar_key: Optional[str] = None,
        update_avatar_key: bool = False,
    ) -> Agent:
        """只更新 Agent 身份与能力配置；执行现场由 Workspace API 独立维护。"""
        from .base import ServiceError

        agent = (
            Agent.objects.select_for_update()
            .filter(id=agent_id)
            .first()
        )
        if not agent:
            raise ServiceError('AGENT_NOT_FOUND', 'Agent 不存在', 404)
        if not self.check_agent_owner(agent):
            raise ServiceError('PERMISSION_DENIED', '无权限更新此 Agent', 403)

        old_cfg = copy.deepcopy(agent.agent_config if isinstance(agent.agent_config, dict) else {})
        old_security = copy.deepcopy(old_cfg.get('security') or {})
        if not isinstance(old_security, dict):
            old_security = {}
        old_name = agent.name
        old_custom_rules = agent.custom_rules

        if name is not None:
            if '{owner}' in name:
                raise ServiceError(
                    'AGENT_NAME_RESERVED_TOKEN',
                    '手动设置的 Agent 名称不能包含 {owner}',
                    400,
                )
            agent.name = name
        if custom_rules is not None:
            agent.custom_rules = custom_rules
        if goal is not None:
            agent.goal = goal
        if suggested_prompts is not None:
            agent.suggested_prompts = suggested_prompts

        if agent_config is not None:
            merged = dict(agent.agent_config or {})
            self._validate_and_merge_config(merged, agent_config)
            for retired_key in (
                'workspace_root', 'git_status', 'approval_grant', 'approval_memo',
            ):
                merged.pop(retired_key, None)
            security = merged.get('security')
            if isinstance(security, dict):
                security.pop('approval_grant', None)
                security.pop('approval_memo', None)
            agent.agent_config = merged

        update_fields = [
            'name',
            'custom_rules',
            'goal',
            'suggested_prompts',
            'agent_config',
            'updated_at',
        ]
        if update_avatar_url:
            settings = dict(agent.settings or {})
            trimmed = (avatar_url or '').strip()
            if trimmed:
                lowered = trimmed.lower()
                if not (
                    lowered.startswith('https://')
                    or lowered.startswith('http://')
                ):
                    raise ServiceError(
                        'INVALID_AVATAR_URL',
                        '头像 URL 必须以 http:// 或 https:// 开头',
                        400,
                    )
                settings['avatar_url'] = trimmed
            else:
                settings.pop('avatar_url', None)
            agent.settings = settings
            update_fields.append('settings')
        if update_avatar_key:
            selected_avatar_key = (avatar_key or '').strip()
            if not is_builtin_agent_avatar_key(selected_avatar_key):
                raise ServiceError(
                    'AGENT_AVATAR_INVALID',
                    f'未知的品牌头像: {selected_avatar_key}',
                    400,
                )
            settings = dict(agent.settings or {})
            settings['avatar_key'] = selected_avatar_key
            # 只有用户主动保存预设时才清掉旧上传头像；仅新增预设不会改存量设置。
            settings.pop('avatar_url', None)
            agent.settings = settings
            if 'settings' not in update_fields:
                update_fields.append('settings')

        agent.save(update_fields=update_fields)
        self._dispatch_update_audits(
            agent=agent,
            old_name=old_name,
            old_custom_rules=old_custom_rules,
            old_config=old_cfg,
        )

        if agent_config is not None:
            new_cfg = agent.agent_config if isinstance(agent.agent_config, dict) else {}
            new_security = new_cfg.get('security') or {}
            if not isinstance(new_security, dict):
                new_security = {}
            if old_security != new_security:
                # AuditService.log 内部开 `transaction.atomic(using=postgres_app_db_alias())`，
                # Django 嵌套 atomic 是 savepoint —— 在已 atomic 的方法里调用是安全的，
                # 失败会回滚到外层 savepoint 而不是整个 update_agent。
                from apps.tabtinspace.services.audit_service import AuditService
                AuditService.log(
                    action_type='agent_security_update',
                    target_type='agent',
                    target_id=str(agent.id),
                    organization_id=str(agent.organization_id),
                    operator=self.user,
                    request_payload={
                        'before': old_security,
                        'after': new_security,
                    },
                    ip_address=getattr(self, 'request_ip', None) or None,
                    trace_id=getattr(self, 'trace_id', '') or '',
                    message=f"更新 Agent「{agent.name}」安全配置",
                )

        return agent

    def _dispatch_update_audits(
        self,
        *,
        agent: Agent,
        old_name: str,
        old_custom_rules: str,
        old_config: Dict[str, Any],
    ) -> None:
        """记录 Agent 身份与配置变化；Workspace 变化由 Workspace 域自行审计。"""
        from apps.tabtinspace.services.audit_service import AuditService

        new_cfg = agent.agent_config if isinstance(agent.agent_config, dict) else {}
        base_kwargs = dict(
            target_type='agent',
            target_id=str(agent.id),
            organization_id=str(agent.organization_id),
            operator=self.user,
            ip_address=getattr(self, 'request_ip', None) or None,
            trace_id=getattr(self, 'trace_id', '') or '',
        )
        if old_custom_rules != agent.custom_rules:
            AuditService.log(
                action_type='agent_prompt_update',
                request_payload={
                    'before': {'custom_rules': old_custom_rules},
                    'after': {'custom_rules': agent.custom_rules},
                },
                message=f"更新 Agent「{agent.name}」提示词",
                **base_kwargs,
            )

        if old_config != new_cfg:
            AuditService.log(
                action_type='agent_capability_update',
                request_payload={
                    'before': {'agent_config': old_config},
                    'after': {'agent_config': copy.deepcopy(new_cfg)},
                },
                message=f"更新 Agent「{agent.name}」能力配置",
                **base_kwargs,
            )

        if old_name != agent.name:
            AuditService.log(
                action_type='agent_profile_update',
                request_payload={
                    'before': {'name': old_name},
                    'after': {'name': agent.name},
                },
                message=f"更新 Agent「{agent.name}」资料",
                **base_kwargs,
            )

    def _validate_and_merge_config(
        self,
        target: Dict[str, Any],
        incoming: Dict[str, Any],
    ) -> None:
        """校验 incoming 后深度合并到 target（v2 形状）。

        策略：
        - 若 incoming 是 v1 顶层形状（带 terminal_mode / operation_switches /
          sandbox / sql_mode / execution_limits 等顶层字段），先 ``migrate_v1_to_v2``
          归一到 v2 嵌套，再做字段值合法性校验；这样调用方（含老移动端 / 旧
          API 客户端）传 v1 形状不会立即崩。
        - 校验各字段合法值后调用 _deep_merge 合并到 target。
        - **不**接受 v2 已删除字段：``execution_env`` / ``permission_mode`` 静默丢弃。
        - memory 子树：保留校验逻辑（因 incoming 可能仍带 memory，TabMemo 后续
          专题清理前我们不主动拒绝）。
        """
        # ── 0. 形状归一：v1 → v2（幂等，已是 v2 形状直接 deepcopy 返回）─
        # incoming 可能是 v1（旧 client）/ v2（新 client）/ 部分嵌套（前端边
        # 编辑边 PUT）。统一过 migrate 后字段位置确定。
        if not isinstance(incoming, dict):
            return

        # v1 顶层标识键集合（任一存在即视为「混入了 v1 字段」需 promote）。
        # 含 W0-A 漏掉的 conversation 顶层字段（cross_turn_memory /
        # max_history_messages），避免「假 v2」混合包永久化（review #1 修复点）。
        _V1_TOP_KEYS = (
            'terminal_mode', 'operation_switches', 'sandbox',
            'sql_mode', 'execution_limits', 'device_permissions',
            'authorization_rules', 'cross_turn_memory', 'max_history_messages',
        )
        has_v1_top = any(k in incoming for k in _V1_TOP_KEYS)
        # 三种情况都要 promote：
        # 1. 完全 v1 形状（无 schema_version / 无 capabilities）
        # 2. 「假 v2」（有 capabilities 但仍混 v1 顶层）—— 防止顶层 v1 字段
        #    被 deep_merge 永久化进 target
        # 3. schema_version=2 但仍混 v1 顶层（极端老数据）
        if has_v1_top:
            # 关键 1：incoming 自己的 capabilities/conversation 块也要保留 ——
            # migrate_v1_to_v2 是「v1 全量 → v2 全量」，不保留入参的 v2 嵌套块。
            # 混合包（capabilities 块 + 顶层 v1 字段）需要把入参的 v2 块单独
            # 抢救出来，promote 后再 deep_merge 回 incoming.capabilities/conversation。
            incoming_caps = (
                copy.deepcopy(incoming['capabilities'])
                if isinstance(incoming.get('capabilities'), dict) else None
            )
            incoming_conv = (
                copy.deepcopy(incoming['conversation'])
                if isinstance(incoming.get('conversation'), dict) else None
            )
            # 关键 2：剥掉 schema_version 让 migrate 走全量转换路径。
            # migrate_v1_to_v2 的幂等门闸是「看到 schema_version=2 直接 deepcopy
            # 返回」—— 但混合包既有 v2 标志又混 v1 顶层字段，幂等门闸会"过早"
            # 返回，导致顶层 v1 字段未被搬到嵌套位置就 _deep_merge 进 target。
            incoming.pop('schema_version', None)
            incoming = migrate_v1_to_v2(incoming)
            if incoming_caps:
                AgentService._deep_merge(
                    incoming.setdefault('capabilities', {}), incoming_caps,
                )
            if incoming_conv:
                AgentService._deep_merge(
                    incoming.setdefault('conversation', {}), incoming_conv,
                )
        # 即使是 v2 形状，也要保证 schema_version 标记正确。
        incoming.setdefault('schema_version', V2_SCHEMA_VERSION)

        # 顶级 v1 残留字段静默丢弃（execution_env / permission_mode 已删除）
        incoming.pop('execution_env', None)
        incoming.pop('permission_mode', None)
        # Soul 概念已整体移除（总控计划 D4）。兴底：即便旧客户端仍 echo
        # agent_config.soul（bleed-back 老 DB 行），这里静默剥离而非 422，
        # 不让僵尸子树重新写回 Agent.agent_config。
        incoming.pop('soul', None)

        # ── 1. 顶层字段校验 ─────────────────────────────────────────────
        incoming.pop('authorization_preset', None)

        security = incoming.get('security')
        if isinstance(security, dict):
            # v3 PRD §5.1.1：字段改名 yolo_mode → allow_yolo_mode。API schema
            # 层（AgentSecurityUpdate）拒绝老字段；这里是 service 兜底——把
            # incoming 里的老键归一到新键（极少数 internal 路径走 migrate_v1_to_v2
            # 后仍可能携带），然后 bool 归一。
            if 'yolo_mode' in security and 'allow_yolo_mode' not in security:
                security['allow_yolo_mode'] = bool(security.pop('yolo_mode'))
            else:
                security.pop('yolo_mode', None)
            ym = security.get('allow_yolo_mode')
            if ym is not None and not isinstance(ym, bool):
                security['allow_yolo_mode'] = bool(ym)
            #  三档审批策略：approval_grant 枚举归一（脏值静默剥离，
            # fail-safe 落回"未显式授权"由读端 resolve_approval_grant 兜底）。
            # 写入合法 grant 时同步 legacy allow_yolo_mode（grant≥auto → true），
            # 让旧客户端（仍读 bool gate 的 Electron / Daemon 版本）行为一致。
            grant = security.get('approval_grant')
            if grant is not None:
                from apps.services.common.agent_governance_resolver import (
                    APPROVAL_GRANT_VALUES,
                )
                if grant not in APPROVAL_GRANT_VALUES:
                    security.pop('approval_grant', None)
                else:
                    security['allow_yolo_mode'] = grant != 'always_ask'

        rp = incoming.get('runtime_plane')
        if rp is not None and rp not in self.VALID_RUNTIME_PLANES:
            incoming['runtime_plane'] = 'local'

        agent_backend = incoming.get('agent_backend')
        if isinstance(agent_backend, dict):
            backend_type = agent_backend.get('type', 'builtin')
            if backend_type not in self.VALID_AGENT_BACKEND_TYPES:
                agent_backend['type'] = 'builtin'
            self._migrate_backend_config(agent_backend)
            incoming['agent_backend'] = agent_backend

        # ── 2. capabilities.overrides 各分组校验 ─────────────────────────
        capabilities = incoming.get('capabilities')
        if isinstance(capabilities, dict):
            overrides = capabilities.get('overrides')
            if isinstance(overrides, dict):
                self._validate_capability_overrides(overrides)
            cap_preset = capabilities.get('preset')
            if cap_preset and cap_preset not in self.VALID_PRESETS | {'server_auto'}:
                capabilities['preset'] = 'collaborative'

        # ── 3. conversation 校验 ────────────────────────────────────────
        conversation = incoming.get('conversation')
        if isinstance(conversation, dict):
            ctm = conversation.get('cross_turn_memory')
            if ctm is not None and not isinstance(ctm, bool):
                conversation['cross_turn_memory'] = bool(ctm)
            mhm = conversation.get('max_history_messages')
            if mhm is not None:
                try:
                    conversation['max_history_messages'] = max(0, min(500, int(mhm)))
                except (TypeError, ValueError):
                    conversation.pop('max_history_messages', None)

        # ── 4. memory 子树校验（兼容路径：v2 default 不带，但 incoming 仍可带）─
        memory = incoming.get('memory')
        if memory is not None and not isinstance(memory, dict):
            memory = {
                k: (dict(v) if isinstance(v, dict) else v)
                for k, v in self.MEMORY_DEFAULTS.items()
            }
            incoming['memory'] = memory
        if isinstance(memory, dict):
            memory.setdefault('version', 'v2.0')
            if not isinstance(memory.get('enabled'), bool):
                memory['enabled'] = self.MEMORY_DEFAULTS['enabled']
            observer = memory.get('observer')
            if isinstance(observer, dict):
                om = observer.get('mode')
                if om and om not in self.VALID_OBSERVER_MODES:
                    observer['mode'] = 'auto'
                dt = observer.get('dedup_threshold')
                if dt is not None:
                    try:
                        observer['dedup_threshold'] = max(0.0, min(1.0, float(dt)))
                    except (TypeError, ValueError):
                        observer.pop('dedup_threshold', None)
                memory['observer'] = observer
            injection = memory.get('injection')
            if isinstance(injection, dict):
                if not isinstance(injection.get('auto_inject'), bool):
                    injection['auto_inject'] = True
                st = injection.get('similarity_threshold')
                if st is not None:
                    try:
                        injection['similarity_threshold'] = max(0.0, min(1.0, float(st)))
                    except (TypeError, ValueError):
                        injection.pop('similarity_threshold', None)
                memory['injection'] = injection
            wm = memory.get('working_memory')
            if isinstance(wm, dict):
                strat = wm.get('strategy')
                if strat and strat not in self.VALID_SESSION_SUMMARIZATION_STRATEGIES:
                    wm['strategy'] = 'auto_condense'
                pt = wm.get('pressure_threshold')
                if pt is not None:
                    try:
                        wm['pressure_threshold'] = max(0.50, min(0.95, float(pt)))
                    except (TypeError, ValueError):
                        wm.pop('pressure_threshold', None)
                ekm = wm.get('emergency_keep_messages')
                if ekm is not None:
                    try:
                        wm['emergency_keep_messages'] = max(4, min(20, int(ekm)))
                    except (TypeError, ValueError):
                        wm.pop('emergency_keep_messages', None)
                memory['working_memory'] = wm
            incoming['memory'] = memory

        self._deep_merge(target, incoming)

    def _validate_capability_overrides(self, overrides: Dict[str, Any]) -> None:
        """校验 capabilities.overrides 各分组的字段值。

        非法值被规整为合法默认值（与旧 v1 校验路径一致），保证 _deep_merge
        后 target 不会被脏数据污染。
        """
        # shell 分组
        shell = overrides.get('shell')
        if isinstance(shell, dict):
            tm = shell.get('terminal_mode')
            if tm and tm not in self.VALID_TERMINAL_MODES:
                shell['terminal_mode'] = 'sandboxed'
            ce = shell.get('command_execution')
            if ce and ce not in self.VALID_COMMAND_EXECUTION:
                shell['command_execution'] = 'sandboxed'
            os_raw = shell.get('operation_switches')
            if isinstance(os_raw, dict):
                shell['operation_switches'] = {
                    k: v for k, v in os_raw.items()
                    if k in self.VALID_OPERATION_SWITCH_KEYS
                    and v in self.VALID_SWITCH_ACTIONS
                }
            hr = shell.get('high_risk_requires_approval')
            if hr is not None and not isinstance(hr, bool):
                shell['high_risk_requires_approval'] = bool(hr)

        # filesystem 分组
        fs = overrides.get('filesystem')
        if isinstance(fs, dict):
            sl = fs.get('sandbox_level')
            if sl and sl not in self.VALID_SANDBOX_LEVEL:
                fs['sandbox_level'] = 'filesystem'
            fa = fs.get('file_access')
            if fa and fa not in self.VALID_FILE_ACCESS:
                fs['file_access'] = 'workspace'
            for list_key in ('deny_read_paths', 'deny_write_paths', 'custom_write_paths'):
                val = fs.get(list_key)
                if val is not None and not isinstance(val, list):
                    fs[list_key] = []

        # network 分组
        network = overrides.get('network')
        if isinstance(network, dict):
            nm = network.get('network_mode')
            if nm and nm not in self.VALID_NETWORK_MODE:
                network['network_mode'] = 'allowed'
            for list_key in ('allowed_domains', 'denied_domains'):
                val = network.get(list_key)
                if val is not None and not isinstance(val, list):
                    network[list_key] = []

        # sql 分组
        sql = overrides.get('sql')
        if isinstance(sql, dict):
            sm = sql.get('sql_mode')
            if sm and sm not in self.VALID_SQL_MODES:
                sql['sql_mode'] = 'read_write'

        # cost 分组（execution_limits）
        cost = overrides.get('cost')
        if isinstance(cost, dict):
            el = cost.get('execution_limits')
            if isinstance(el, dict):
                mi = el.get('max_iterations_per_run')
                if mi is not None:
                    try:
                        mi = int(mi)
                        el['max_iterations_per_run'] = max(1, min(500, mi))
                    except (TypeError, ValueError):
                        el['max_iterations_per_run'] = None
                mc = el.get('max_credits_per_run')
                if mc is not None:
                    try:
                        mc = float(mc)
                        if mc <= 0:
                            el['max_credits_per_run'] = None
                        else:
                            el['max_credits_per_run'] = str(min(mc, 10000.0))
                    except (TypeError, ValueError):
                        el['max_credits_per_run'] = None

        # device 分组
        device = overrides.get('device')
        if isinstance(device, dict):
            dp_raw = device.get('device_permissions')
            if isinstance(dp_raw, dict):
                device['device_permissions'] = {
                    k: v for k, v in dp_raw.items()
                    if k in self.VALID_DEVICE_PERMISSION_KEYS
                    and v in self.VALID_SWITCH_ACTIONS
                }

        # audit 分组
        audit = overrides.get('audit')
        if isinstance(audit, dict):
            rules = audit.get('authorization_rules')
            if isinstance(rules, dict):
                audit['authorization_rules'] = {
                    k: v for k, v in rules.items()
                    if k in self.VALID_CATEGORIES and v in self.VALID_ACTIONS
                }

    def _migrate_backend_config(self, agent_backend: Dict[str, Any]) -> None:
        config_version = agent_backend.get('config_version', 1)
        if config_version < self.CURRENT_BACKEND_CONFIG_VERSION:
            _logger.info(
                "Migrating agent_backend config from v%d to v%d",
                config_version, self.CURRENT_BACKEND_CONFIG_VERSION,
            )
        for field in self._DEPRECATED_BACKEND_FIELDS:
            if field in agent_backend:
                del agent_backend[field]

        # ACP cleanup: drop legacy acp_config sub-dict if present
        if 'acp_config' in agent_backend:
            del agent_backend['acp_config']

        agent_backend['config_version'] = self.CURRENT_BACKEND_CONFIG_VERSION

    @staticmethod
    def _deep_merge(base: Dict[str, Any], patch: Dict[str, Any]) -> None:
        """递归合并 patch 到 base，嵌套 dict 做深度合并而非替换。"""
        for key, value in patch.items():
            if (
                key in base
                and isinstance(base[key], dict)
                and isinstance(value, dict)
            ):
                AgentService._deep_merge(base[key], value)
            else:
                base[key] = value

    @transaction.atomic(using=postgres_app_db_alias())
    def create_agent_workspace(
        self,
        organization_id: UUID,
        name: str,
        description: Optional[str] = None,
        custom_rules: Optional[str] = None,
        agent_config: Optional[Dict[str, Any]] = None,
        device_fingerprint: Optional[str] = None,
        working_dir: Optional[str] = None,
        working_dir_type: Optional[str] = None,
    ) -> Tuple[Agent, Workspace, Optional[str]]:
        """原子化创建 bot Agent + Workspace + Creator Membership。

        单事务保证 Agent、Workspace、创建者 Membership 要么同时创建成功，要么同时回滚。

        Returns:
            (agent, workspace, device_bind_warning) — warning 为 None 表示绑定成功或未请求绑定。

        Raises:
            ServiceError: 权限不足、organization 不存在或 Workspace 名称冲突。
        """
        from .base import ServiceError
        from apps.tabtinspace.services.membership_utils import ensure_user_membership

        prepared = self._prepare_agent_creation(
            organization_id, name, 'bot',
            custom_rules=custom_rules,
            agent_config=agent_config,
            raise_on_error=True,
        )
        template_skills = prepared.pop('template_skills')

        bound_device = Device.objects.filter(
            fingerprint=device_fingerprint,
            user_id=self.user.id,
            role='control',
        ).first()
        effective_working_dir = working_dir or ''
        from apps.tabtinspace.services.space_service import SpaceService
        normalized_working_dir = SpaceService._canonical_working_dir(effective_working_dir)
        if not bound_device:
            raise ServiceError('DEVICE_REQUIRED', '创建 Space 必须指定执行设备', 400)
        if not normalized_working_dir:
            raise ServiceError('WORKING_DIR_REQUIRED', '创建 Space 必须指定工作目录', 400)
        SpaceService._assert_working_dir_available(
            organization_id=prepared['organization'].id,
            created_by_id=self.user.id,
            device_id=bound_device.id,
            normalized_working_dir=normalized_working_dir,
        )

        agent = Agent.objects.create(**prepared)
        self._copy_template_skills(agent, template_skills)

        try:
            #  / ：只建 Workspace；身份经 membership / Session，不挂 FK。
            space = Workspace.objects.create(
                organization=prepared['organization'],
                device=bound_device,
                name=name,
                working_dir=normalized_working_dir,
                normalized_working_dir=normalized_working_dir,
                working_dir_type=working_dir_type or '',
                created_by=self.user,
                kind=Workspace.Kind.STANDARD,
                trust_status=Workspace.TrustStatus.TRUSTED,
                trust_source=Workspace.TrustSource.USER_CONFIRMED,
                trusted_at=timezone.now(),
            )
        except IntegrityError as exc:
            exc_str = str(exc).lower()
            if 'ctx_ws_device_dir_unique' in exc_str or 'ctx_space_device_dir_unique' in exc_str:
                raise ServiceError('WORKING_DIR_CONFLICT', '该工作目录已绑定到当前设备上的另一个 Workspace', 409)
            raise

        ensure_user_membership(space, self.user.id, 'owner')
        from apps.tabtinspace.models import SpaceMembership
        SpaceMembership.objects.get_or_create(
            workspace_id=space.id,
            agent_id=agent.id,
            defaults={'role': 'owner', 'is_active': True, 'permissions': {}},
        )

        # Wave 1-B：workspace 自动预置「规划」Collection（Plan 文档归属目录）。
        # 必须在事务内执行：创建失败 → 整个 create_agent_workspace 回滚。
        self._provision_planning_collection(space)

        wt_id = str(prepared['organization'].id)
        sp_id = str(space.id)
        transaction.on_commit(
            lambda: publish_space_list_change(wt_id, 'created', sp_id),
            using=postgres_app_db_alias(),
        )

        return agent, space, None

    def _provision_planning_collection(self, space: Workspace) -> Collection:
        """为新建的 workspace 预置「规划」Collection。

        通过 system_key 唯一标识系统预置 Collection，即使用户重命名
        name 字段也不影响后续查找。

        直接走 ORM（不调 CollectionService.create_collection）以避免：
        - 重复的 check_space_permission 校验（创建者已在事务上文中获得 owner）
        - service 内部的重复名称检测（这里期望幂等的 get_or_create 语义）

        失败时异常向上传播，触发 create_agent_workspace 的事务回滚。
        """
        collection, _created = Collection.objects.get_or_create(
            workspace=space,
            system_key=_PLANNING_COLLECTION_SYSTEM_KEY,
            defaults={
                'parent': None,
                'name': _PLANNING_COLLECTION_NAME,
                'icon': _PLANNING_COLLECTION_ICON,
                'color': '',
                'order': _PLANNING_COLLECTION_ORDER,
                'created_by': self.user,
            },
        )
        return collection

    def ensure_default_agent(self, organization_id: UUID) -> Optional[Agent]:
        """保证当前用户在组织内有一只系统默认「小Tin」。

        优先级：
        1. 活跃系统默认（``settings.provision_source=system_default``）→ skill repair
        2. 误标默认的迁移 / 自建分身 → demote（不提升为默认）
        3. 停用的系统默认 → 复活 + seed
        4. 新建系统默认小Tin + seed

        不再「提升最早活跃 bot」——Space 迁移分身不得标默认。
        调用方需已具备组织 viewer 及以上权限；无用户时返回 None。

        已存在的活跃默认只在短事务里取行锁确认身份，Skill 修复放到事务提交后，
        避免持着 ``agent_agent`` 行锁再去同步 AppInstall / Skill。
        """
        from .base import ServiceError
        from apps.tabtinspace.services.onboarding_defaults import (
            build_system_default_agent_settings,
            is_system_default_agent,
            resolve_onboarding_defaults,
        )

        if not self.user:
            return None
        if not self.check_organization_permission(str(organization_id), 'viewer'):
            raise ServiceError('PERMISSION_DENIED', '无组织访问权限', 403)

        owner_id = self.user.id
        agent_to_repair: Optional[Agent] = None

        with transaction.atomic(using=postgres_app_db_alias()):
            active_system = self._find_system_default_agent(
                organization_id,
                owner_id,
                is_active=True,
                for_update=True,
            )
            if active_system:
                agent_to_repair = active_system
            else:
                # ：Space 迁移 / 历史回填误标的默认 → 降级，留给下方新建系统小Tin
                self._demote_non_system_default_agents(organization_id, owner_id)

                inactive_system = self._find_system_default_agent(
                    organization_id,
                    owner_id,
                    is_active=False,
                    for_update=True,
                )
                if inactive_system:
                    inactive_system.is_active = True
                    inactive_system.save(update_fields=['is_active', 'updated_at'])
                    from apps.skills.services.default_agent_skill_seed import (
                        run_default_agent_skill_seed_safe,
                        seed_default_agent_skills,
                    )
                    run_default_agent_skill_seed_safe(
                        lambda: seed_default_agent_skills(inactive_system, self.user),
                        event="default_agent_skill_seed.ensure_resurrect",
                        agent=inactive_system.id,
                    )
                    return inactive_system

                onboarding = resolve_onboarding_defaults(self.user)
                try:
                    created = Agent.objects.create(
                        organization_id=organization_id,
                        owner_user=self.user,
                        name=onboarding.agent_name,
                        type='bot',
                        is_default=True,
                        agent_config=copy.deepcopy(self.DEFAULT_AGENT_CONFIG),
                        settings=build_system_default_agent_settings(),
                    )
                    from apps.skills.services.default_agent_skill_seed import (
                        run_default_agent_skill_seed_safe,
                        seed_default_agent_skills,
                    )
                    run_default_agent_skill_seed_safe(
                        lambda: seed_default_agent_skills(created, self.user),
                        event="default_agent_skill_seed.ensure_create",
                        agent=created.id,
                    )
                    return created
                except IntegrityError:
                    raced = self._find_active_default_agent(organization_id, owner_id)
                    if raced and is_system_default_agent(raced):
                        agent_to_repair = raced
                    else:
                        # 竞态落到非系统默认时继续 demote + 再找系统默认
                        self._demote_non_system_default_agents(organization_id, owner_id)
                        raced_system = self._find_system_default_agent(
                            organization_id,
                            owner_id,
                            is_active=True,
                            for_update=False,
                        )
                        if raced_system:
                            agent_to_repair = raced_system
                        else:
                            raise

        if agent_to_repair is not None:
            from apps.skills.services.default_agent_skill_seed import (
                repair_default_agent_skills_if_needed,
                run_default_agent_skill_seed_safe,
            )
            run_default_agent_skill_seed_safe(
                lambda: repair_default_agent_skills_if_needed(agent_to_repair, self.user),
                event="default_agent_skill_seed.ensure_active",
                agent=agent_to_repair.id,
            )
            return agent_to_repair
        return None

    def ensure_default_agent_for_listing(self, organization_id: UUID) -> Optional[Agent]:
        """列表热路径：已有默认 Agent 时纯读，不加锁、不写库。

        ``GET /api/agents`` 会在客户端启动、切换组织和刷新设置时频繁调用。
        稳定态只确认系统默认 Agent 存在即可；Skill / AppInstall 补偿改由创建、
        复活、装 App 等写路径负责，避免读列表夹带写操作放大锁范围。

        只有确实缺少系统默认 Agent 时，才回到 :meth:`ensure_default_agent`
        处理创建、复活和历史数据纠偏。
        """
        from .base import ServiceError

        if not self.user:
            return None
        if not self.check_organization_permission(str(organization_id), 'viewer'):
            raise ServiceError('PERMISSION_DENIED', '无组织访问权限', 403)

        active_system = self._find_system_default_agent(
            organization_id,
            self.user.id,
            is_active=True,
            for_update=False,
        )
        if active_system is not None:
            return active_system
        return self.ensure_default_agent(organization_id)

    def ensure_starter_agent_roster_for_listing(
        self,
        organization_id: UUID,
    ) -> Optional[Agent]:
        """首次列出分身时，幂等提供五个首发角色。

        默认小Tin承担「日常」角色，避免系统默认身份之外再多出第六个 Agent；
        其余四个角色从代码、文书、数据、冲浪模板实例化。

        稳定态只读取默认 Agent 的 ``starter_roster_version``；首次补建时锁住
        默认 Agent 行，防止多个列表请求并发创建重复分身。完成标记一旦写入，
        用户后续停用某个首发分身也不会被系统自动恢复。
        """
        from apps.tabtinspace.services.onboarding_defaults import (
            AGENT_SETTINGS_STARTER_ROSTER_VERSION_KEY,
            STARTER_AGENT_ROSTER_VERSION,
        )

        default_agent = self.ensure_default_agent_for_listing(organization_id)
        if default_agent is None:
            return None

        settings = (
            default_agent.settings
            if isinstance(default_agent.settings, dict)
            else {}
        )
        try:
            provisioned_version = int(
                settings.get(AGENT_SETTINGS_STARTER_ROSTER_VERSION_KEY, 0) or 0
            )
        except (TypeError, ValueError):
            provisioned_version = 0
        if provisioned_version >= STARTER_AGENT_ROSTER_VERSION:
            return default_agent

        return self._provision_starter_agent_roster(
            organization_id=organization_id,
            default_agent_id=default_agent.id,
        )

    @transaction.atomic(using=postgres_app_db_alias())
    def _provision_starter_agent_roster(
        self,
        *,
        organization_id: UUID,
        default_agent_id: UUID,
    ) -> Agent:
        """锁内补建首发阵容；任一模板创建失败则整批回滚。"""
        from .base import ServiceError
        from apps.services.common.agent_template_registry import (
            get_agent_template,
            list_agent_templates,
        )
        from apps.tabtinspace.services.onboarding_defaults import (
            AGENT_SETTINGS_STARTER_ROSTER_VERSION_KEY,
            CODE_ENGINEER_REMOVED_DEFAULT_SKILL_KEYS_V6,
            CODE_ENGINEER_STARTER_SKILL_KEYS_V3,
            CODE_ENGINEER_STARTER_SKILL_KEYS_V4,
            CODE_ENGINEER_STARTER_SKILL_KEYS_V7,
            LOCKED_TEMPLATE_SKILL_AGENT_IDS,
            OSS_STARTER_SKILL_KEYS_TO_UNASSIGN,
            STARTER_AGENT_ROSTER_VERSION,
            STARTER_AGENT_TEMPLATE_IDS,
        )

        default_agent = (
            Agent.objects.select_for_update()
            .filter(
                id=default_agent_id,
                organization_id=organization_id,
                owner_user_id=getattr(self.user, 'id', None),
                is_default=True,
                is_active=True,
            )
            .first()
        )
        if default_agent is None:
            raise ServiceError(
                'DEFAULT_AGENT_NOT_FOUND',
                '默认 Agent 不存在，无法初始化首发分身',
                409,
            )

        settings = (
            dict(default_agent.settings)
            if isinstance(default_agent.settings, dict)
            else {}
        )
        try:
            provisioned_version = int(
                settings.get(AGENT_SETTINGS_STARTER_ROSTER_VERSION_KEY, 0) or 0
            )
        except (TypeError, ValueError):
            provisioned_version = 0
        if provisioned_version >= STARTER_AGENT_ROSTER_VERSION:
            return default_agent

        templates = {
            template_id: get_agent_template(template_id)
            for template_id in STARTER_AGENT_TEMPLATE_IDS
        }
        missing_template_ids = [
            template_id
            for template_id, template in templates.items()
            if template is None
        ]
        if missing_template_ids:
            raise ServiceError(
                'STARTER_AGENT_TEMPLATE_MISSING',
                f'首发 Agent 模板缺失: {", ".join(missing_template_ids)}',
                500,
            )

        # 阵容版本升级时补齐品牌头像与简短出厂规则；只填空值，不覆盖用户修改，
        # 也不更新 updated_at，避免系统补偿被展示成「刚刚使用」。
        bundled_templates = {
            template.id: template
            for template in list_agent_templates()
        }
        existing_template_agents = list(
            Agent.objects.filter(
                organization_id=organization_id,
                owner_user_id=self.user.id,
                template_id__in=bundled_templates,
            )
        )
        agents_to_update = []
        for existing_agent in existing_template_agents:
            template = bundled_templates[existing_agent.template_id]
            existing_settings = (
                dict(existing_agent.settings)
                if isinstance(existing_agent.settings, dict)
                else {}
            )
            changed = False
            if template.avatar_key and not existing_settings.get('avatar_key'):
                existing_settings['avatar_key'] = template.avatar_key
                existing_agent.settings = existing_settings
                changed = True
            if (
                template.initial_rules
                and not (existing_agent.custom_rules or '').strip()
            ):
                existing_agent.custom_rules = template.initial_rules
                changed = True
            if changed:
                agents_to_update.append(existing_agent)
        if agents_to_update:
            Agent.objects.bulk_update(
                agents_to_update,
                ['settings', 'custom_rules'],
            )

        # v3/v4 compatibility exception：代码版默认携带一组小而稳的工程流程 Skill。
        # 先按历史版本只补数据库里从未出现过的行；v8 会在下方把四个核心分身
        # 的模板能力基线统一重开并锁定。升级快照来自 onboarding_defaults。
        if provisioned_version < 7:
            from apps.skills.models import AgentSkillLink

            code_agents = [
                agent for agent in existing_template_agents
                if agent.template_id == 'code-engineer'
            ]
            for code_agent in code_agents:
                existing_keys = set(
                    AgentSkillLink.objects.filter(agent_id=code_agent.id)
                    .values_list('skill_canonical_key', flat=True)
                )
                versioned_skill_sets = (
                    (3, CODE_ENGINEER_STARTER_SKILL_KEYS_V3),
                    (4, CODE_ENGINEER_STARTER_SKILL_KEYS_V4),
                    (7, CODE_ENGINEER_STARTER_SKILL_KEYS_V7),
                )
                for target_version, skill_keys in versioned_skill_sets:
                    if provisioned_version >= target_version:
                        continue
                    missing_keys = [
                        key for key in skill_keys
                        if key not in existing_keys
                    ]
                    self._copy_template_skills(code_agent, missing_keys)
                    existing_keys.update(missing_keys)

                # v3-v5 是本轮尚未发布的开发版本：只清理由这些版本默认带入的
                # 评审/门禁 Skill。正式环境当前为 v2，因此不会碰历史手动安装。
                if provisioned_version in {3, 4, 5}:
                    AgentSkillLink.objects.filter(
                        agent_id=code_agent.id,
                        skill_canonical_key__in=(
                            CODE_ENGINEER_REMOVED_DEFAULT_SKILL_KEYS_V6
                        ),
                    ).delete()

        # 系统默认小Tin继续保留原名称与「全能力默认 Agent」语义，只补模板出厂
        # 展示信息；已有自定义值一律优先，避免覆盖用户调整。
        daily_template = templates["general-assistant"]
        if daily_template.avatar_key:
            settings.setdefault('avatar_key', daily_template.avatar_key)
        if daily_template.icon:
            settings.setdefault('icon', daily_template.icon)
        if daily_template.welcome_message:
            settings.setdefault('welcome_message', daily_template.welcome_message)
        if daily_template.default_mode:
            settings.setdefault('default_mode', daily_template.default_mode)
        if not default_agent.goal:
            default_agent.goal = daily_template.goal
        if (
            daily_template.initial_rules
            and not (default_agent.custom_rules or '').strip()
        ):
            default_agent.custom_rules = daily_template.initial_rules
        if not default_agent.suggested_prompts:
            default_agent.suggested_prompts = list(daily_template.suggested_prompts)
        if not default_agent.template_id:
            default_agent.template_id = daily_template.id
            default_agent.template_version = daily_template.version

        if provisioned_version < 8:
            immutable_specialists = [
                agent for agent in existing_template_agents
                if agent.template_id in LOCKED_TEMPLATE_SKILL_AGENT_IDS
                and agent.id != default_agent.id
            ]
            for starter_agent in [default_agent, *immutable_specialists]:
                template = templates.get(starter_agent.template_id)
                if template is not None:
                    self._ensure_template_skills_enabled(
                        starter_agent,
                        template.skills,
                    )

        if provisioned_version < 9:
            from apps.skills.models import AgentSkillLink

            oss_agent_ids = [
                agent.id for agent in existing_template_agents
                if agent.template_id in {"doc-writer", "data-analyst"}
            ]
            if oss_agent_ids:
                AgentSkillLink.objects.filter(
                    agent_id__in=oss_agent_ids,
                    skill_canonical_key__in=OSS_STARTER_SKILL_KEYS_TO_UNASSIGN,
                ).delete()

        for template_id in STARTER_AGENT_TEMPLATE_IDS[1:]:
            already_seen = Agent.objects.filter(
                organization_id=organization_id,
                owner_user_id=self.user.id,
                template_id=template_id,
            ).exists()
            if already_seen:
                continue
            prepared = self._prepare_agent_creation(
                organization_id,
                '',
                template_id=template_id,
                raise_on_error=True,
                system_provisioning=True,
            )
            template_skills = prepared.pop('template_skills')
            specialist = Agent.objects.create(**prepared)
            self._copy_template_skills(specialist, template_skills)

        settings[
            AGENT_SETTINGS_STARTER_ROSTER_VERSION_KEY
        ] = STARTER_AGENT_ROSTER_VERSION
        default_agent.settings = settings
        default_agent.save(
            update_fields=[
                'settings',
                'custom_rules',
                'goal',
                'suggested_prompts',
                'template_id',
                'template_version',
                'updated_at',
            ]
        )
        return default_agent

    def _demote_non_system_default_agents(
        self,
        organization_id: UUID,
        owner_id,
    ) -> int:
        """将非系统 provenance 的 is_default 清掉。"""
        from apps.tabtinspace.services.onboarding_defaults import is_system_default_agent

        demoted = 0
        candidates = (
            Agent.objects
            .select_for_update()
            .filter(
                organization_id=organization_id,
                owner_user_id=owner_id,
                is_default=True,
            )
            .order_by('created_at', 'id')
        )
        for agent in candidates:
            if is_system_default_agent(agent):
                continue
            agent.is_default = False
            agent.save(update_fields=['is_default', 'updated_at'])
            demoted += 1
            _logger.info(
                "default_agent.demote_migrated agent=%s org=%s owner=%s",
                agent.id,
                organization_id,
                owner_id,
            )
        return demoted

    def _find_system_default_agent(
        self,
        organization_id: UUID,
        owner_id,
        *,
        is_active: bool,
        for_update: bool,
    ) -> Optional[Agent]:
        from apps.tabtinspace.services.onboarding_defaults import is_system_default_agent

        qs = Agent.objects.filter(
            organization_id=organization_id,
            owner_user_id=owner_id,
            is_default=True,
            is_active=is_active,
        ).order_by('created_at', 'id')
        if for_update:
            qs = qs.select_for_update()
        for agent in qs:
            if is_system_default_agent(agent):
                return agent
        return None

    def _find_active_default_agent(self, organization_id: UUID, owner_id) -> Optional[Agent]:
        return (
            Agent.objects
            .filter(
                organization_id=organization_id,
                owner_user_id=owner_id,
                is_default=True,
                is_active=True,
            )
            .order_by('created_at', 'id')
            .first()
        )

    @transaction.atomic(using=postgres_app_db_alias())
    def delete_agent(self, agent_id: UUID) -> bool:
        """停用 Agent；Workspace 生命周期保持独立。

        Returns:
            True if deleted, False otherwise.

        Raises:
            ServiceError: 权限不足，或试图删除默认 / 最后一只 Agent。
        """
        from .base import ServiceError

        agent = Agent.objects.filter(id=agent_id).first()
        if not agent:
            return False
        if not self.check_agent_owner(agent):
            raise ServiceError('PERMISSION_DENIED', '仅 Agent 归属用户可删除此 Agent', 403)
        if agent.is_default:
            raise ServiceError(
                'DEFAULT_AGENT_PROTECTED',
                '默认 Agent 不可删除',
                403,
            )

        active_count = Agent.objects.filter(
            organization_id=agent.organization_id,
            owner_user_id=agent.owner_user_id,
            is_active=True,
        ).count()
        if active_count <= 1:
            raise ServiceError(
                'LAST_AGENT_PROTECTED',
                '至少保留一个 Agent',
                403,
            )

        agent.is_active = False
        agent.save(update_fields=['is_active', 'updated_at'])

        return True

    @transaction.atomic(using=postgres_app_db_alias())
    def permanently_delete_agent(self, agent_id: UUID) -> bool:
        """永久删除已停用 Agent，并按各领域外键契约处理关联数据。"""
        from .base import ServiceError

        agent = Agent.objects.select_for_update().filter(id=agent_id).first()
        if not agent:
            return False
        if not self.check_agent_owner(agent):
            raise ServiceError(
                'PERMISSION_DENIED',
                '仅 Agent 归属用户可彻底删除此 Agent',
                403,
            )
        if agent.is_default:
            raise ServiceError(
                'DEFAULT_AGENT_PROTECTED',
                '默认 Agent 不可删除',
                403,
            )
        if agent.is_active:
            raise ServiceError(
                'AGENT_MUST_BE_DEACTIVATED',
                '请先停用 Agent，再彻底删除',
                409,
            )

        organization_id = agent.organization_id
        owner_user_id = agent.owner_user_id
        try:
            agent.delete()
        except ProtectedError as exc:
            _logger.warning(
                'Agent 永久删除被受保护记录阻止: agent_id=%s organization_id=%s owner_user_id=%s',
                agent_id,
                organization_id,
                owner_user_id,
            )
            raise ServiceError(
                'AGENT_HAS_PROTECTED_HISTORY',
                '该 Agent 仍有受保护的执行记录，暂时无法彻底删除',
                409,
            ) from exc

        _logger.info(
            'Agent 已永久删除: agent_id=%s organization_id=%s owner_user_id=%s',
            agent_id,
            organization_id,
            owner_user_id,
        )
        return True

    @transaction.atomic(using=postgres_app_db_alias())
    def reactivate_agent(self, agent_id: UUID) -> bool:
        """重新激活已停用的 Agent；不修改 Workspace。"""
        from .base import ServiceError

        agent = Agent.objects.filter(id=agent_id).first()
        if not agent:
            return False
        if not self.check_agent_owner(agent):
            raise ServiceError('PERMISSION_DENIED', '仅 Agent 归属用户可操作此 Agent', 403)
        if agent.is_active:
            return True

        if not agent.template_id and not agent.is_default:
            Organization.objects.select_for_update().get(id=agent.organization_id)
            # ：系统默认小Tin 不计自建配额
            active_custom_count = Agent.objects.filter(
                organization_id=agent.organization_id,
                owner_user_id=agent.owner_user_id,
                type='bot',
                template_id='',
                is_active=True,
                is_default=False,
            ).count()
            if active_custom_count >= MAX_CUSTOM_BOT_AGENTS:
                raise ServiceError(
                    'AGENT_LIMIT_EXCEEDED',
                    f'Agent 数量已达上限（{MAX_CUSTOM_BOT_AGENTS} 个）',
                    409,
                )

        agent.is_active = True
        agent.save(update_fields=['is_active', 'updated_at'])

        return True

    @staticmethod
    def _notify_permission_mode_update(space, new_mode: str) -> None:
        try:
            from apps.services.common.agent_protocol.constants import PromptForwardEvent as PFE
            from apps.services.common.agent_protocol.namespace import device_action_topic
            from apps.tabtinspace.services.execution_binding import resolve_control_device
            from apps.services.common.ws.bus import publish_ws_event
            from apps.services.common.ws.protocol import build_envelope, new_event_id
            from django.core.cache import cache

            # ：只通知 Agent 显式绑定且在线的 control_device；禁止同 org 任意 Electron。
            fingerprint = None
            bound = resolve_control_device(space=space)
            if bound and getattr(bound, 'device_type', None) in DEVICE_RUNTIME_TYPES:
                status = getattr(bound, 'status', None)
                if status in ('online', 'busy'):
                    fingerprint = getattr(bound, 'fingerprint', None)

            if not fingerprint:
                return

            envelope = build_envelope(
                PFE.PERMISSION_MODE_UPDATE,
                new_event_id(),
                {
                    "permission_mode": new_mode,
                    "space_id": str(space.id),
                },
                organization_id=str(getattr(space, 'organization_id', '') or ''),
            )
            publish_ws_event(device_action_topic(fingerprint), envelope)
        except Exception as exc:
            _logger.warning("[Agent] Failed to publish permission mode update: %s", exc)
