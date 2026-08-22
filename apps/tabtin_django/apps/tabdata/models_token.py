"""
Open API Token 模型

为外部集成、Agent、自动化流程提供受控的表格数据访问令牌。

设计参考：
- GitHub Personal Access Token（前缀识别 + hash 存储）
"""

import hashlib
import hmac
import secrets
import uuid

from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db import connections, models, transaction
from django.utils import timezone

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.error_codes import ErrorCode

User = get_user_model()


# ── Scope 定义 ──────────────────────────────────────────

VALID_SCOPES = {
    # 表格
    'table:read', 'table:create', 'table:update', 'table:delete',
    # 记录
    'record:read', 'record:create', 'record:update', 'record:delete',
    # 字段
    'field:read', 'field:create', 'field:update', 'field:delete',
    # 视图
    'view:read', 'view:create', 'view:update', 'view:delete',
    # 存储
    'storage:read',   # List files, download, get metadata
    'storage:write',  # Upload, delete files
    # 高级
    'aggregation:read',
    'import:write',
    'export:read',
    'webhook:manage',
    'db_connection:manage',
    # Agent SQL
    'sql:query',
    'sql:execute',
    # RLS 策略
    'policy:read',
    'policy:manage',
    # Token 自管理
    'token:read',
    'token:manage',
    # 数据连接器
    'connector:read',
    'connector:manage',
    # API 分析
    'analytics:read',
}

# 预设 scope 组合
SCOPE_PRESETS = {
    'readonly': [
        'table:read', 'record:read', 'field:read', 'view:read',
        'aggregation:read', 'sql:query',
        'storage:read',
    ],
    'tabsite_dashboard': [
        'table:read', 'record:read', 'field:read', 'view:read',
        'aggregation:read',
    ],
    'readwrite': [
        'table:read', 'table:create', 'table:update',
        'record:read', 'record:create', 'record:update', 'record:delete',
        'field:read', 'field:create', 'field:update',
        'view:read', 'view:create', 'view:update',
        'aggregation:read',
        'import:write', 'export:read',
        'sql:query', 'sql:execute',
        'storage:read', 'storage:write',
    ],
    'full': list(VALID_SCOPES),
}

# Token 前缀
TOKEN_PREFIX = 'ttn_'
TOKEN_RATE_LIMIT_FALLBACK = 60
ANALYZE_UNSET = object()
MAX_GOVERNANCE_GRAPH_LOCK_ATTEMPTS = 5


def _generate_token_id() -> str:
    """生成 12 字符的 token 标识符（用于列表展示）。
    使用 hex 编码，保证不含 _ 或 - 等分隔符。"""
    return secrets.token_hex(6)  # 6 bytes → 12 hex chars


def _generate_token_sign() -> str:
    """生成 32 字符的 token 签名（用于认证）。
    使用 hex 编码，保证不含 _ 或 - 等分隔符。"""
    return secrets.token_hex(16)  # 16 bytes → 32 hex chars


def _hash_token(raw: str) -> str:
    """SHA-256 hash token（不可逆）"""
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()


def _normalize_token_rate_limit_ceiling(rate_limit):
    """与认证层保持一致：0 视为默认 60，负数保留给上层判定为异常。"""
    if rate_limit is None:
        return None
    if rate_limit == 0:
        return TOKEN_RATE_LIMIT_FALLBACK
    return rate_limit


class TokenTargetValidationError(ValidationError):
    """Token 目标范围校验错误，保留 API 层所需状态码与错误码。"""

    def __init__(self, message: str, *, error_code: str, status_code: int):
        super().__init__(message, code=error_code)
        self.api_error_code = error_code
        self.status_code = status_code


class _GovernanceGraphRetryRequired(RuntimeError):
    """内部控制流：锁后发现图变化，需释放当前锁集并整轮重试。"""


def _ensure_governance_atomic_block():
    """治理锁图依赖外层事务持有最终锁，禁止脱离 transaction.atomic 使用。"""
    connection = transaction.get_connection(using=TABDATA_DB_ALIAS)
    if not connection.in_atomic_block:
        raise RuntimeError(
            'Token 治理锁图必须运行在 transaction.atomic(using=TABDATA_DB_ALIAS) 内'
        )


def _normalize_uuid_list(values, field_name: str):
    """规范化 UUID 列表，去重并保留原始顺序。"""
    if values is None:
        return None

    normalized = []
    seen = set()
    for raw in values:
        try:
            normalized_id = str(uuid.UUID(str(raw)))
        except (TypeError, ValueError) as exc:
            raise TokenTargetValidationError(
                f'{field_name} 包含非法 UUID: {raw}',
                error_code=ErrorCode.VALIDATION_ERROR,
                status_code=400,
            ) from exc
        if normalized_id in seen:
            continue
        seen.add(normalized_id)
        normalized.append(normalized_id)
    return normalized


class TableApiToken(models.Model):
    """
    Open API 访问令牌

    Token 格式: ttn_{token_id}_{token_sign}
    存储: 只存 token_id 和 sign 的 SHA-256 hash
    创建时一次性返回明文，之后不可再查看。
    """

    id = models.UUIDField(
        primary_key=True,
        default=uuid.uuid4,
        verbose_name='Token ID',
    )
    name = models.CharField(
        max_length=100,
        verbose_name='名称',
    )
    description = models.TextField(
        blank=True,
        default='',
        verbose_name='描述',
    )
    user = models.ForeignKey(
        User,
        on_delete=models.CASCADE,
        related_name='api_tokens',
        verbose_name='所属用户',
    )
    parent_token = models.ForeignKey(
        'self',
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name='child_tokens',
        verbose_name='父 Token',
        help_text='null 表示根 Token；非空表示由父 Token 委托派生',
    )
    # ：space FK 已 Drop（0045）；归属走 space_ids JSON scope。

    # ── Token 安全 ──
    token_id = models.CharField(
        max_length=16,
        unique=True,
        verbose_name='Token 标识',
        help_text='用于列表展示，格式 ttn_{token_id}...',
    )
    sign_hash = models.CharField(
        max_length=64,
        verbose_name='签名 Hash',
        help_text='token_sign 的 SHA-256 hash',
    )

    # ── 权限控制 ──
    scopes = models.JSONField(
        default=list,
        verbose_name='权限范围',
        help_text='如 ["table:read", "record:write"]',
    )
    space_ids = models.JSONField(
        null=True,
        blank=True,
        verbose_name='限定 Space',
        help_text='null 表示用户所有可访问 Space',
    )
    table_ids = models.JSONField(
        null=True,
        blank=True,
        verbose_name='限定表格',
        help_text='null 表示项目内所有表格',
    )

    # ── 限制 ──
    rate_limit = models.IntegerField(
        default=60,
        verbose_name='限流（次/分钟）',
    )
    expired_at = models.DateTimeField(
        null=True,
        blank=True,
        verbose_name='过期时间',
        help_text='null 表示永不过期',
    )

    # ── 状态追踪 ──
    is_active = models.BooleanField(
        default=True,
        db_index=True,
        verbose_name='是否激活',
    )
    last_used_at = models.DateTimeField(
        null=True,
        blank=True,
        verbose_name='最后使用时间',
    )
    use_count = models.PositiveIntegerField(
        default=0,
        verbose_name='使用次数',
    )

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'tabdata_api_token'
        verbose_name = 'API Token'
        verbose_name_plural = 'API Tokens'
        ordering = ['-created_at']
        indexes = [
            models.Index(fields=['user', 'is_active']),
            models.Index(fields=['token_id']),
        ]

    def __str__(self):
        return f"{self.name} ({TOKEN_PREFIX}{self.token_id}...)"

    @staticmethod
    def _get_validation_user(user, user_id):
        """获取用于权限校验的 User 实例。"""
        if user is not None and getattr(user, 'id', None):
            return user
        if not user_id:
            raise TokenTargetValidationError(
                'Token 缺少所属用户，无法校验范围',
                error_code=ErrorCode.VALIDATION_ERROR,
                status_code=400,
            )
        try:
            return User.objects.using('default').get(id=user_id, is_active=True)
        except User.DoesNotExist as exc:
            raise TokenTargetValidationError(
                'Token 所属用户不存在或已失效',
                error_code=ErrorCode.PERMISSION_DENIED,
                status_code=403,
            ) from exc

    @classmethod
    def validate_scope_targets_for_user(cls, user, space_ids=None, table_ids=None):
        """校验并规范化 Token 的资源范围。"""
        from apps.tabdata.models import Table
        from apps.tabdata.services.base import BaseService as TabDataBaseService

        normalized_space_ids = _normalize_uuid_list(space_ids, 'space_ids')
        normalized_table_ids = _normalize_uuid_list(table_ids, 'table_ids')

        access_service = TabDataBaseService(user=user)
        space_scope_specified = normalized_space_ids is not None
        allowed_space_ids = set(normalized_space_ids or [])

        if space_scope_specified:
            from apps.tabtinspace.services.host_resolver import existing_host_ids
            existing_space_ids = existing_host_ids(normalized_space_ids)
            missing_space_ids = [space_id for space_id in normalized_space_ids if space_id not in existing_space_ids]
            if missing_space_ids:
                raise TokenTargetValidationError(
                    f'space_ids 包含不存在的 Space: {", ".join(missing_space_ids)}',
                    error_code=ErrorCode.VALIDATION_ERROR,
                    status_code=400,
                )

            denied_space_ids = [
                space_id
                for space_id in normalized_space_ids
                if not access_service.check_space_permission(space_id, 'viewer')
            ]
            if denied_space_ids:
                raise TokenTargetValidationError(
                    f'无权将这些 Space 授权给 Token: {", ".join(denied_space_ids)}',
                    error_code=ErrorCode.PERMISSION_DENIED,
                    status_code=403,
                )

        if normalized_table_ids is not None:
            tables_by_id = {
                str(table.id): table
                for table in Table.objects.using(TABDATA_DB_ALIAS)
                .filter(id__in=normalized_table_ids)
                .only('id', 'space_id')
            }
            missing_table_ids = [table_id for table_id in normalized_table_ids if table_id not in tables_by_id]
            if missing_table_ids:
                raise TokenTargetValidationError(
                    f'table_ids 包含不存在的表格: {", ".join(missing_table_ids)}',
                    error_code=ErrorCode.VALIDATION_ERROR,
                    status_code=400,
                )

            denied_table_ids = []
            out_of_scope_table_ids = []
            for table_id in normalized_table_ids:
                if not access_service.check_table_permission(table_id, 'viewer'):
                    denied_table_ids.append(table_id)
                    continue

                table_space_id = str(tables_by_id[table_id].space_id) if tables_by_id[table_id].space_id else None
                if space_scope_specified and table_space_id not in allowed_space_ids:
                    out_of_scope_table_ids.append(table_id)

            if denied_table_ids:
                raise TokenTargetValidationError(
                    f'无权将这些表格授权给 Token: {", ".join(denied_table_ids)}',
                    error_code=ErrorCode.PERMISSION_DENIED,
                    status_code=403,
                )

            if out_of_scope_table_ids:
                raise TokenTargetValidationError(
                    f'table_ids 必须属于 space_ids 指定的 Space: {", ".join(out_of_scope_table_ids)}',
                    error_code=ErrorCode.VALIDATION_ERROR,
                    status_code=400,
                )

        return {
            'space_ids': normalized_space_ids,
            'table_ids': normalized_table_ids,
        }

    def validate_scope_targets(self):
        """对当前实例做目标范围校验，并原位写回规范化结果。"""
        user = self._get_validation_user(getattr(self, 'user', None), self.user_id)
        normalized = self.validate_scope_targets_for_user(
            user,
            self.space_ids,
            self.table_ids,
        )
        self.space_ids = normalized['space_ids']
        self.table_ids = normalized['table_ids']
        return normalized

    @classmethod
    def validate_scope_list(cls, scopes):
        """校验 scope 列表是否合法。"""
        if not scopes:
            raise TokenTargetValidationError(
                'Token 至少需要一个 scope',
                error_code=ErrorCode.INVALID_SCOPE,
                status_code=400,
            )

        invalid = sorted(set(scopes) - VALID_SCOPES)
        if invalid:
            raise TokenTargetValidationError(
                f'无效的 scope: {", ".join(invalid)}',
                error_code=ErrorCode.INVALID_SCOPE,
                status_code=400,
            )
        return scopes

    def validate_scopes(self):
        """对当前实例做 scope 合法性校验。"""
        self.scopes = self.validate_scope_list(self.scopes)
        return self.scopes

    @classmethod
    def validate_within_parent_boundary(
        cls,
        parent_token,
        *,
        scopes,
        space_ids,
        table_ids,
        rate_limit=None,
        expired_at=None,
        actor_label='父 Token',
    ):
        """校验候选 Token 是否仍在父 Token 边界内。"""
        if parent_token is None:
            return

        parent_scopes = set(parent_token.scopes or [])
        extra_scopes = [scope for scope in scopes or [] if scope not in parent_scopes]
        if extra_scopes:
            raise TokenTargetValidationError(
                f'{actor_label} 的 scope 范围未覆盖: {", ".join(extra_scopes)}',
                error_code=ErrorCode.PERMISSION_DENIED,
                status_code=403,
            )

        if parent_token.space_ids is not None:
            if space_ids is None:
                raise TokenTargetValidationError(
                    f'{actor_label} 不能移除 Space 范围限制',
                    error_code=ErrorCode.PERMISSION_DENIED,
                    status_code=403,
                )
            parent_space_ids = {str(space_id) for space_id in parent_token.space_ids}
            extra_space_ids = [space_id for space_id in space_ids if space_id not in parent_space_ids]
            if extra_space_ids:
                raise TokenTargetValidationError(
                    f'{actor_label} 的 Space 范围未覆盖: {", ".join(extra_space_ids)}',
                    error_code=ErrorCode.PERMISSION_DENIED,
                    status_code=403,
                )

        if parent_token.table_ids is not None:
            if table_ids is None:
                raise TokenTargetValidationError(
                    f'{actor_label} 不能移除表格范围限制',
                    error_code=ErrorCode.PERMISSION_DENIED,
                    status_code=403,
                )
            parent_table_ids = {str(table_id) for table_id in parent_token.table_ids}
            extra_table_ids = [table_id for table_id in table_ids if table_id not in parent_table_ids]
            if extra_table_ids:
                raise TokenTargetValidationError(
                    f'{actor_label} 的表格范围未覆盖: {", ".join(extra_table_ids)}',
                    error_code=ErrorCode.PERMISSION_DENIED,
                    status_code=403,
                )

        parent_rate_limit_ceiling = _normalize_token_rate_limit_ceiling(parent_token.rate_limit)
        candidate_rate_limit_ceiling = _normalize_token_rate_limit_ceiling(rate_limit)
        if parent_rate_limit_ceiling is not None and candidate_rate_limit_ceiling is not None:
            if parent_rate_limit_ceiling < 0:
                raise TokenTargetValidationError(
                    f'{actor_label} 的 rate_limit 配置异常，无法继续委托管理',
                    error_code=ErrorCode.PERMISSION_DENIED,
                    status_code=403,
                )
            if candidate_rate_limit_ceiling < 0:
                raise TokenTargetValidationError(
                    '目标 Token 的 rate_limit 配置异常，无法继续委托管理',
                    error_code=ErrorCode.PERMISSION_DENIED,
                    status_code=403,
                )
            if candidate_rate_limit_ceiling > parent_rate_limit_ceiling:
                raise TokenTargetValidationError(
                    f'{actor_label} 的 rate_limit 上限为 {parent_rate_limit_ceiling}',
                    error_code=ErrorCode.PERMISSION_DENIED,
                    status_code=403,
                )

        if parent_token.expired_at is not None:
            if expired_at is None:
                raise TokenTargetValidationError(
                    f'{actor_label} 不能移除过期时间限制',
                    error_code=ErrorCode.PERMISSION_DENIED,
                    status_code=403,
                )
            if expired_at > parent_token.expired_at:
                raise TokenTargetValidationError(
                    f'{actor_label} 不能创建或管理过期时间更晚的 Token',
                    error_code=ErrorCode.PERMISSION_DENIED,
                    status_code=403,
                )

    def _get_parent_token_for_validation(self):
        """获取用于结构与 boundary 校验的父 Token。"""
        parent_token = getattr(self, 'parent_token', None)
        if parent_token is not None:
            if getattr(parent_token, 'pk', None) is None:
                raise TokenTargetValidationError(
                    '父 Token 尚未保存，无法建立委托关系',
                    error_code=ErrorCode.VALIDATION_ERROR,
                    status_code=400,
                )
            return parent_token

        if not self.parent_token_id:
            return None

        try:
            return self.__class__.objects.using(TABDATA_DB_ALIAS).get(pk=self.parent_token_id)
        except self.__class__.DoesNotExist as exc:
            raise TokenTargetValidationError(
                '父 Token 不存在，无法建立委托关系',
                error_code=ErrorCode.VALIDATION_ERROR,
                status_code=400,
            ) from exc

    MAX_DELEGATION_DEPTH = 10

    def iter_ancestor_tokens(self, *, lock_chain: bool = False):
        """按父 -> 祖父顺序遍历祖先链。"""
        next_parent_id = self.parent_token_id
        visited = {str(self.pk)} if self.pk else set()
        depth = 0

        while next_parent_id:
            depth += 1
            if depth > self.MAX_DELEGATION_DEPTH:
                raise TokenTargetValidationError(
                    f'委托链深度超过上限（{self.MAX_DELEGATION_DEPTH}），拒绝遍历',
                    error_code=ErrorCode.VALIDATION_ERROR,
                    status_code=400,
                )
            parent_id = str(next_parent_id)
            if parent_id in visited:
                raise TokenTargetValidationError(
                    'Token 父子关系存在循环，无法解析委托链',
                    error_code=ErrorCode.VALIDATION_ERROR,
                    status_code=400,
                )
            visited.add(parent_id)
            try:
                parent_queryset = self.__class__.objects.using(TABDATA_DB_ALIAS)
                if lock_chain:
                    parent_queryset = parent_queryset.select_for_update()
                parent_token = parent_queryset.get(pk=next_parent_id)
            except self.__class__.DoesNotExist as exc:
                raise TokenTargetValidationError(
                    'Token 父链路已损坏，无法继续委托校验',
                    error_code=ErrorCode.VALIDATION_ERROR,
                    status_code=400,
                ) from exc

            yield parent_token
            next_parent_id = parent_token.parent_token_id

    def validate_parent_delegation(self, *, lock_ancestors: bool = False):
        """校验父子委托关系的结构与直接 boundary。"""
        parent_token = self._get_parent_token_for_validation()
        if parent_token is None:
            return None

        if self.pk and str(parent_token.pk) == str(self.pk):
            raise TokenTargetValidationError(
                'Token 不能将自己设为父 Token',
                error_code=ErrorCode.VALIDATION_ERROR,
                status_code=400,
            )

        if str(parent_token.user_id) != str(self.user_id):
            raise TokenTargetValidationError(
                '父 Token 必须属于同一用户',
                error_code=ErrorCode.VALIDATION_ERROR,
                status_code=400,
            )

        visited = {str(self.pk)} if self.pk else set()
        current = parent_token
        current_child = self
        depth = 0
        while current is not None:
            depth += 1
            if depth > self.MAX_DELEGATION_DEPTH:
                raise TokenTargetValidationError(
                    f'委托链深度超过上限（{self.MAX_DELEGATION_DEPTH}），无法建立委托关系',
                    error_code=ErrorCode.VALIDATION_ERROR,
                    status_code=400,
                )
            current_id = str(current.pk)
            if current_id in visited:
                raise TokenTargetValidationError(
                    'Token 父子关系存在循环，无法建立委托链',
                    error_code=ErrorCode.VALIDATION_ERROR,
                    status_code=400,
                )
            visited.add(current_id)

            if str(current.user_id) != str(self.user_id):
                raise TokenTargetValidationError(
                    '整条 Token 委托链必须属于同一用户',
                    error_code=ErrorCode.VALIDATION_ERROR,
                    status_code=400,
                )

            if not current.is_active and current_child.is_active:
                raise TokenTargetValidationError(
                    '激活中的 Token 不能挂载到未激活的父 Token 下',
                    error_code=ErrorCode.VALIDATION_ERROR,
                    status_code=400,
                )

            self.validate_within_parent_boundary(
                current,
                scopes=current_child.scopes,
                space_ids=current_child.space_ids,
                table_ids=current_child.table_ids,
                rate_limit=current_child.rate_limit,
                expired_at=current_child.expired_at,
                actor_label='父 Token' if current_id == str(parent_token.pk) else '祖先 Token',
            )

            if not current.parent_token_id:
                break

            try:
                current_child = current
                qs = self.__class__.objects.using(TABDATA_DB_ALIAS).only(
                    'id',
                    'user_id',
                    'parent_token_id',
                    'is_active',
                    'scopes',
                    'space_ids',
                    'table_ids',
                    'rate_limit',
                    'expired_at',
                )
                if lock_ancestors:
                    qs = qs.select_for_update()
                current = qs.get(pk=current.parent_token_id)
            except self.__class__.DoesNotExist as exc:
                raise TokenTargetValidationError(
                    'Token 父链路已损坏，无法建立委托链',
                    error_code=ErrorCode.VALIDATION_ERROR,
                    status_code=400,
                ) from exc
        return parent_token

    def iter_child_tokens(self):
        """遍历直接子 Token。"""
        if self.pk is None:
            return []
        return self.__class__.objects.using(TABDATA_DB_ALIAS).filter(
            parent_token_id=self.pk,
            user_id=self.user_id,
        ).order_by('created_at', 'id')

    def iter_descendant_tokens(self):
        """按广度优先遍历整棵子树，受 MAX_DELEGATION_DEPTH 约束。"""
        pending: list[tuple] = [(child, 1) for child in self.iter_child_tokens()]
        visited = {str(self.pk)} if self.pk else set()
        while pending:
            token, depth = pending.pop(0)
            if depth > self.MAX_DELEGATION_DEPTH:
                raise TokenTargetValidationError(
                    f'Token 子树深度超过上限（{self.MAX_DELEGATION_DEPTH}），拒绝遍历',
                    error_code=ErrorCode.VALIDATION_ERROR,
                    status_code=400,
                )
            token_id = str(token.pk)
            if token_id in visited:
                raise TokenTargetValidationError(
                    'Token 子树存在循环，无法遍历治理范围',
                    error_code=ErrorCode.VALIDATION_ERROR,
                    status_code=400,
                )
            visited.add(token_id)
            yield token
            pending.extend(
                (child, depth + 1) for child in token.iter_child_tokens()
            )

    @staticmethod
    def _build_transition_issue(token, message: str, *, reason_code: str, error_code: str, status_code: int, affected_subtree_size: int = 1):
        return {
            'token_id': str(token.id) if getattr(token, 'id', None) else '',
            'token_name': getattr(token, 'name', ''),
            'parent_token_id': str(getattr(token, 'parent_token_id', '') or ''),
            'reason_code': reason_code,
            'error_code': error_code,
            'status_code': status_code,
            'message': message,
            'affected_subtree_size': affected_subtree_size,
        }

    @staticmethod
    def _build_transition_warning(message: str, *, reason_code: str, affected_subtree_size: int = 0):
        return {
            'reason_code': reason_code,
            'message': message,
            'affected_subtree_size': affected_subtree_size,
        }

    @staticmethod
    def _serialize_transition_state(token):
        """序列化治理场景下的核心状态快照。"""
        return {
            'name': getattr(token, 'name', ''),
            'description': getattr(token, 'description', ''),
            'parent_token_id': str(getattr(token, 'parent_token_id', None)) if getattr(token, 'parent_token_id', None) else None,
            'scopes': getattr(token, 'scopes', None),
            'space_ids': getattr(token, 'space_ids', None),
            'table_ids': getattr(token, 'table_ids', None),
            'rate_limit': token.get_effective_rate_limit() if hasattr(token, 'get_effective_rate_limit') else getattr(token, 'rate_limit', None),
            'expired_at': token.expired_at.isoformat() if getattr(token, 'expired_at', None) else None,
            'is_active': getattr(token, 'is_active', None),
        }

    def iter_linked_child_tokens(self):
        """遍历父图上的直接子 Token，不按 user_id 过滤。"""
        if self.pk is None:
            return []
        return self.__class__.objects.using(TABDATA_DB_ALIAS).filter(
            parent_token_id=self.pk,
        ).order_by('created_at', 'id')

    def _collect_linked_subtree_tokens(self, *, lock_rows: bool):
        """收集完整父图下的所有直接/间接 child，包含 foreign 节点。"""
        if self.pk is None:
            return []

        descendants = []
        pending = [self]
        visited = {str(self.pk)}
        while pending:
            parent = pending.pop(0)
            children_queryset = self.__class__.objects.using(TABDATA_DB_ALIAS).filter(
                parent_token_id=parent.pk,
            ).order_by('created_at', 'id')
            if lock_rows:
                children_queryset = children_queryset.select_for_update()
            children = list(children_queryset)
            for child in children:
                child_id = str(child.pk)
                if child_id in visited:
                    continue
                visited.add(child_id)
                descendants.append(child)
                pending.append(child)
        return descendants

    def get_direct_child_linkage_summary(self):
        """汇总直接子 Token 的归属情况，用于删除与脏链路治理。"""
        if self.pk is None:
            return {
                'same_user_children': [],
                'foreign_user_children': [],
            }

        children = list(self.iter_linked_child_tokens().only('id', 'name', 'user_id', 'parent_token_id', 'is_active'))
        same_user_children = [child for child in children if str(child.user_id) == str(self.user_id)]
        foreign_user_children = [child for child in children if str(child.user_id) != str(self.user_id)]
        return {
            'same_user_children': same_user_children,
            'foreign_user_children': foreign_user_children,
        }

    def get_graph_visibility_summary(self):
        """统计完整父图中不会纳入当前治理范围的脏派生节点。"""
        if self.pk is None:
            return {
                'foreign_descendant_count': 0,
            }

        foreign_descendant_count = 0
        pending = list(self.iter_linked_child_tokens().only('id', 'user_id', 'parent_token_id'))
        visited = {str(self.pk)}
        while pending:
            token = pending.pop(0)
            token_id = str(token.pk)
            if token_id in visited:
                continue
            visited.add(token_id)
            if str(token.user_id) != str(self.user_id):
                foreign_descendant_count += 1
            pending.extend(list(token.iter_linked_child_tokens().only('id', 'user_id', 'parent_token_id')))
        return {
            'foreign_descendant_count': foreign_descendant_count,
        }

    def _build_cross_user_link_repair_plan_from_graph(self, root, linked_descendants):
        """基于已收集好的完整父图构建 repair plan，不再引入新的锁顺序。"""
        repair_targets = []
        repair_target_ids = set()

        try:
            ancestor_chain_has_foreign = any(
                str(ancestor.user_id) != str(root.user_id)
                for ancestor in root.iter_ancestor_tokens(lock_chain=False)
            )
        except TokenTargetValidationError:
            ancestor_chain_has_foreign = False
        if ancestor_chain_has_foreign:
            repair_targets.append(root)
            repair_target_ids.add(str(root.pk))

        tokens_by_id = {str(root.pk): root}
        tokens_by_id.update({
            str(token.pk): token
            for token in linked_descendants
            if token.pk is not None
        })
        for child in linked_descendants:
            if child.parent_token_id is None:
                continue
            parent = tokens_by_id.get(str(child.parent_token_id))
            if parent is None:
                continue
            child_id = str(child.pk)
            if str(child.user_id) != str(parent.user_id) and child_id not in repair_target_ids:
                repair_targets.append(child)
                repair_target_ids.add(child_id)

        return self._build_cross_user_link_repair_plan_result(repair_targets)

    def _lock_cross_user_repair_graph(
        self,
        *,
        target_missing_message: str,
        target_missing_error_code: str = ErrorCode.NOT_FOUND,
        target_missing_status_code: int = 404,
    ):
        """按全局排序锁住 repair 会读取到的整张父图，避免和治理写路径出现反序。"""
        if self.pk is None:
            raise TokenTargetValidationError(
                '未持久化的 Token 无法执行跨用户 repair',
                error_code=ErrorCode.VALIDATION_ERROR,
                status_code=400,
            )
        _ensure_governance_atomic_block()

        seed_specs = {
            str(self.pk): {
                'missing_message': target_missing_message,
                'error_code': target_missing_error_code,
                'status_code': target_missing_status_code,
            },
        }

        def _remember_token(token, *, missing_message: str, error_code: str = ErrorCode.VALIDATION_ERROR, status_code: int = 400):
            token_id = str(token.pk)
            if token_id in seed_specs:
                return False
            seed_specs[token_id] = {
                'missing_message': missing_message,
                'error_code': error_code,
                'status_code': status_code,
            }
            return True

        root_probe = self.__class__._lock_token_for_governance(
            self.pk,
            missing_message=target_missing_message,
            error_code=target_missing_error_code,
            status_code=target_missing_status_code,
            lock_row=False,
        )
        for ancestor in root_probe._collect_ancestor_tokens(lock_rows=False):
            _remember_token(ancestor, missing_message='Token 父链路已损坏，无法继续跨用户 repair')
        for descendant in root_probe._collect_linked_subtree_tokens(lock_rows=False):
            _remember_token(descendant, missing_message='治理图中的 Token 已不存在，无法继续跨用户 repair')

        for attempt in range(MAX_GOVERNANCE_GRAPH_LOCK_ATTEMPTS):
            try:
                with transaction.atomic(using=TABDATA_DB_ALIAS):
                    locked_seeds = {}
                    pending_ids = sorted(seed_specs.keys())
                    for token_id in pending_ids:
                        spec = seed_specs[token_id]
                        locked_seeds[token_id] = self.__class__._lock_token_for_governance(
                            token_id,
                            missing_message=spec['missing_message'],
                            error_code=spec['error_code'],
                            status_code=spec['status_code'],
                            lock_row=True,
                        )

                    locked_root = locked_seeds[str(self.pk)]
                    ancestor_probe = locked_root._collect_ancestor_tokens(lock_rows=False)
                    descendant_probe = locked_root._collect_linked_subtree_tokens(lock_rows=False)
                    graph_changed = False
                    for ancestor in ancestor_probe:
                        graph_changed = _remember_token(
                            ancestor,
                            missing_message='Token 父链路已损坏，无法继续跨用户 repair',
                        ) or graph_changed
                    for descendant in descendant_probe:
                        graph_changed = _remember_token(
                            descendant,
                            missing_message='治理图中的 Token 已不存在，无法继续跨用户 repair',
                        ) or graph_changed

                    if graph_changed:
                        if attempt >= MAX_GOVERNANCE_GRAPH_LOCK_ATTEMPTS - 1:
                            raise TokenTargetValidationError(
                                '跨用户 repair 图在并发修改中持续变化，请稍后重试',
                                error_code=ErrorCode.VALIDATION_ERROR,
                                status_code=400,
                            )
                        raise _GovernanceGraphRetryRequired()

                    ancestor_tokens = [locked_seeds[str(token.pk)] for token in ancestor_probe]
                    locked_descendants = [locked_seeds[str(token.pk)] for token in descendant_probe]
                    self._sync_from_token(locked_root)
                    return {
                        'token': locked_root,
                        'ancestor_tokens': ancestor_tokens,
                        'linked_descendants': locked_descendants,
                    }
            except _GovernanceGraphRetryRequired:
                continue

        raise TokenTargetValidationError(
            '跨用户 repair 图在并发修改中持续变化，请稍后重试',
            error_code=ErrorCode.VALIDATION_ERROR,
            status_code=400,
        )

    def build_cross_user_link_repair_plan(
        self,
        *,
        lock_graph: bool = False,
        target_missing_message: str = '目标 Token 不存在，无法继续跨用户 repair',
        target_missing_error_code: str = ErrorCode.NOT_FOUND,
        target_missing_status_code: int = 404,
    ):
        """构建跨用户脏链路 repair 计划，切断所有跨用户父子边。"""
        if self.pk is None:
            return {
                'repair_target_tokens': [],
                'repair_target_count': 0,
                'same_user_repair_target_count': 0,
                'foreign_user_repair_target_count': 0,
                'warnings': [],
            }

        if lock_graph:
            context = self._lock_cross_user_repair_graph(
                target_missing_message=target_missing_message,
                target_missing_error_code=target_missing_error_code,
                target_missing_status_code=target_missing_status_code,
            )
            return self._build_cross_user_link_repair_plan_from_graph(
                context['token'],
                context['linked_descendants'],
            )

        root = self.__class__._lock_token_for_governance(
            self.pk,
            missing_message=target_missing_message,
            error_code=target_missing_error_code,
            status_code=target_missing_status_code,
            lock_row=False,
        )
        return self._build_cross_user_link_repair_plan_from_graph(
            root,
            root._collect_linked_subtree_tokens(lock_rows=False),
        )

    def _build_cross_user_link_repair_plan_result(self, repair_targets, *, warnings=None):
        """把 repair target 集合标准化成统一 plan 结构。"""
        warnings = list(warnings or [])
        same_user_repair_target_count = sum(1 for token in repair_targets if str(token.user_id) == str(self.user_id))
        foreign_user_repair_target_count = len(repair_targets) - same_user_repair_target_count
        return {
            'repair_target_tokens': repair_targets,
            'repair_target_count': len(repair_targets),
            'same_user_repair_target_count': same_user_repair_target_count,
            'foreign_user_repair_target_count': foreign_user_repair_target_count,
            'warnings': warnings,
        }

    def stabilize_cross_user_link_repair_plan(self, plan, *, lock_targets: bool = False):
        """在真正执行前，按当前数据库状态复核 repair target，避免基于过期 plan 错 detach。"""
        original_target_ids = [token.pk for token in plan['repair_target_tokens'] if token.pk]
        current_plan = self.build_cross_user_link_repair_plan(lock_graph=lock_targets)
        current_target_ids = {token.pk for token in current_plan['repair_target_tokens'] if token.pk}
        warnings = list(current_plan['warnings'])
        left_scope_count = len([token_id for token_id in original_target_ids if token_id not in current_target_ids])
        if left_scope_count:
            warnings.append(self._build_transition_warning(
                (
                    f'有 {left_scope_count} 个 repair target 已在执行前离开当前 root 的可治理图，'
                    '本次按最新状态跳过'
                ),
                reason_code='repair_targets_left_current_scope',
                affected_subtree_size=left_scope_count,
            ))
        entered_scope_count = len([token_id for token_id in current_target_ids if token_id not in original_target_ids])
        if entered_scope_count:
            warnings.append(self._build_transition_warning(
                (
                    f'有 {entered_scope_count} 个新的 repair target 已在执行前进入当前 root 的可治理图，'
                    '本次已按最新状态一并纳入治理'
                ),
                reason_code='repair_targets_entered_current_scope',
                affected_subtree_size=entered_scope_count,
            ))
        return self._build_cross_user_link_repair_plan_result(
            current_plan['repair_target_tokens'],
            warnings=warnings,
        )

    def collect_root_subtree_health_issues(self):
        """检查当前 Token 作为根节点时，自己的子树是否仍有残余问题。"""
        old_scopes = list(self.scopes) if self.scopes is not None else None
        old_space_ids = list(self.space_ids) if self.space_ids is not None else None
        old_table_ids = list(self.table_ids) if self.table_ids is not None else None
        issues = []
        try:
            try:
                self.validate_scopes()
            except TokenTargetValidationError as exc:
                message = exc.messages[0] if getattr(exc, 'messages', None) else str(exc)
                issues.append(self._build_transition_issue(
                    self,
                    message,
                    reason_code='repair_target_scope_invalid',
                    error_code=getattr(exc, 'api_error_code', ErrorCode.VALIDATION_ERROR),
                    status_code=getattr(exc, 'status_code', 400),
                    affected_subtree_size=1,
                ))

            try:
                self.validate_scope_targets()
            except TokenTargetValidationError as exc:
                message = exc.messages[0] if getattr(exc, 'messages', None) else str(exc)
                issues.append(self._build_transition_issue(
                    self,
                    message,
                    reason_code='repair_target_scope_target_invalid',
                    error_code=getattr(exc, 'api_error_code', ErrorCode.VALIDATION_ERROR),
                    status_code=getattr(exc, 'status_code', 400),
                    affected_subtree_size=1,
                ))

            issues.extend(self.collect_descendant_delegation_issues())
        finally:
            self.scopes = old_scopes
            self.space_ids = old_space_ids
            self.table_ids = old_table_ids
        return issues

    def summarize_cross_user_link_repair_health(self, plan):
        """在跨用户边切断后，汇总同用户 repair target 的残余健康问题。"""
        same_user_targets = [
            token
            for token in plan['repair_target_tokens']
            if str(token.user_id) == str(self.user_id)
        ]
        health_items = []
        total_issue_count = 0
        unhealthy_target_count = 0
        for token in same_user_targets:
            issues = token.collect_root_subtree_health_issues()
            issue_count = len(issues)
            total_issue_count += issue_count
            if issue_count:
                unhealthy_target_count += 1
            health_items.append({
                'token_id': str(token.pk) if token.pk else '',
                'token_state': self._serialize_transition_state(token),
                'is_healthy_after_repair': issue_count == 0,
                'issue_count': issue_count,
                'issues': issues,
            })

        warnings = list(plan['warnings'])
        if unhealthy_target_count:
            warnings.append(self._build_transition_warning(
                (
                    f'跨用户 repair 后仍有 {unhealthy_target_count} 个同用户目标子树存在残余问题，'
                    '请继续治理'
                ),
                reason_code='same_user_targets_still_dirty_after_repair',
                affected_subtree_size=unhealthy_target_count,
            ))
        return {
            'same_user_repair_target_health': health_items,
            'same_user_targets_with_issues_count': unhealthy_target_count,
            'residual_issue_count': total_issue_count,
            'warnings': warnings,
        }

    def _append_cross_user_repair_cycle_warning(self, health_summary, residual_root_issues):
        """仅在 repair 后仍残留 cycle 时追加 warning。"""
        has_cycle_issue = any(issue.get('reason_code') == 'descendant_tree_cycle' for issue in residual_root_issues)
        if not has_cycle_issue:
            return health_summary
        warnings = list(health_summary['warnings'])
        if not any(item.get('reason_code') == 'cycle_requires_detach_repair' for item in warnings):
            warnings.append(self._build_transition_warning(
                '当前父子图仍检测到循环链路；跨用户 repair 不会自动处理纯同用户 cycle，必要时仍需执行 detach 修复',
                reason_code='cycle_requires_detach_repair',
            ))
        return {
            **health_summary,
            'warnings': warnings,
        }

    def preview_cross_user_link_repair(self):
        """预览跨用户脏委托边修复，并评估修复后的同用户子树健康状况。"""
        plan = {
            'repair_target_tokens': [],
            'repair_target_count': 0,
            'same_user_repair_target_count': 0,
            'foreign_user_repair_target_count': 0,
            'warnings': [],
        }
        changed_count = 0
        health_summary = self.summarize_cross_user_link_repair_health(plan)
        target_transition = {
            'before_state': self._serialize_transition_state(self),
            'after_state': self._serialize_transition_state(self),
        }
        snapshots = []
        try:
            with transaction.atomic(using=TABDATA_DB_ALIAS):
                plan = self.stabilize_cross_user_link_repair_plan(
                    self.build_cross_user_link_repair_plan(),
                    lock_targets=True,
                )
                snapshots = [
                    (
                        token,
                        token.parent_token,
                        token.parent_token_id,
                        token.updated_at,
                    )
                    for token in plan['repair_target_tokens']
                ]
                current_target = next(
                    (token for token in plan['repair_target_tokens'] if str(token.pk) == str(self.pk)),
                    None,
                )
                current_root_after_repair = current_target if current_target is not None else self
                if current_target is not None:
                    target_transition['before_state'] = self._serialize_transition_state(current_target)
                target_ids = [token.pk for token in plan['repair_target_tokens'] if token.pk]
                now = timezone.now()
                if target_ids:
                    changed_count = self.__class__.objects.using(TABDATA_DB_ALIAS).filter(
                        pk__in=target_ids,
                    ).exclude(parent_token_id=None).update(
                        parent_token_id=None,
                        updated_at=now,
                    )
                    for token in plan['repair_target_tokens']:
                        token.parent_token = None
                        token.parent_token_id = None
                        token.updated_at = now
                if current_target is not None:
                    target_transition['after_state'] = self._serialize_transition_state(current_target)
                health_summary = self.summarize_cross_user_link_repair_health(plan)
                health_summary = self._append_cross_user_repair_cycle_warning(
                    health_summary,
                    current_root_after_repair.collect_root_subtree_health_issues(),
                )
                transaction.set_rollback(True, using=TABDATA_DB_ALIAS)
        finally:
            for token, old_parent_token, old_parent_token_id, old_updated_at in snapshots:
                token.parent_token = old_parent_token
                token.parent_token_id = old_parent_token_id
                token.updated_at = old_updated_at
        return plan, changed_count, health_summary, target_transition

    def validate_delete_constraints(self):
        """删除前校验直接子 Token 约束，区分正常子树与跨用户脏链路。"""
        summary = self.get_direct_child_linkage_summary()
        if summary['same_user_children'] and summary['foreign_user_children']:
            raise TokenTargetValidationError(
                (
                    '当前 Token 下既有可治理的派生 Token，也存在跨用户脏派生 Token，'
                    '请先处理子 Token 并修复委托链后再删除'
                ),
                error_code=ErrorCode.VALIDATION_ERROR,
                status_code=400,
            )
        if summary['same_user_children']:
            raise TokenTargetValidationError(
                '当前 Token 下仍有派生 Token，请先处理子 Token 后再删除父 Token',
                error_code=ErrorCode.VALIDATION_ERROR,
                status_code=400,
            )
        if summary['foreign_user_children']:
            raise TokenTargetValidationError(
                (
                    f'当前 Token 下存在 {len(summary["foreign_user_children"])} 个跨用户脏派生 Token，'
                    '无法删除，请先修复委托链后再重试'
                ),
                error_code=ErrorCode.VALIDATION_ERROR,
                status_code=400,
            )

    def get_tree_stats(self):
        """返回当前 Token 子树的基础统计。"""
        descendants = list(self.iter_descendant_tokens()) if self.pk else []
        direct_children = list(self.iter_child_tokens()) if self.pk else []
        return {
            'direct_child_count': len(direct_children),
            'descendant_count': len(descendants),
            'active_descendant_count': sum(1 for token in descendants if token.is_active),
        }

    def collect_descendant_delegation_issues(self):
        """收集当前 Token 作为祖先时，子树中的所有第一层冲突节点。"""
        if self.pk is None:
            return []

        issues = []
        pending = [self]
        while pending:
            parent = pending.pop(0)
            children = list(parent.iter_child_tokens())
            for child in children:
                try:
                    impacted_size = 1 + sum(1 for _ in child.iter_descendant_tokens())
                except TokenTargetValidationError as exc:
                    message = exc.messages[0] if getattr(exc, 'messages', None) else str(exc)
                    issues.append(self._build_transition_issue(
                        child,
                        message,
                        reason_code='descendant_tree_cycle',
                        error_code=getattr(exc, 'api_error_code', ErrorCode.VALIDATION_ERROR),
                        status_code=getattr(exc, 'status_code', 400),
                        affected_subtree_size=1,
                    ))
                    continue
                if not parent.is_active and child.is_active:
                    issues.append(self._build_transition_issue(
                        child,
                        f'当前 Token 下仍有激活中的派生 Token: {child.name}',
                        reason_code='active_child_under_inactive_parent',
                        error_code=ErrorCode.VALIDATION_ERROR,
                        status_code=400,
                        affected_subtree_size=impacted_size,
                    ))
                    continue
                try:
                    self.validate_within_parent_boundary(
                        parent,
                        scopes=child.scopes,
                        space_ids=child.space_ids,
                        table_ids=child.table_ids,
                        rate_limit=child.rate_limit,
                        expired_at=child.expired_at,
                        actor_label='父 Token',
                    )
                except TokenTargetValidationError as exc:
                    message = exc.messages[0] if getattr(exc, 'messages', None) else str(exc)
                    issues.append(self._build_transition_issue(
                        child,
                        f'派生 Token "{child.name}" 与父链不一致: {message}',
                        reason_code='descendant_boundary_violation',
                        error_code=getattr(exc, 'api_error_code', ErrorCode.VALIDATION_ERROR),
                        status_code=getattr(exc, 'status_code', 400),
                        affected_subtree_size=impacted_size,
                    ))
                    continue
                pending.append(child)
        return issues

    def validate_descendant_delegation(self):
        """校验当前 Token 作为祖先时，整棵子树仍保持一致。"""
        issues = self.collect_descendant_delegation_issues()
        if not issues:
            return
        first_issue = issues[0]
        raise TokenTargetValidationError(
            first_issue['message'],
            error_code=first_issue['error_code'],
            status_code=first_issue['status_code'],
        )

    def _sync_from_token(self, source):
        """把锁内最新状态回写到当前实例，避免 API 层继续使用过期对象。"""
        self.id = source.id
        self.user_id = source.user_id
        self.name = source.name
        self.description = source.description
        self.token_id = source.token_id
        self.sign_hash = source.sign_hash
        self.scopes = list(source.scopes) if source.scopes is not None else None
        self.space_ids = list(source.space_ids) if source.space_ids is not None else None
        self.table_ids = list(source.table_ids) if source.table_ids is not None else None
        self.rate_limit = source.rate_limit
        self.expired_at = source.expired_at
        self.is_active = source.is_active
        self.last_used_at = source.last_used_at
        self.use_count = source.use_count
        self.created_at = source.created_at
        self.updated_at = source.updated_at
        self.parent_token_id = source.parent_token_id
        self._state.db = source._state.db
        self._state.adding = source._state.adding
        self._state.fields_cache.pop('parent_token', None)
        self._state.fields_cache.pop('user', None)
        if 'parent_token' in source._state.fields_cache:
            self.parent_token = source.parent_token
        if 'user' in source._state.fields_cache:
            self.user = source.user

    @classmethod
    def _lock_token_for_governance(
        cls,
        token_id,
        *,
        missing_message: str,
        error_code: str = ErrorCode.VALIDATION_ERROR,
        status_code: int = 400,
        lock_row: bool = True,
    ):
        try:
            queryset = cls.objects.using(TABDATA_DB_ALIAS)
            if lock_row:
                queryset = queryset.select_for_update()
            return queryset.get(pk=token_id)
        except cls.DoesNotExist as exc:
            raise TokenTargetValidationError(
                missing_message,
                error_code=error_code,
                status_code=status_code,
            ) from exc

    def _collect_ancestor_tokens(self, *, lock_rows: bool):
        """收集当前节点向上的整条父链；遇到 cycle 时只去重不挂死。"""
        next_parent_id = self.parent_token_id
        visited = {str(self.pk)} if self.pk else set()
        ancestors = []

        while next_parent_id:
            parent_token = self.__class__._lock_token_for_governance(
                next_parent_id,
                missing_message='Token 父链路已损坏，无法继续委托校验',
                lock_row=lock_rows,
            )
            parent_id = str(parent_token.pk)
            if parent_id in visited:
                break
            visited.add(parent_id)
            ancestors.append(parent_token)
            next_parent_id = parent_token.parent_token_id
        return ancestors

    def _lock_ancestor_chain(self):
        """锁住当前节点向上的整条父链；遇到 cycle 时只去重不挂死。"""
        return self._collect_ancestor_tokens(lock_rows=True)

    def _collect_same_user_subtree_tokens(self, *, lock_rows: bool):
        """收集当前用户可治理的整棵子树；遇到 cycle 时只保留首次出现的节点。"""
        if self.pk is None:
            return []

        descendants = []
        pending = [self]
        visited = {str(self.pk)}
        while pending:
            parent = pending.pop(0)
            children_queryset = self.__class__.objects.using(TABDATA_DB_ALIAS).filter(
                parent_token_id=parent.pk,
                user_id=self.user_id,
            ).order_by('created_at', 'id')
            if lock_rows:
                children_queryset = children_queryset.select_for_update()
            children = list(children_queryset)
            for child in children:
                child_id = str(child.pk)
                if child_id in visited:
                    continue
                visited.add(child_id)
                descendants.append(child)
                pending.append(child)
        return descendants

    def _lock_same_user_subtree(self):
        """锁住当前用户可治理的整棵子树；遇到 cycle 时只保留首次出现的节点。"""
        return self._collect_same_user_subtree_tokens(lock_rows=True)

    def _lock_governance_context(
        self,
        *,
        candidate_parent_token=ANALYZE_UNSET,
        actor_token=None,
        target_missing_message: str,
        target_missing_error_code: str = ErrorCode.VALIDATION_ERROR,
        target_missing_status_code: int = 400,
        candidate_parent_missing_message: str = '目标父 Token 不存在，无法继续治理',
        candidate_parent_missing_error_code: str = ErrorCode.VALIDATION_ERROR,
        candidate_parent_missing_status_code: int = 400,
        include_target_subtree: bool = True,
    ):
        """统一锁住治理路径会读取到的关键节点，避免基于旧图做写入判断。"""
        if self.pk is None:
            raise TokenTargetValidationError(
                '未持久化的 Token 无法执行治理操作',
                error_code=ErrorCode.VALIDATION_ERROR,
                status_code=400,
            )
        _ensure_governance_atomic_block()

        seed_specs = {
            str(self.pk): {
                'missing_message': target_missing_message,
                'error_code': target_missing_error_code,
                'status_code': target_missing_status_code,
            },
        }

        if candidate_parent_token is not ANALYZE_UNSET and candidate_parent_token is not None:
            if getattr(candidate_parent_token, 'pk', None) is None:
                raise TokenTargetValidationError(
                    '目标父 Token 尚未持久化，无法执行父链治理',
                    error_code=ErrorCode.VALIDATION_ERROR,
                    status_code=400,
                )
            seed_specs.setdefault(str(candidate_parent_token.pk), {
                'missing_message': candidate_parent_missing_message,
                'error_code': candidate_parent_missing_error_code,
                'status_code': candidate_parent_missing_status_code,
            })

        if actor_token is not None:
            if getattr(actor_token, 'pk', None) is None:
                raise TokenTargetValidationError(
                    '当前调用 Token 缺少持久化身份，无法校验父子委托关系',
                    error_code=ErrorCode.PERMISSION_DENIED,
                    status_code=403,
                )
            seed_specs.setdefault(str(actor_token.pk), {
                'missing_message': '当前调用 Token 不存在或已失效，无法继续治理',
                'error_code': ErrorCode.PERMISSION_DENIED,
                'status_code': 403,
            })

        def _remember_token(token, *, missing_message: str, error_code: str = ErrorCode.VALIDATION_ERROR, status_code: int = 400):
            token_id = str(token.pk)
            if token_id in seed_specs:
                return False
            seed_specs[token_id] = {
                'missing_message': missing_message,
                'error_code': error_code,
                'status_code': status_code,
            }
            return True

        target_probe = self.__class__._lock_token_for_governance(
            self.pk,
            missing_message=target_missing_message,
            error_code=target_missing_error_code,
            status_code=target_missing_status_code,
            lock_row=False,
        )
        for ancestor in target_probe._collect_ancestor_tokens(lock_rows=False):
            _remember_token(ancestor, missing_message='Token 父链路已损坏，无法继续委托校验')
        if include_target_subtree:
            for descendant in target_probe._collect_same_user_subtree_tokens(lock_rows=False):
                _remember_token(descendant, missing_message='治理图中的 Token 已不存在，无法继续治理')

        if candidate_parent_token is not ANALYZE_UNSET and candidate_parent_token is not None:
            candidate_parent_probe = self.__class__._lock_token_for_governance(
                candidate_parent_token.pk,
                missing_message=candidate_parent_missing_message,
                error_code=candidate_parent_missing_error_code,
                status_code=candidate_parent_missing_status_code,
                lock_row=False,
            )
            for ancestor in candidate_parent_probe._collect_ancestor_tokens(lock_rows=False):
                _remember_token(ancestor, missing_message='Token 父链路已损坏，无法继续委托校验')

        if actor_token is not None:
            actor_probe = self.__class__._lock_token_for_governance(
                actor_token.pk,
                missing_message='当前调用 Token 不存在或已失效，无法继续治理',
                error_code=ErrorCode.PERMISSION_DENIED,
                status_code=403,
                lock_row=False,
            )
            for ancestor in actor_probe._collect_ancestor_tokens(lock_rows=False):
                _remember_token(
                    ancestor,
                    missing_message='当前调用 Token 的父链路已损坏，无法继续治理',
                    error_code=ErrorCode.PERMISSION_DENIED,
                    status_code=403,
                )

        for attempt in range(MAX_GOVERNANCE_GRAPH_LOCK_ATTEMPTS):
            try:
                with transaction.atomic(using=TABDATA_DB_ALIAS):
                    locked_seeds = {}
                    pending_ids = sorted(seed_specs.keys())
                    for token_id in pending_ids:
                        spec = seed_specs[token_id]
                        locked_seeds[token_id] = self.__class__._lock_token_for_governance(
                            token_id,
                            missing_message=spec['missing_message'],
                            error_code=spec['error_code'],
                            status_code=spec['status_code'],
                            lock_row=True,
                        )

                    locked_target = locked_seeds[str(self.pk)]
                    locked_actor = locked_seeds.get(str(actor_token.pk)) if actor_token is not None else None
                    locked_candidate_parent = (
                        locked_seeds.get(str(candidate_parent_token.pk))
                        if candidate_parent_token is not ANALYZE_UNSET and candidate_parent_token is not None
                        else None
                    )

                    ancestor_probe = locked_target._collect_ancestor_tokens(lock_rows=False)
                    descendant_probe = (
                        locked_target._collect_same_user_subtree_tokens(lock_rows=False)
                        if include_target_subtree
                        else []
                    )
                    graph_changed = False
                    for ancestor in ancestor_probe:
                        graph_changed = _remember_token(
                            ancestor,
                            missing_message='Token 父链路已损坏，无法继续委托校验',
                        ) or graph_changed
                    if include_target_subtree:
                        for descendant in descendant_probe:
                            graph_changed = _remember_token(
                                descendant,
                                missing_message='治理图中的 Token 已不存在，无法继续治理',
                            ) or graph_changed
                    if locked_candidate_parent is not None and str(locked_candidate_parent.pk) != str(locked_target.pk):
                        for ancestor in locked_candidate_parent._collect_ancestor_tokens(lock_rows=False):
                            graph_changed = _remember_token(
                                ancestor,
                                missing_message='Token 父链路已损坏，无法继续委托校验',
                            ) or graph_changed
                    if locked_actor is not None and str(locked_actor.pk) != str(locked_target.pk):
                        for ancestor in locked_actor._collect_ancestor_tokens(lock_rows=False):
                            graph_changed = _remember_token(
                                ancestor,
                                missing_message='当前调用 Token 的父链路已损坏，无法继续治理',
                                error_code=ErrorCode.PERMISSION_DENIED,
                                status_code=403,
                            ) or graph_changed

                    if graph_changed:
                        if attempt >= MAX_GOVERNANCE_GRAPH_LOCK_ATTEMPTS - 1:
                            raise TokenTargetValidationError(
                                '治理图在并发修改中持续变化，请稍后重试',
                                error_code=ErrorCode.VALIDATION_ERROR,
                                status_code=400,
                            )
                        raise _GovernanceGraphRetryRequired()

                    ancestor_tokens = [locked_seeds[str(token.pk)] for token in ancestor_probe]
                    locked_descendants = [locked_seeds[str(token.pk)] for token in descendant_probe]
                    self._sync_from_token(locked_target)
                    if actor_token is not None and actor_token is not self and locked_actor is not None:
                        actor_token._sync_from_token(locked_actor)
                    if (
                        candidate_parent_token is not ANALYZE_UNSET
                        and candidate_parent_token is not None
                        and candidate_parent_token is not self
                        and locked_candidate_parent is not None
                    ):
                        candidate_parent_token._sync_from_token(locked_candidate_parent)

                    return {
                        'token': locked_target,
                        'actor_token': locked_actor,
                        'candidate_parent_token': locked_candidate_parent,
                        'ancestor_tokens': ancestor_tokens,
                        'subtree_tokens': [locked_target, *locked_descendants],
                    }
            except _GovernanceGraphRetryRequired:
                continue

        raise TokenTargetValidationError(
            '治理图在并发修改中持续变化，请稍后重试',
            error_code=ErrorCode.VALIDATION_ERROR,
            status_code=400,
        )

    def _apply_governance_probe(self, probe):
        """把 probe 中的治理字段写回到已加锁实例。"""
        self.parent_token = probe.parent_token
        self.parent_token_id = probe.parent_token_id
        self.name = probe.name
        self.description = probe.description
        self.scopes = list(probe.scopes) if probe.scopes is not None else None
        self.space_ids = list(probe.space_ids) if probe.space_ids is not None else None
        self.table_ids = list(probe.table_ids) if probe.table_ids is not None else None
        self.rate_limit = probe.rate_limit
        self.expired_at = probe.expired_at
        self.is_active = probe.is_active

    def _validate_live_actor_token(self, actor_token):
        """锁内重新确认当前调用 Token 仍然可用，避免请求快照与提交状态脱钩。"""
        if actor_token is None:
            return

        if str(actor_token.user_id) != str(self.user_id):
            raise TokenTargetValidationError(
                '当前调用 Token 只能管理同一用户下的 Token',
                error_code=ErrorCode.PERMISSION_DENIED,
                status_code=403,
            )

        now = timezone.now()
        if not actor_token.is_active:
            raise TokenTargetValidationError(
                '当前调用 Token 已停用，无法继续治理',
                error_code=ErrorCode.PERMISSION_DENIED,
                status_code=403,
            )
        if 'token:manage' not in (actor_token.scopes or []):
            raise TokenTargetValidationError(
                '当前调用 Token 已失去 token:manage 权限，无法继续治理',
                error_code=ErrorCode.PERMISSION_DENIED,
                status_code=403,
            )
        if actor_token.expired_at and actor_token.expired_at < now:
            raise TokenTargetValidationError(
                '当前调用 Token 已过期，无法继续治理',
                error_code=ErrorCode.PERMISSION_DENIED,
                status_code=403,
            )
        if not actor_token.has_valid_delegation_chain(now=now):
            raise TokenTargetValidationError(
                '当前调用 Token 的委托链已失效，无法继续治理',
                error_code=ErrorCode.PERMISSION_DENIED,
                status_code=403,
            )

    def _validate_manageable_by_actor_token(self, actor_token, *, probe):
        """在锁内按当前图校验 API Token 调用者是否仍有治理权限。"""
        if actor_token is None:
            return
        self._validate_live_actor_token(actor_token)
        if not self.is_self_or_descendant_of(actor_token):
            raise TokenTargetValidationError(
                '当前调用 Token 只能管理自身或其派生的 Token',
                error_code=ErrorCode.PERMISSION_DENIED,
                status_code=403,
            )
        self.validate_within_parent_boundary(
            actor_token,
            scopes=probe.scopes,
            space_ids=probe.space_ids,
            table_ids=probe.table_ids,
            rate_limit=probe.rate_limit,
            expired_at=probe.expired_at,
            actor_label='当前调用 Token',
        )

    def _build_locked_current_parent_ref(self, ancestor_tokens):
        """从锁内祖先链生成可安全返回给前端的当前父节点快照。"""
        if not self.parent_token_id:
            return None
        current_parent = next(
            (token for token in ancestor_tokens if str(token.pk) == str(self.parent_token_id)),
            None,
        )
        if current_parent is None or str(current_parent.user_id) != str(self.user_id):
            return None
        return {
            'id': str(current_parent.pk),
            **self._serialize_transition_state(current_parent),
        }

    def _build_preview_probe(
        self,
        *,
        name=ANALYZE_UNSET,
        description=ANALYZE_UNSET,
        parent_token=ANALYZE_UNSET,
        scopes=ANALYZE_UNSET,
        space_ids=ANALYZE_UNSET,
        table_ids=ANALYZE_UNSET,
        rate_limit=ANALYZE_UNSET,
        expired_at=ANALYZE_UNSET,
        is_active=ANALYZE_UNSET,
    ):
        """构造一个仅用于 preview 的临时 Token 视图，不落库。"""
        next_parent = self.parent_token if parent_token is ANALYZE_UNSET else parent_token
        probe = self.__class__(
            id=self.pk,
            user_id=self.user_id,
            parent_token=next_parent,
            name=self.name if name is ANALYZE_UNSET else name,
            description=self.description if description is ANALYZE_UNSET else description,
            token_id=self.token_id,
            sign_hash=self.sign_hash,
            scopes=self.scopes if scopes is ANALYZE_UNSET else scopes,
            space_ids=self.space_ids if space_ids is ANALYZE_UNSET else space_ids,
            table_ids=self.table_ids if table_ids is ANALYZE_UNSET else table_ids,
            rate_limit=self.rate_limit if rate_limit is ANALYZE_UNSET else rate_limit,
            expired_at=self.expired_at if expired_at is ANALYZE_UNSET else expired_at,
            is_active=self.is_active if is_active is ANALYZE_UNSET else is_active,
        )
        return probe

    def build_transition_preview(
        self,
        *,
        action: str,
        name=ANALYZE_UNSET,
        description=ANALYZE_UNSET,
        parent_token=ANALYZE_UNSET,
        scopes=ANALYZE_UNSET,
        space_ids=ANALYZE_UNSET,
        table_ids=ANALYZE_UNSET,
        rate_limit=ANALYZE_UNSET,
        expired_at=ANALYZE_UNSET,
        is_active=ANALYZE_UNSET,
    ):
        """分析某次树治理/祖先更新对当前节点与子树的影响。"""
        if self.pk is None:
            return self._build_transition_preview_locked(
                action=action,
                name=name,
                description=description,
                parent_token=parent_token,
                scopes=scopes,
                space_ids=space_ids,
                table_ids=table_ids,
                rate_limit=rate_limit,
                expired_at=expired_at,
                is_active=is_active,
            )

        with transaction.atomic(using=TABDATA_DB_ALIAS):
            context = self._lock_governance_context(
                target_missing_message='目标 Token 不存在，无法预览治理影响',
                target_missing_error_code=ErrorCode.NOT_FOUND,
                target_missing_status_code=404,
            )
            preview = context['token']._build_transition_preview_locked(
                action=action,
                name=name,
                description=description,
                parent_token=parent_token,
                scopes=scopes,
                space_ids=space_ids,
                table_ids=table_ids,
                rate_limit=rate_limit,
                expired_at=expired_at,
                is_active=is_active,
            )
            preview['current_parent_token'] = context['token']._build_locked_current_parent_ref(
                context['ancestor_tokens'],
            )
            self._sync_from_token(context['token'])
            return preview

    def _build_transition_preview_locked(
        self,
        *,
        action: str,
        name=ANALYZE_UNSET,
        description=ANALYZE_UNSET,
        parent_token=ANALYZE_UNSET,
        scopes=ANALYZE_UNSET,
        space_ids=ANALYZE_UNSET,
        table_ids=ANALYZE_UNSET,
        rate_limit=ANALYZE_UNSET,
        expired_at=ANALYZE_UNSET,
        is_active=ANALYZE_UNSET,
    ):
        """分析某次树治理/祖先更新对当前节点与子树的影响。"""
        probe = self._build_preview_probe(
            name=name,
            description=description,
            parent_token=parent_token,
            scopes=scopes,
            space_ids=space_ids,
            table_ids=table_ids,
            rate_limit=rate_limit,
            expired_at=expired_at,
            is_active=is_active,
        )
        visibility_summary = self.get_graph_visibility_summary()
        warnings = []
        if visibility_summary['foreign_descendant_count']:
            warnings.append(self._build_transition_warning(
                (
                    f'当前父子图中还有 {visibility_summary["foreign_descendant_count"]} 个跨用户脏派生 Token '
                    '未纳入本次治理范围'
                ),
                reason_code='foreign_descendants_excluded',
                affected_subtree_size=visibility_summary['foreign_descendant_count'],
            ))
        try:
            stats = self.get_tree_stats()
        except TokenTargetValidationError as exc:
            message = exc.messages[0] if getattr(exc, 'messages', None) else str(exc)
            stats = {
                'direct_child_count': len(list(self.iter_child_tokens())) if self.pk else 0,
                'descendant_count': 0,
                'active_descendant_count': 0,
            }
            return {
                'action': action,
                'can_apply': False,
                'target_token_id': str(self.pk) if self.pk else '',
                'target_token_name': self.name,
                'current_parent_token_id': str(self.parent_token_id) if self.parent_token_id else None,
                'next_parent_token_id': str(probe.parent_token_id) if probe.parent_token_id else None,
                'current_state': self._serialize_transition_state(self),
                'candidate_state': self._serialize_transition_state(probe),
                'ignored_foreign_descendant_count': visibility_summary['foreign_descendant_count'],
                'warnings': warnings,
                **stats,
                'violations': [self._build_transition_issue(
                    probe,
                    message,
                    reason_code='target_tree_invalid',
                    error_code=getattr(exc, 'api_error_code', ErrorCode.VALIDATION_ERROR),
                    status_code=getattr(exc, 'status_code', 400),
                    affected_subtree_size=1,
                )],
            }
        violations = []

        try:
            probe.validate_scopes()
            probe.validate_scope_targets()
            probe.validate_parent_delegation()
        except TokenTargetValidationError as exc:
            message = exc.messages[0] if getattr(exc, 'messages', None) else str(exc)
            violations.append(self._build_transition_issue(
                probe,
                message,
                reason_code='target_transition_invalid',
                error_code=getattr(exc, 'api_error_code', ErrorCode.VALIDATION_ERROR),
                status_code=getattr(exc, 'status_code', 400),
                affected_subtree_size=1 + stats['descendant_count'],
            ))
        else:
            violations.extend(probe.collect_descendant_delegation_issues())

        return {
            'action': action,
            'can_apply': not violations,
            'target_token_id': str(self.pk) if self.pk else '',
            'target_token_name': self.name,
            'current_parent_token_id': str(self.parent_token_id) if self.parent_token_id else None,
            'next_parent_token_id': str(probe.parent_token_id) if probe.parent_token_id else None,
            'current_state': self._serialize_transition_state(self),
            'candidate_state': self._serialize_transition_state(probe),
            'ignored_foreign_descendant_count': visibility_summary['foreign_descendant_count'],
            'warnings': warnings,
            **stats,
            'violations': violations,
        }

    def build_parent_transition_preview(self, *, action: str, parent_token):
        """预览父链切换后的结果树，用于 detach/reparent 等修复式治理。"""
        if self.pk is None:
            return {
                'action': action,
                'can_apply': False,
                'target_token_id': '',
                'target_token_name': self.name,
                'current_parent_token_id': str(self.parent_token_id) if self.parent_token_id else None,
                'next_parent_token_id': str(parent_token.pk) if getattr(parent_token, 'pk', None) else None,
                'current_state': self._serialize_transition_state(self),
                'candidate_state': self._serialize_transition_state(self),
                'ignored_foreign_descendant_count': 0,
                'warnings': [],
                'direct_child_count': 0,
                'descendant_count': 0,
                'active_descendant_count': 0,
                'violations': [self._build_transition_issue(
                    self,
                    '未持久化的 Token 无法预览父链修复',
                    reason_code='target_transition_invalid',
                    error_code=ErrorCode.VALIDATION_ERROR,
                    status_code=400,
                    affected_subtree_size=1,
                )],
            }

        with transaction.atomic(using=TABDATA_DB_ALIAS):
            context = self._lock_governance_context(
                candidate_parent_token=parent_token,
                target_missing_message='目标 Token 不存在，无法预览父链修复',
                candidate_parent_missing_message='目标父 Token 不存在，无法预览父链修复',
                target_missing_error_code=ErrorCode.NOT_FOUND,
                target_missing_status_code=404,
                candidate_parent_missing_error_code=ErrorCode.NOT_FOUND,
                candidate_parent_missing_status_code=404,
            )
            preview = context['token']._build_parent_transition_preview_locked(
                action=action,
                parent_token=context['candidate_parent_token'],
            )
            preview['current_parent_token'] = context['token']._build_locked_current_parent_ref(
                context['ancestor_tokens'],
            )
            self._sync_from_token(context['token'])
            if (
                parent_token is not None
                and parent_token is not self
                and context['candidate_parent_token'] is not None
            ):
                parent_token._sync_from_token(context['candidate_parent_token'])
            transaction.set_rollback(True, using=TABDATA_DB_ALIAS)
        return preview

    def _build_parent_transition_preview_locked(self, *, action: str, parent_token):
        """在锁内预览父链切换后的结果树，用于 detach/reparent 等修复式治理。"""
        visibility_summary = self.get_graph_visibility_summary()
        warnings = []
        if visibility_summary['foreign_descendant_count']:
            warnings.append(self._build_transition_warning(
                (
                    f'当前父子图中还有 {visibility_summary["foreign_descendant_count"]} 个跨用户脏派生 Token '
                    '未纳入本次治理范围'
                ),
                reason_code='foreign_descendants_excluded',
                affected_subtree_size=visibility_summary['foreign_descendant_count'],
            ))

        old_parent_token = self.parent_token
        old_parent_token_id = self.parent_token_id
        old_updated_at = self.updated_at
        old_scopes = list(self.scopes) if self.scopes is not None else None
        old_space_ids = list(self.space_ids) if self.space_ids is not None else None
        old_table_ids = list(self.table_ids) if self.table_ids is not None else None
        current_state = self._serialize_transition_state(self)
        new_parent_id = parent_token.pk if parent_token is not None else None
        now = timezone.now()
        stats = {
            'direct_child_count': 0,
            'descendant_count': 0,
            'active_descendant_count': 0,
        }
        candidate_state = current_state
        violations = []

        try:
            updated = self.__class__.objects.using(TABDATA_DB_ALIAS).filter(pk=self.pk).update(
                parent_token_id=new_parent_id,
                updated_at=now,
            )
            if updated != 1:
                raise TokenTargetValidationError(
                    '目标 Token 不存在，无法预览父链修复',
                    error_code=ErrorCode.VALIDATION_ERROR,
                    status_code=400,
                )

            self.parent_token = parent_token
            self.parent_token_id = new_parent_id
            self.updated_at = now
            candidate_state = self._serialize_transition_state(self)
            try:
                self.validate_scopes()
                self.validate_scope_targets()
                self.validate_parent_delegation()
                self.validate_descendant_delegation()
                stats = self.get_tree_stats()
            except TokenTargetValidationError as exc:
                message = exc.messages[0] if getattr(exc, 'messages', None) else str(exc)
                try:
                    stats = self.get_tree_stats()
                except TokenTargetValidationError:
                    stats = {
                        'direct_child_count': len(list(self.iter_child_tokens())) if self.pk else 0,
                        'descendant_count': 0,
                        'active_descendant_count': 0,
                    }
                violations = [self._build_transition_issue(
                    self,
                    message,
                    reason_code='target_transition_invalid',
                    error_code=getattr(exc, 'api_error_code', ErrorCode.VALIDATION_ERROR),
                    status_code=getattr(exc, 'status_code', 400),
                    affected_subtree_size=1 + stats['descendant_count'],
                )]
        finally:
            self.parent_token = old_parent_token
            self.parent_token_id = old_parent_token_id
            self.updated_at = old_updated_at
            self.scopes = old_scopes
            self.space_ids = old_space_ids
            self.table_ids = old_table_ids

        return {
            'action': action,
            'can_apply': not violations,
            'target_token_id': str(self.pk) if self.pk else '',
            'target_token_name': self.name,
            'current_parent_token_id': str(old_parent_token_id) if old_parent_token_id else None,
            'next_parent_token_id': str(new_parent_id) if new_parent_id else None,
            'current_state': current_state,
            'candidate_state': candidate_state,
            'ignored_foreign_descendant_count': visibility_summary['foreign_descendant_count'],
            'warnings': warnings,
            **stats,
            'violations': violations,
        }

    def is_self_or_descendant_of(self, ancestor_token, *, lock_chain: bool = False) -> bool:
        """判断当前 Token 是否是某个祖先 Token 的自身或后代。"""
        if ancestor_token is None or getattr(ancestor_token, 'pk', None) is None or self.pk is None:
            return False
        if str(self.pk) == str(ancestor_token.pk):
            return True

        try:
            return any(
                str(parent.pk) == str(ancestor_token.pk)
                for parent in self.iter_ancestor_tokens(lock_chain=lock_chain)
            )
        except TokenTargetValidationError:
            return False

    def has_valid_delegation_chain(self, now=None) -> bool:
        """运行时校验整条祖先链的有效性与 boundary。"""
        now = now or timezone.now()
        try:
            current = self
            for ancestor in self.iter_ancestor_tokens():
                if str(ancestor.user_id) != str(self.user_id):
                    return False
                if not ancestor.is_active:
                    return False
                if ancestor.expired_at and ancestor.expired_at < now:
                    return False
                self.validate_within_parent_boundary(
                    ancestor,
                    scopes=current.scopes,
                    space_ids=current.space_ids,
                    table_ids=current.table_ids,
                    rate_limit=current.rate_limit,
                    expired_at=current.expired_at,
                    actor_label='祖先 Token',
                )
                current = ancestor
        except TokenTargetValidationError:
            return False
        return True

    def save(self, *args, **kwargs):
        validate_scopes = kwargs.pop('validate_scopes', True)
        validate_scope_targets = kwargs.pop('validate_scope_targets', True)
        validate_delegation = kwargs.pop('validate_delegation', True)
        if validate_scopes:
            self.validate_scopes()
        if validate_scope_targets:
            self.validate_scope_targets()
        if validate_delegation:
            in_atomic = connections[TABDATA_DB_ALIAS].in_atomic_block
            self.validate_parent_delegation(lock_ancestors=in_atomic)
            self.validate_descendant_delegation()
        return super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        protect_children = kwargs.pop('protect_children', True)
        if protect_children:
            self.validate_delete_constraints()
        return super().delete(*args, **kwargs)

    def delete_with_governance(self, *, actor_token=None):
        """在锁内校验治理权限后删除当前 Token。"""
        if self.pk is None:
            raise TokenTargetValidationError(
                '未持久化的 Token 无法删除',
                error_code=ErrorCode.VALIDATION_ERROR,
                status_code=400,
            )

        context = None
        try:
            with transaction.atomic(using=TABDATA_DB_ALIAS):
                context = self._lock_governance_context(
                    actor_token=actor_token,
                    target_missing_message='目标 Token 不存在，无法删除',
                    target_missing_error_code=ErrorCode.NOT_FOUND,
                    target_missing_status_code=404,
                )
                locked_token = context['token']
                locked_token._validate_manageable_by_actor_token(
                    context['actor_token'],
                    probe=locked_token,
                )
                locked_token.validate_delete_constraints()
                locked_token.delete(protect_children=False)
        except Exception:
            if context is not None:
                self._sync_from_token(context['token'])
                if actor_token is not None and actor_token is not self and context['actor_token'] is not None:
                    actor_token._sync_from_token(context['actor_token'])
            raise

        if actor_token is not None and actor_token is not self and context is not None and context['actor_token'] is not None:
            actor_token._sync_from_token(context['actor_token'])
        return None

    # ── 类方法 ──

    @classmethod
    def create_token(cls, user, name: str, scopes: list,
                     description: str = '',
                     space_ids: list = None,
                     table_ids: list = None,
                     rate_limit: int = 60,
                     parent_token=None,
                     expired_at=None,
                     actor_token=None) -> tuple:
        """
        创建新 Token。

        Returns:
            (token_instance, plain_token) — plain_token 仅此时返回
        """
        token_id = _generate_token_id()
        sign = _generate_token_sign()
        plain_token = f"{TOKEN_PREFIX}{token_id}_{sign}"
        context = None
        instance = None
        try:
            with transaction.atomic(using=TABDATA_DB_ALIAS):
                locked_parent = parent_token
                locked_actor = actor_token
                if parent_token is not None:
                    if getattr(parent_token, 'pk', None) is None:
                        raise TokenTargetValidationError(
                            '父 Token 尚未持久化，无法创建派生 Token',
                            error_code=ErrorCode.VALIDATION_ERROR,
                            status_code=400,
                        )
                    context = parent_token._lock_governance_context(
                        actor_token=actor_token,
                        target_missing_message='父 Token 不存在，无法创建派生 Token',
                        target_missing_error_code=ErrorCode.NOT_FOUND,
                        target_missing_status_code=404,
                        include_target_subtree=False,
                    )
                    locked_parent = context['token']
                    locked_actor = context['actor_token']

                instance = cls(
                    user=user,
                    parent_token=locked_parent,
                    name=name,
                    description=description,
                    token_id=token_id,
                    sign_hash=_hash_token(sign),
                    scopes=scopes,
                    space_ids=space_ids,
                    table_ids=table_ids,
                    rate_limit=rate_limit,
                    expired_at=expired_at,
                )
                if locked_parent is not None and locked_actor is not None:
                    locked_parent._validate_manageable_by_actor_token(
                        locked_actor,
                        probe=instance,
                    )
                instance.save()
        except Exception:
            if context is not None:
                if parent_token is not None and parent_token is not instance:
                    parent_token._sync_from_token(context['token'])
                if (
                    actor_token is not None
                    and actor_token is not parent_token
                    and actor_token is not instance
                    and context['actor_token'] is not None
                ):
                    actor_token._sync_from_token(context['actor_token'])
            raise
        if context is not None:
            if parent_token is not None and parent_token is not instance:
                parent_token._sync_from_token(context['token'])
            if (
                actor_token is not None
                and actor_token is not parent_token
                and actor_token is not instance
                and context['actor_token'] is not None
            ):
                actor_token._sync_from_token(context['actor_token'])
        return instance, plain_token

    @classmethod
    def verify_token(cls, raw_token: str):
        """
        验证 Token。

        Args:
            raw_token: 完整 token 字符串 (ttn_{token_id}_{sign})

        Returns:
            (token_instance, user) 或 None
        """
        if not raw_token or not raw_token.startswith(TOKEN_PREFIX):
            return None

        # 解析 token_id 和 sign
        body = raw_token[len(TOKEN_PREFIX):]
        parts = body.split('_', 1)
        if len(parts) != 2:
            return None

        token_id, sign = parts

        # 查库验证（不用 select_related，因为 Token 在 PostgreSQL、User 在 MySQL）
        try:
            token = cls.objects.using(TABDATA_DB_ALIAS).get(
                token_id=token_id,
                is_active=True,
            )
        except cls.DoesNotExist:
            return None

        # 验证签名（常量时间比较，防止时序侧信道攻击）
        if not hmac.compare_digest(token.sign_hash, _hash_token(sign)):
            return None

        # 检查过期
        if token.expired_at and token.expired_at < timezone.now():
            return None
        if not token.has_valid_delegation_chain():
            return None

        # 跨库查询 User（User 在 default/MySQL 数据库）
        try:
            user = User.objects.using('default').get(id=token.user_id, is_active=True)
        except User.DoesNotExist:
            return None

        # 更新使用记录
        cls.objects.using(TABDATA_DB_ALIAS).filter(pk=token.pk).update(
            last_used_at=timezone.now(),
            use_count=models.F('use_count') + 1,
        )

        return token, user

    @classmethod
    def regenerate_sign(cls, token_id_pk: uuid.UUID) -> str:
        """
        重新生成签名。

        Returns:
            新的完整 plain_token
        """
        token = cls.objects.using(TABDATA_DB_ALIAS).get(pk=token_id_pk)
        return token.regenerate_sign_with_governance()

    def regenerate_sign_with_governance(self, *, actor_token=None) -> str:
        """在锁内校验治理权限后重新生成当前 Token 的签名。"""
        if self.pk is None:
            raise TokenTargetValidationError(
                '未持久化的 Token 无法重新生成签名',
                error_code=ErrorCode.VALIDATION_ERROR,
                status_code=400,
            )

        context = None
        try:
            with transaction.atomic(using=TABDATA_DB_ALIAS):
                context = self._lock_governance_context(
                    actor_token=actor_token,
                    target_missing_message='目标 Token 不存在，无法重新生成签名',
                    target_missing_error_code=ErrorCode.NOT_FOUND,
                    target_missing_status_code=404,
                    include_target_subtree=False,
                )
                locked_token = context['token']
                locked_token._validate_manageable_by_actor_token(
                    context['actor_token'],
                    probe=locked_token,
                )
                new_sign = _generate_token_sign()
                locked_token.sign_hash = _hash_token(new_sign)
                locked_token.save(
                    update_fields=['sign_hash', 'updated_at'],
                    validate_scope_targets=False,
                    validate_delegation=False,
                )
                self._sync_from_token(locked_token)
                if actor_token is not None and actor_token is not self and context['actor_token'] is not None:
                    actor_token._sync_from_token(context['actor_token'])
                return f"{TOKEN_PREFIX}{locked_token.token_id}_{new_sign}"
        except Exception:
            if context is not None:
                self._sync_from_token(context['token'])
                if actor_token is not None and actor_token is not self and context['actor_token'] is not None:
                    actor_token._sync_from_token(context['actor_token'])
            raise

    def apply_update(
        self,
        *,
        actor_token=None,
        name=ANALYZE_UNSET,
        description=ANALYZE_UNSET,
        scopes=ANALYZE_UNSET,
        space_ids=ANALYZE_UNSET,
        table_ids=ANALYZE_UNSET,
        rate_limit=ANALYZE_UNSET,
        expired_at=ANALYZE_UNSET,
        is_active=ANALYZE_UNSET,
    ):
        """在锁内按当前图合并局部更新，避免旧对象把并发新状态写回去。"""
        if self.pk is None:
            raise TokenTargetValidationError(
                '未持久化的 Token 无法执行更新',
                error_code=ErrorCode.VALIDATION_ERROR,
                status_code=400,
            )

        context = None
        try:
            with transaction.atomic(using=TABDATA_DB_ALIAS):
                context = self._lock_governance_context(
                    actor_token=actor_token,
                    target_missing_message='目标 Token 不存在，无法执行更新',
                    target_missing_error_code=ErrorCode.NOT_FOUND,
                    target_missing_status_code=404,
                )
                locked_token = context['token']
                probe = locked_token._build_preview_probe(
                    name=name,
                    description=description,
                    scopes=scopes,
                    space_ids=space_ids,
                    table_ids=table_ids,
                    rate_limit=rate_limit,
                    expired_at=expired_at,
                    is_active=is_active,
                )
                locked_token._validate_manageable_by_actor_token(
                    context['actor_token'],
                    probe=probe,
                )
                probe.validate_scopes()
                probe.validate_scope_targets()
                probe.validate_parent_delegation()
                probe.validate_descendant_delegation()
                locked_token._apply_governance_probe(probe)
                locked_token.save(
                    validate_scopes=False,
                    validate_scope_targets=False,
                    validate_delegation=False,
                )
                self._sync_from_token(locked_token)
                if actor_token is not None and actor_token is not self and context['actor_token'] is not None:
                    actor_token._sync_from_token(context['actor_token'])
        except Exception:
            if context is not None:
                self._sync_from_token(context['token'])
                if actor_token is not None and actor_token is not self and context['actor_token'] is not None:
                    actor_token._sync_from_token(context['actor_token'])
            raise
        return self

    def reparent_to(self, parent_token):
        """把当前 Token 挂到新的父 Token 下。"""
        if self.pk is None:
            raise TokenTargetValidationError(
                '未持久化的 Token 不能执行 reparent',
                error_code=ErrorCode.VALIDATION_ERROR,
                status_code=400,
            )
        if parent_token is not None and getattr(parent_token, 'pk', None) is None:
            raise TokenTargetValidationError(
                '目标父 Token 尚未持久化，无法执行 reparent',
                error_code=ErrorCode.VALIDATION_ERROR,
                status_code=400,
            )

        context = None
        try:
            with transaction.atomic(using=TABDATA_DB_ALIAS):
                context = self._lock_governance_context(
                    candidate_parent_token=parent_token,
                    target_missing_message='目标 Token 不存在，无法执行父链修复',
                    candidate_parent_missing_message='目标父 Token 不存在，无法执行父链修复',
                    target_missing_error_code=ErrorCode.NOT_FOUND,
                    target_missing_status_code=404,
                    candidate_parent_missing_error_code=ErrorCode.NOT_FOUND,
                    candidate_parent_missing_status_code=404,
                )
                locked_token = context['token']
                locked_parent = context['candidate_parent_token']
                new_parent_id = locked_parent.pk if locked_parent is not None else None
                if str(locked_token.parent_token_id or '') == str(new_parent_id or ''):
                    self._sync_from_token(locked_token)
                    if parent_token is not None and parent_token is not self and locked_parent is not None:
                        parent_token._sync_from_token(locked_parent)
                    return self

                old_parent_token = locked_token.parent_token
                old_parent_token_id = locked_token.parent_token_id
                old_updated_at = locked_token.updated_at
                now = timezone.now()
                updated = self.__class__.objects.using(TABDATA_DB_ALIAS).filter(pk=locked_token.pk).update(
                    parent_token_id=new_parent_id,
                    updated_at=now,
                )
                if updated != 1:
                    raise TokenTargetValidationError(
                        '目标 Token 不存在，无法执行父链修复',
                        error_code=ErrorCode.VALIDATION_ERROR,
                        status_code=400,
                    )

                try:
                    locked_token.parent_token = locked_parent
                    locked_token.parent_token_id = new_parent_id
                    locked_token.updated_at = now
                    locked_token.validate_scopes()
                    locked_token.validate_scope_targets()
                    locked_token.validate_parent_delegation()
                    locked_token.validate_descendant_delegation()
                except Exception:
                    locked_token.parent_token = old_parent_token
                    locked_token.parent_token_id = old_parent_token_id
                    locked_token.updated_at = old_updated_at
                    raise

                self._sync_from_token(locked_token)
                if parent_token is not None and parent_token is not self and locked_parent is not None:
                    parent_token._sync_from_token(locked_parent)
        except Exception:
            if context is not None:
                self._sync_from_token(context['token'])
                if (
                    parent_token is not None
                    and parent_token is not self
                    and context['candidate_parent_token'] is not None
                ):
                    parent_token._sync_from_token(context['candidate_parent_token'])
            raise
        return self

    def detach_from_parent(self):
        """把当前 Token 从父 Token 树中分离为根 Token。"""
        return self.reparent_to(None)

    def repair_cross_user_links(self):
        """切断当前父子图中所有跨用户脏委托边。"""
        plan = {
            'repair_target_tokens': [],
            'repair_target_count': 0,
            'same_user_repair_target_count': 0,
            'foreign_user_repair_target_count': 0,
            'warnings': [],
        }
        changed_count = 0
        health_summary = self.summarize_cross_user_link_repair_health(plan)
        target_transition = {
            'before_state': self._serialize_transition_state(self),
            'after_state': self._serialize_transition_state(self),
        }
        with transaction.atomic(using=TABDATA_DB_ALIAS):
            plan = self.stabilize_cross_user_link_repair_plan(
                self.build_cross_user_link_repair_plan(),
                lock_targets=True,
            )
            current_target = next(
                (token for token in plan['repair_target_tokens'] if str(token.pk) == str(self.pk)),
                None,
            )
            current_root_after_repair = current_target if current_target is not None else self
            if current_target is not None:
                target_transition['before_state'] = self._serialize_transition_state(current_target)
            target_ids = [token.pk for token in plan['repair_target_tokens'] if token.pk]
            now = timezone.now()
            if target_ids:
                changed_count = self.__class__.objects.using(TABDATA_DB_ALIAS).filter(
                    pk__in=target_ids,
                ).exclude(parent_token_id=None).update(
                    parent_token_id=None,
                    updated_at=now,
                )
                for token in plan['repair_target_tokens']:
                    token.parent_token = None
                    token.parent_token_id = None
                    token.updated_at = now
            if current_target is not None:
                target_transition['after_state'] = self._serialize_transition_state(current_target)
            health_summary = self.summarize_cross_user_link_repair_health(plan)
            health_summary = self._append_cross_user_repair_cycle_warning(
                health_summary,
                current_root_after_repair.collect_root_subtree_health_issues(),
            )
        return plan, changed_count, health_summary, target_transition

    def cascade_deactivate(self):
        """显式停用当前 Token 及其整棵子树。"""
        if self.pk is None:
            raise TokenTargetValidationError(
                '未持久化的 Token 无法执行级联停用',
                error_code=ErrorCode.VALIDATION_ERROR,
                status_code=400,
            )

        with transaction.atomic(using=TABDATA_DB_ALIAS):
            context = self._lock_governance_context(
                target_missing_message='目标 Token 不存在，无法执行级联停用',
                target_missing_error_code=ErrorCode.NOT_FOUND,
                target_missing_status_code=404,
            )
            tokens = context['subtree_tokens']
            changed_tokens = [token for token in tokens if token.is_active]
            token_ids = [token.pk for token in tokens if token.pk]
            now = timezone.now()
            changed_count = self.__class__.objects.using(TABDATA_DB_ALIAS).filter(
                pk__in=token_ids,
                is_active=True,
            ).update(
                is_active=False,
                updated_at=now,
            )
            for token in tokens:
                token.is_active = False
                token.updated_at = now
            self._sync_from_token(context['token'])
            return tokens, changed_tokens, changed_count

    def get_effective_rate_limit(self):
        """返回用于治理展示与 boundary 判断的一致 rate_limit。"""
        return _normalize_token_rate_limit_ceiling(self.rate_limit)

    def has_scope(self, required_scope: str) -> bool:
        """检查 Token 是否具有指定 scope"""
        return required_scope in self.scopes

    def has_any_scope(self, required_scopes: list) -> bool:
        """检查 Token 是否具有任意一个 scope"""
        return bool(set(self.scopes) & set(required_scopes))

    def can_access_space(self, space_id: str) -> bool:
        """检查 Token 是否可访问指定 Space"""
        if self.space_ids is None:
            return True
        return str(space_id) in [str(p) for p in self.space_ids]

    def can_access_table(self, table_id: str, space_id: str | None = None) -> bool:
        """检查 Token 是否可访问指定表格。

        table_ids 与 space_ids 同时存在时取交集，避免任一维度单独放大权限。
        但当 table_ids 显式包含该表且 space_id 为 None（历史遗留数据）时，
        信任显式的表级授权。
        """
        table_explicitly_listed = (
            self.table_ids is not None
            and str(table_id) in [str(t) for t in self.table_ids]
        )

        if self.table_ids is not None and not table_explicitly_listed:
            return False

        if self.space_ids is None:
            return True
        if space_id is None:
            return table_explicitly_listed
        return self.can_access_space(space_id)
