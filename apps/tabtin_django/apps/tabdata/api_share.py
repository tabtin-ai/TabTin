"""
TabData 数据分享 API

表格数据只读分享（区别于表单分享 api_form.py）：
- 管理端点（JWT）：创建/查询/关闭/轮换数据分享
- 公开端点（JWTAuthOptional）：获取表格元数据和数据（只读）

公开端点鉴权统一走 ``TableShareService.verify_share_access`` ——
organization / 密码 / 过期 / 失效检查全部下沉到基类，view 层只负责
catch 异常 + 降级响应（PRD §5 Phase 2 落地）。
"""

from __future__ import annotations

import json
import logging
from uuid import UUID

from django.http import HttpRequest
from django.utils import timezone
from ninja import Router, Schema
from typing import Any, List, Optional

from django.db import transaction

from apps.services.common.public_share import (
    ShareManagementPermissionDeniedError,
    ShareNotFoundError,
    SharePasswordIncorrectError,
    SharePasswordRequiredError,
    SharePermissionDeniedError,
    ShareOrganizationMismatchError,
    SharePublicExposureAcknowledgementRequiredError,
    get_authenticated_user,
)
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.exceptions import RLSAccessDenied
from apps.tabdata.models import RecordComment, Table, TableRecord, TableShare, TableView
from apps.tabdata.services.comment_service import RecordCommentService
from apps.tabdata.services.rls_service import RLSContext
from apps.tabdata.services.share_service import (
    CollaboratorError,
    TableShareService,
    invite_collaborators,
    list_collaborators,
    list_tables_shared_with_me,
    remove_collaborator,
    update_collaborator_permission,
)
from apps.users.auth.permissions import JWTAuth, JWTAuthOptional
from apps.i18n.response import (
    error_response_with_status as error_response,
    not_found_response,
    permission_denied_response,
    success_response,
)
from apps.tabdata.utils.record_serializers import serialize_record

logger = logging.getLogger("tabdata.api.share")

router = Router(tags=["TabData Share"])
jwt_auth = JWTAuth()
jwt_auth_optional = JWTAuthOptional()

TABDATA_DB = TABDATA_DB_ALIAS
class CreateDataShareRequest(Schema):
    """创建/更新数据分享请求。

    PATCH 语义（Wave 5 §C）：
    - ``password=None`` （字段未传）→ 不动密码（保留旧 hash）
    - ``password=""``   （显式空字符串）→ 清空密码
    - ``password="abc"``（非空）→ 设新密码（hash 化）

    Schema 用 ``Optional[str]`` 区分 "未传" vs "显式空字符串"。

    安全缺省（对齐  TabDoc）：
    - 省略 ``share_type`` 时默认 ``organization``（组织内）
    - 扩大到 ``data``（任何人）须 ``acknowledge_public_exposure=true``
    """

    share_type: str = "organization"
    permission: str = "view"
    password: Optional[str] = None
    expire_hours: Optional[int] = None
    allow_download: bool = True
    view_id: Optional[str] = None
    organization_id: str = ""
    acknowledge_public_exposure: bool = False


class DataShareOut(Schema):
    share_id: str
    share_type: str
    permission: str
    has_password: bool
    expire_at: Optional[str] = None
    allow_download: bool
    visit_count: int
    created_at: Optional[str] = None


class UpdateSharedRecordRequest(Schema):
    """公开分享页更新单元格（permission=edit 时）。"""

    field_id: str
    value: Any = None
    password: Optional[str] = None


class ShareCollabTokenRequest(Schema):
    password: str = ""


class CreateSharedRecordCommentRequest(Schema):
    """分享页新增评论；mentions 为旧客户端兼容字段。"""

    content: str
    client_request_id: Optional[str] = None
    mention_user_ids: List[str] = []
    reply_to_comment_id: Optional[UUID] = None
    mentions: List[str] = []
    password: Optional[str] = None


class UpdateSharedRecordCommentThreadStatusRequest(Schema):
    status: str
    password: Optional[str] = None


def _serialize_data_share(share: TableShare) -> dict:
    """管理端点响应序列化（含 expire_at / visit_count / created_at 等管理字段）。

    与 ``TableShareService.serialize_meta`` 区别：后者面向公开 meta 端点，
    返回 table_name / table_icon / fields[] 等业务字段；本函数面向 owner
    在控制台「管理分享」时的状态展示，返回密码 / 过期 / 访问统计等元信息。
    """
    return {
        "share_id": share.share_id,
        "share_type": share.share_type,
        "permission": share.permission,
        "has_password": share.has_password,
        "expire_at": share.expire_at.isoformat() if share.expire_at else None,
        "allow_download": share.allow_download,
        "visit_count": share.visit_count,
        "created_at": share.created_at.isoformat() if share.created_at else None,
    }


def _interactive_table_share_auth_required_response(share: TableShare, user):
    """可编辑表格分享必须登录后才能提交写入；公开读取不走此门禁。"""
    if TableShareService.share_requires_authenticated_editor(share) and not getattr(user, "id", None):
        return permission_denied_response("Need login")
    return None


def _share_password_from_headers(request: HttpRequest) -> str:
    """读取公开分享密码头。

    正典头为 ``X-Table-Share-Password``（与 CORS / TabData 中间件 / web bootstrap 对齐）。
    兼容旧头 ``X-Share-Password``（历史 SharedTablePage 曾用它，但 CORS 曾未放行）。
    """
    return (
        request.headers.get("X-Table-Share-Password")
        or request.headers.get("X-Share-Password")
        or ""
    )


def _share_type_from_request(request: HttpRequest, query_value: str) -> str:
    """解析 share_type，兼容两类调用方（镜像 tabdoc/api_share.py 同名 helper，）。

    - 前端 / 默认：从 URL query 读（``query_value``，ninja 已解析）。
    - tabtin CLI 写命令：``DELETE`` 把参数放进 JSON body（CLI 声明式管线只对
      GET 做 body→query，见 internal/cmdutil/pipeline.go），故这里再看一眼
      body，body 显式给了就优先。

    没有这层兼容，``table share off --share-type organization`` 会被静默当成
    ``data``（Ninja 把 close_data_share 的裸 str 参数按 query 绑定，CLI 却把
    值放进了 DELETE 的 JSON body，两边对不上）——#7778 spec review 抓到的
    critical bug，修法对齐  doc share off 已验证过的方案。
    """
    try:
        raw = request.body
    except Exception:
        raw = b""
    if raw:
        try:
            data = json.loads(raw)
        except (ValueError, TypeError):
            data = None
        if isinstance(data, dict) and data.get("share_type"):
            return str(data["share_type"])
    return query_value


def _management_error_to_response(exc):
    """把 PublicShareService 管理端异常映射成 JSONResponse。

    本 helper 与 ``_collaborator_error_to_response`` 平级：collaborator 端
    走自定义 ``CollaboratorError``（自带 code/status/message），share 端
    走 ``apps.services.common.public_share.exceptions`` 那套语义异常 ——
    两套互不耦合，但都最终通过 i18n.response 输出标准 envelope。
    """
    if isinstance(exc, ShareNotFoundError):
        return not_found_response("TABLE_NOT_FOUND", "表格不存在")
    if isinstance(exc, ShareManagementPermissionDeniedError):
        return permission_denied_response(str(exc) or "需要管理权限")
    if isinstance(exc, ShareOrganizationMismatchError):
        return error_response(
            "INVALID_ORGANIZATION_ID",
            str(exc) or "organization_id 非法",
            status_code=400,
        )
    return error_response("INTERNAL_ERROR", str(exc) or "未知错误", status_code=500)


def _list_accessible_data_org_shares(table: Table) -> list[TableShare]:
    """列出表格上未过期的 data / organization 分享（排除 form）。"""
    shares = list(
        TableShare.objects.using(TABDATA_DB)
        .filter(table=table, share_type__in=["data", "organization"])
        .order_by("created_at")
    )
    return [s for s in shares if not s.is_expired()]


def _get_effective_data_share(table: Table) -> TableShare | None:
    """返回当前有效分享。

    互斥后通常至多一条；历史并存时优先暴露公网 ``data``，避免静默隐藏
    仍可访问的公开链接。
    """
    accessible = _list_accessible_data_org_shares(table)
    if not accessible:
        return None
    for share in accessible:
        if share.share_type == "data":
            return share
    return accessible[0]


@router.post(
    "/tables/{table_id}/share",
    auth=jwt_auth,
    summary="创建或更新表格数据分享",
)
def create_data_share(request: HttpRequest, table_id: UUID, data: CreateDataShareRequest):
    if data.share_type not in ("data", "organization"):
        return error_response(
            "INVALID_SHARE_TYPE",
            "share_type 必须是 data 或 organization",
            status_code=400,
        )
    if data.permission not in ("view", "comment", "edit"):
        return error_response(
            "INVALID_PERMISSION",
            "permission 必须是 view、comment 或 edit",
            status_code=400,
        )

    # P0-2：横向越权防护 —— 必须先校验 operator 对 table 拥有 admin 权限
    try:
        table = TableShareService.load_resource_for_management(
            table_id, request.auth,
        )
    except (ShareNotFoundError, ShareManagementPermissionDeniedError) as exc:
        return _management_error_to_response(exc)

    # organization 分享：未传 organization_id 时从表格归属推导（对齐 TabDoc）
    organization_id = (data.organization_id or "").strip()
    if data.share_type == "organization":
        if not organization_id:
            organization_id = str(getattr(table, "organization_id", "") or "")
        if not organization_id:
            return error_response(
                "INVALID_ORGANIZATION_ID", "organization_id 必填", status_code=400,
            )
        try:
            UUID(str(organization_id))
        except (ValueError, TypeError):
            return error_response(
                "INVALID_ORGANIZATION_ID", "organization_id 必须是合法 UUID",
                status_code=400,
            )
        try:
            TableShareService.validate_organization_scope(table, organization_id)
        except ShareOrganizationMismatchError as exc:
            return error_response(
                "INVALID_ORGANIZATION_ID",
                str(exc) or "organization_id 非法",
                status_code=400,
            )
    else:
        organization_id = ""

    import datetime
    expire_at = None
    if data.expire_hours and data.expire_hours > 0:
        expire_at = timezone.now() + datetime.timedelta(hours=data.expire_hours)

    view = None
    if data.view_id:
        try:
            view = TableView.objects.using(TABDATA_DB).get(id=data.view_id, table=table)
        except TableView.DoesNotExist:
            return not_found_response("VIEW_NOT_FOUND", "视图不存在")

    try:
        with transaction.atomic(using=TABDATA_DB):
            # 锁表格行，避免并发双开 data + organization
            Table.objects.using(TABDATA_DB).select_for_update().get(pk=table.pk)

            accessible = _list_accessible_data_org_shares(table)
            has_accessible_data = any(s.share_type == "data" for s in accessible)
            widening_to_public = data.share_type == "data" and not has_accessible_data
            if widening_to_public and not data.acknowledge_public_exposure:
                raise SharePublicExposureAcknowledgementRequiredError(
                    "acknowledge_public_exposure required to widen share to data",
                )

            # 互斥：切换范围时物理删除另一类型（TableShare 无 is_active，沿用既有删除语义）
            (
                TableShare.objects.using(TABDATA_DB)
                .filter(table=table, share_type__in=["data", "organization"])
                .exclude(share_type=data.share_type)
                .delete()
            )

            existing = (
                TableShare.objects.using(TABDATA_DB)
                .filter(table=table, share_type=data.share_type)
                .first()
            )

            if existing and not existing.is_expired():
                existing.permission = data.permission
                # PATCH 语义：data.password is None 表示未传 → 不动密码
                if data.password is not None:
                    existing.set_password(data.password)
                existing.expire_at = expire_at
                existing.allow_download = data.allow_download
                existing.organization_id = organization_id
                if view:
                    existing.view = view
                existing.save(using=TABDATA_DB)
                share = existing
            else:
                # 过期行或无行：新建（过期行先删，避免唯一约束冲突）
                if existing:
                    existing.delete(using=TABDATA_DB)
                share = TableShare(
                    table=table,
                    view=view,
                    share_type=data.share_type,
                    share_id=TableShareService.generate_share_id(),
                    permission=data.permission,
                    expire_at=expire_at,
                    allow_download=data.allow_download,
                    organization_id=organization_id,
                    created_by=request.auth,
                )
                # 新建分享：password=None 表示无密码（与显式 "" 等价）；非 None 走 set_password
                if data.password is not None and data.password != "":
                    share.set_password(data.password)
                share.save(using=TABDATA_DB)
    except SharePublicExposureAcknowledgementRequiredError:
        return error_response(
            "PUBLIC_EXPOSURE_ACK_REQUIRED",
            "扩大到「任何人」可访问前须确认公网暴露风险",
            status_code=409,
        )

    return success_response({"share": _serialize_data_share(share)})


@router.get(
    "/tables/{table_id}/share",
    auth=jwt_auth,
    summary="获取表格数据分享设置",
)
def get_data_share(request: HttpRequest, table_id: UUID, share_type: str = ""):
    """获取当前有效分享。

    - 未传 / 空 ``share_type``：返回当前有效 data 或 organization 分享
      （历史并存时优先 data，避免静默隐藏仍可访问的公开链接）
    - 显式 ``data`` / ``organization``：按类型查询
    - 非空非法值：400
    """
    # P0-2：横向越权防护
    try:
        table = TableShareService.load_resource_for_management(
            table_id, request.auth,
        )
    except (ShareNotFoundError, ShareManagementPermissionDeniedError) as exc:
        return _management_error_to_response(exc)

    resolved = (share_type or "").strip()
    if resolved:
        if resolved not in ("data", "organization"):
            return error_response(
                "INVALID_SHARE_TYPE",
                "share_type 必须是 data 或 organization",
                status_code=400,
            )
        share = (
            TableShare.objects.using(TABDATA_DB)
            .filter(table=table, share_type=resolved)
            .first()
        )
        if not share or share.is_expired():
            return success_response({"share": None, "enabled": False})
        return success_response({"share": _serialize_data_share(share), "enabled": True})

    share = _get_effective_data_share(table)
    if not share:
        return success_response({"share": None, "enabled": False})

    return success_response({"share": _serialize_data_share(share), "enabled": True})


@router.delete(
    "/tables/{table_id}/share",
    auth=jwt_auth,
    summary="关闭表格数据分享",
)
def close_data_share(request: HttpRequest, table_id: UUID, share_type: str = "data"):
    # P0-2：横向越权防护
    try:
        table = TableShareService.load_resource_for_management(
            table_id, request.auth,
        )
    except (ShareNotFoundError, ShareManagementPermissionDeniedError) as exc:
        return _management_error_to_response(exc)

    # ：resolved 优先取 JSON body 里的 share_type（tabtin CLI 写法），
    # 拿不到再回退 Ninja 解析的 query 值；否则 CLI 传 --share-type=organization
    # 会被静默当成默认 data 关掉，见 _share_type_from_request 文档字符串。
    resolved = _share_type_from_request(request, share_type) or "data"

    count = (
        TableShare.objects.using(TABDATA_DB)
        .filter(table=table, share_type=resolved)
        .exclude(share_type='form')
        .delete()
    )[0]
    return success_response({"deleted_count": count})


def _load_public_share(share_id: str):
    """加载公开访问入口的 share，并把 not_found / expired 映射成统一响应。

    与 ``PublicShareService.get_share_by_id`` 的差异：本 helper 兜底了
    tabdata 自有的 ``share_type__in=['data', 'organization']`` 过滤 ——
    防止 attacker 用同样的 share_id 访问公开 meta 端点时撞上 form 分享
    （form 走的是另一套接口，公开端点不应回退到 form schema）。
    """
    try:
        share = (
            TableShare.objects.using(TABDATA_DB)
            .select_related("table", "view")
            .get(
                share_id=share_id,
                share_type__in=["data", "organization"],
            )
        )
    except TableShare.DoesNotExist:
        return None, not_found_response("SHARE_NOT_FOUND", "分享不存在或已失效")

    if share.is_expired():
        return None, error_response("SHARE_EXPIRED", "分享已过期", status_code=410)

    return share, None


def _authorize_comment_share(
    request: HttpRequest,
    share_id: str,
    *,
    password: str = "",
):
    """加载允许评论的分享；评论分享始终要求已登录用户。"""
    share, err = _load_public_share(share_id)
    if err is not None:
        return None, None, err

    user = get_authenticated_user(request)
    if not getattr(user, "id", None):
        return None, None, permission_denied_response("Need login")

    try:
        TableShareService.verify_share_access(
            share,
            password=password,
            user=user,
        )
    except SharePasswordRequiredError:
        return None, None, error_response(
            "PASSWORD_REQUIRED", "需要密码", status_code=403
        )
    except SharePasswordIncorrectError:
        return None, None, error_response(
            "INCORRECT_PASSWORD", "密码错误", status_code=403
        )
    except SharePermissionDeniedError as exc:
        return None, None, permission_denied_response(str(exc) or "无权限")
    except ShareNotFoundError:
        return None, None, not_found_response(
            "SHARE_NOT_FOUND", "分享不存在或已失效"
        )

    if share.permission not in {"comment", "edit"}:
        return None, None, permission_denied_response("分享链接不允许评论")
    return share, user, None


def _shared_comment_error_to_response(exc: Exception):
    """分享评论隐藏记录/RLS 命中状态，其余错误沿用标准 envelope。"""
    if isinstance(exc, (TableRecord.DoesNotExist, RLSAccessDenied)):
        return not_found_response("RECORD_NOT_FOUND", "记录不存在")
    if isinstance(exc, RecordComment.DoesNotExist):
        return not_found_response("COMMENT_NOT_FOUND", "评论不存在")
    if isinstance(exc, PermissionError):
        return permission_denied_response(str(exc) or "无权限")
    if isinstance(exc, ValueError):
        return error_response("VALIDATION_ERROR", str(exc), status_code=400)
    logger.error("[shared_record_comment] Failed: %s", exc, exc_info=True)
    return error_response("COMMENT_FAILED", "评论操作失败", status_code=500)


@router.get(
    "/shared/{share_id}",
    auth=jwt_auth_optional,
    summary="获取公开表格元数据（匿名可访问，organization 限定时需登录）",
)
def get_shared_table_meta(
    request: HttpRequest,
    share_id: str,
    password: str = "",
):
    """P0-3 + R2 兼容的 meta 端点。

    - 密码态（has_password=True + 未通过校验）：返回基础展示字段
      （share_id / share_type / has_password + table_name / table_icon
      / table_description），**不**返 fields[] / view_name / permission /
      allow_download，前端 SharedTablePage 据此渲染密码框 + 表名/图标。
    - organization 限定 + outsider / anonymous：返 403。
    - 全通过：返回完整 meta（含 fields[]）。

    organization 分支用 ``verify_share_access`` 鉴权，密码 token 通过 URL
    query 传（PRD §4.3：保持现状，P2 再做密码进 body 改造）。
    """
    share, err = _load_public_share(share_id)
    if err is not None:
        return err

    user = get_authenticated_user(request)

    try:
        TableShareService.verify_share_access(
            share, password=password, user=user,
        )
    except SharePermissionDeniedError as exc:
        # organization 限定 + outsider / anonymous → 403，**绝不返业务字段**
        return permission_denied_response(str(exc) or "无权限")
    except (SharePasswordRequiredError, SharePasswordIncorrectError):
        # 密码未通过 → R2 兼容：返基础展示字段（含 table_name / table_icon），
        # 移除 fields[] / view_name / permission / allow_download
        return success_response(
            TableShareService.serialize_meta(share, include_protected=False),
        )

    return success_response(
        TableShareService.serialize_meta(
            share, include_protected=True, user=user,
        ),
    )


@router.get(
    "/shared/{share_id}/records",
    auth=jwt_auth_optional,
    summary="获取公开表格数据（匿名可访问，organization 限定时需登录，分页）",
)
def get_shared_table_records(
    request: HttpRequest,
    share_id: str,
    page: int = 1,
    page_size: int = 50,
):
    """P0-1 + P0-3：records 端点鉴权统一下沉到 ``verify_share_access``。

    本端点的 records 数据流仍调用旧的 ViewService（Phase 3 再迁移到
    ``TableShareService.serialize_content``），但鉴权 / 密码 / organization 校验
    都已删除内联，全部走基类，避免 ``OrganizationMember(... is_active=True)``
    传错字段（PRD §4.1 P0-1 共同次因）这类老 bug 复发。
    """
    share, err = _load_public_share(share_id)
    if err is not None:
        return err

    # 密码通过请求头传递（避免出现在 URL query / 浏览器历史 / 日志中）
    password = _share_password_from_headers(request)
    user = get_authenticated_user(request)
    try:
        TableShareService.verify_share_access(
            share, password=password, user=user,
        )
    except SharePasswordRequiredError:
        return error_response("PASSWORD_REQUIRED", "需要密码", status_code=403)
    except SharePasswordIncorrectError:
        return error_response("INCORRECT_PASSWORD", "密码错误", status_code=403)
    except SharePermissionDeniedError as exc:
        return permission_denied_response(str(exc) or "无权限")

    share.visit_count += 1
    share.save(using=TABDATA_DB, update_fields=['visit_count'])

    page_size = min(max(page_size, 1), 100)
    page = max(page, 1)

    try:
        data = TableShareService.get_records(
            share, user=user, page=page, page_size=page_size,
        )
    except Exception as e:
        logger.error("[shared_records] Failed to fetch records: %s", e)
        return error_response("FETCH_FAILED", "获取数据失败", status_code=500)

    return success_response(data)


@router.get(
    "/shared/{share_id}/records/{record_id}/comments",
    auth=jwt_auth_optional,
    summary="获取分享记录评论",
)
def list_shared_record_comments(
    request: HttpRequest,
    share_id: str,
    record_id: UUID,
    status: Optional[str] = None,
    before: Optional[str] = None,
    cursor: Optional[str] = None,
    anchor: Optional[UUID] = None,
    limit: int = 50,
):
    share, user, err = _authorize_comment_share(
        request,
        share_id,
        password=_share_password_from_headers(request),
    )
    if err is not None:
        return err

    service = RecordCommentService(user=user)
    try:
        result = service.list_comments(
            record_id,
            status=status,
            before=before,
            cursor=cursor,
            anchor=anchor,
            limit=limit,
            rls_context=RLSContext.from_request(request),
            share_grant=share,
        )
    except Exception as exc:
        return _shared_comment_error_to_response(exc)
    return success_response(result)


@router.patch(
    "/shared/{share_id}/records/{record_id}/comment-threads/{thread_id}/status",
    auth=jwt_auth_optional,
    summary="通过分享更新记录评论线程状态",
)
def update_shared_record_comment_thread_status(
    request: HttpRequest,
    share_id: str,
    record_id: UUID,
    thread_id: UUID,
    data: UpdateSharedRecordCommentThreadStatusRequest,
):
    share, user, err = _authorize_comment_share(
        request,
        share_id,
        password=_share_password_from_headers(request) or data.password or "",
    )
    if err is not None:
        return err

    service = RecordCommentService(user=user)
    try:
        thread = service.update_thread_status(
            record_id,
            thread_id,
            status=data.status,
            rls_context=RLSContext.from_request(request),
            share_grant=share,
        )
    except Exception as exc:
        return _shared_comment_error_to_response(exc)
    return success_response({"thread": service.serialize_thread(thread)})


@router.post(
    "/shared/{share_id}/records/{record_id}/comments",
    auth=jwt_auth_optional,
    response={201: dict},
    summary="通过分享新增记录评论",
)
def create_shared_record_comment(
    request: HttpRequest,
    share_id: str,
    record_id: UUID,
    data: CreateSharedRecordCommentRequest,
):
    share, user, err = _authorize_comment_share(
        request,
        share_id,
        password=_share_password_from_headers(request) or data.password or "",
    )
    if err is not None:
        return err

    service = RecordCommentService(user=user)
    try:
        comment, created = service.create_comment(
            record_id,
            content=data.content,
            client_request_id=data.client_request_id,
            mentions=[*data.mention_user_ids, *data.mentions],
            reply_to_comment_id=data.reply_to_comment_id,
            rls_context=RLSContext.from_request(request),
            share_grant=share,
        )
    except Exception as exc:
        return _shared_comment_error_to_response(exc)
    return 201, success_response(
        {
            "comment": service.serialize_comment(comment),
            "created": created,
        }
    )


@router.delete(
    "/shared/{share_id}/records/{record_id}/comments/{comment_id}",
    auth=jwt_auth_optional,
    summary="通过分享删除自己的记录评论",
)
def delete_shared_record_comment(
    request: HttpRequest,
    share_id: str,
    record_id: UUID,
    comment_id: UUID,
):
    share, user, err = _authorize_comment_share(
        request,
        share_id,
        password=_share_password_from_headers(request),
    )
    if err is not None:
        return err

    service = RecordCommentService(user=user)
    try:
        comment = service.delete_comment(
            record_id,
            comment_id,
            rls_context=RLSContext.from_request(request),
            share_grant=share,
        )
    except Exception as exc:
        return _shared_comment_error_to_response(exc)
    return success_response(
        {
            "deleted": True,
            "comment_id": str(comment.id),
            "comment": service.serialize_comment(comment),
        }
    )


@router.get(
    "/shared/{share_id}/records/{record_id}/comment-mention-candidates",
    auth=jwt_auth_optional,
    summary="获取分享记录评论的提及候选",
)
def list_shared_record_comment_mention_candidates(
    request: HttpRequest,
    share_id: str,
    record_id: UUID,
    q: str = "",
    limit: int = 50,
):
    share, user, err = _authorize_comment_share(
        request,
        share_id,
        password=_share_password_from_headers(request),
    )
    if err is not None:
        return err

    service = RecordCommentService(user=user)
    try:
        candidates = service.list_mention_candidates(
            record_id,
            query=q,
            limit=limit,
            rls_context=RLSContext.from_request(request),
            share_grant=share,
        )
    except Exception as exc:
        return _shared_comment_error_to_response(exc)
    return success_response({"candidates": candidates})


@router.post(
    "/shared/{share_id}/collab-token",
    auth=jwt_auth_optional,
    summary="签发分享页协作 token（只读实时同步）",
)
def issue_table_share_collab_token(
    request: HttpRequest,
    share_id: str,
    data: ShareCollabTokenRequest,
):
    share, err = _load_public_share(share_id)
    if err is not None:
        return err

    password = _share_password_from_headers(request) or data.password
    user = get_authenticated_user(request)
    try:
        TableShareService.verify_share_access(
            share, password=password, user=user,
        )
    except SharePasswordRequiredError:
        return error_response("PASSWORD_REQUIRED", "需要密码", status_code=403)
    except SharePasswordIncorrectError:
        return error_response("INCORRECT_PASSWORD", "密码错误", status_code=403)
    except SharePermissionDeniedError as exc:
        return permission_denied_response(str(exc) or "无权限")

    try:
        payload = TableShareService.issue_share_collab_token(share, user=user)
    except SharePermissionDeniedError as exc:
        return permission_denied_response(str(exc) or "无权限")

    return success_response(payload)


@router.patch(
    "/shared/{share_id}/records/{record_id}",
    auth=jwt_auth_optional,
    summary="通过可编辑分享更新表格记录单元格",
)
def update_shared_table_record(
    request: HttpRequest,
    share_id: str,
    record_id: UUID,
    data: UpdateSharedRecordRequest,
):
    share, err = _load_public_share(share_id)
    if err is not None:
        return err

    user = get_authenticated_user(request)
    auth_required_response = _interactive_table_share_auth_required_response(share, user)
    if auth_required_response is not None:
        return auth_required_response

    try:
        updated_record = TableShareService.update_shared_record(
            share,
            user=user,
            password=data.password or "",
            record_id=record_id,
            data={data.field_id: data.value},
        )
    except SharePasswordRequiredError:
        return error_response("PASSWORD_REQUIRED", "需要密码", status_code=403)
    except SharePasswordIncorrectError:
        return error_response("INCORRECT_PASSWORD", "密码错误", status_code=403)
    except SharePermissionDeniedError as exc:
        return permission_denied_response(str(exc) or "无权限")
    except Exception as exc:
        from apps.tabdata.models import TableRecord

        if isinstance(exc, TableRecord.DoesNotExist):
            return not_found_response("RECORD_NOT_FOUND", "记录不存在")
        if isinstance(exc, (PermissionError, ValueError)):
            return error_response("VALIDATION_ERROR", str(exc), status_code=400)
        logger.error("[shared_record_update] Failed to update record: %s", exc, exc_info=True)
        return error_response("UPDATE_FAILED", "更新失败", status_code=500)

    # ：update_shared_record 已按角色投影；此处再保证 serialize 不回源全量
    from apps.tabdata.services.field_visibility import (
        filter_record_data,
        get_visible_field_key_sets,
        resolve_effective_table_role,
    )

    role = resolve_effective_table_role(user, share.table, share=share)
    visible_keys = get_visible_field_key_sets(share.table_id, role)
    if not getattr(updated_record, "_visibility_filtered", False):
        from apps.tabdata.utils.record_data_access import read_data

        updated_record._filtered_data = filter_record_data(
            read_data(updated_record), visible_keys,
        )
        updated_record._visibility_filtered = True
    return success_response({"record": serialize_record(updated_record)})


# ════════════════════════════════════════════════════════════════════
# 协作者管理（PRD §五块 1，TabData 对称版）
# ════════════════════════════════════════════════════════════════════


class UserBrief(Schema):
    user_id: str
    nickname: str
    avatar: Optional[str] = None
    email: str


class CollaboratorOut(UserBrief):
    permission: str
    created_at: Optional[str] = None


class CollaboratorListOut(Schema):
    owner: UserBrief
    collaborators: List[CollaboratorOut]


class InviteCollaboratorsRequest(Schema):
    user_ids: List[str]
    permission: str


class UpdateCollaboratorRequest(Schema):
    permission: str


class SkippedItem(Schema):
    user_id: str
    reason: str


class InviteCollaboratorsResponse(Schema):
    notified: int
    skipped: List[SkippedItem]


def _collaborator_error_to_response(exc: CollaboratorError):
    """保留精确 code，方便前端按 code 做差异化提示。"""
    return error_response(
        exc.code,
        exc.message,
        status_code=exc.status,
        data=exc.data,
    )


@router.post(
    "/tables/{table_id}/collaborators",
    auth=jwt_auth,
    summary="邀请协作者（批量）",
)
def invite_collaborators_endpoint(
    request: HttpRequest, table_id: UUID, data: InviteCollaboratorsRequest,
):
    try:
        result = invite_collaborators(
            table_id=table_id,
            user_ids=data.user_ids,
            permission=data.permission,
            inviter=request.auth,
        )
    except CollaboratorError as exc:
        return _collaborator_error_to_response(exc)
    return success_response(result)


@router.get(
    "/shared-with-me",
    auth=jwt_auth,
    summary="列出分享给我的表格（资源级协作，不依赖 Space 成员身份）",
)
def list_shared_with_me_endpoint(request: HttpRequest, organization_id: str = ""):
    """与 TabDoc 对称的独立访问发现入口：返回当前用户具备有效 TablePermission
    但本人非 owner 的活跃表格。静态路径 ``/shared-with-me`` 避开
    ``/tables/{table_id}`` 的 catch-all 匹配。"""
    try:
        tables = list_tables_shared_with_me(
            viewer=request.auth,
            organization_id=(organization_id or None),
        )
    except CollaboratorError as exc:
        return _collaborator_error_to_response(exc)
    return success_response({"tables": tables, "total": len(tables)})


@router.get(
    "/tables/{table_id}/collaborators",
    auth=jwt_auth,
    summary="列出协作者（含 owner）",
)
def list_collaborators_endpoint(request: HttpRequest, table_id: UUID):
    try:
        result = list_collaborators(table_id=table_id, viewer=request.auth)
    except CollaboratorError as exc:
        return _collaborator_error_to_response(exc)
    return success_response(result)


@router.patch(
    "/tables/{table_id}/collaborators/{user_id}",
    auth=jwt_auth,
    summary="修改协作者权限",
)
def update_collaborator_endpoint(
    request: HttpRequest, table_id: UUID, user_id: str, data: UpdateCollaboratorRequest,
):
    try:
        result = update_collaborator_permission(
            table_id=table_id,
            user_id=user_id,
            permission=data.permission,
            operator=request.auth,
        )
    except CollaboratorError as exc:
        return _collaborator_error_to_response(exc)
    return success_response(result)


@router.delete(
    "/tables/{table_id}/collaborators/{user_id}",
    auth=jwt_auth,
    summary="移除协作者",
)
def remove_collaborator_endpoint(
    request: HttpRequest, table_id: UUID, user_id: str,
):
    try:
        remove_collaborator(
            table_id=table_id,
            user_id=user_id,
            operator=request.auth,
        )
    except CollaboratorError as exc:
        return _collaborator_error_to_response(exc)
    return success_response({"removed": True})
