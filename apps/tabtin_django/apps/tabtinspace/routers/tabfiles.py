"""Tabtin 云盘文件（TabFiles）路由。

#3266：宿主为 Workspace 或 Project。对外保留 ``/spaces/{id}/files/...`` 作为
过渡别名（id-reuse）；正式路径为 ``/workspaces/...`` 与 ``/projects/...``。

#6603：新增 Organization-only 通道 ``/organizations/{organization_id}/files/...``——
云盘裸文件可直挂 Organization，不再强制先有 Space/Workspace/Project。``/spaces/...``
别名已废弃（不再是任何新增能力的推荐入口），但 CLI（``packages/cli-routes``、
``tabtin-cli-go``）与 ``OrganizationResourceTrashPanel`` 仍直接调用，暂保留实现；
待这些调用方迁移到 ``/workspaces`` / ``/projects`` / ``/organizations`` 后再删除。
"""

from .shared import *  # noqa: F401,F403
from pydantic import BaseModel, Field
from typing import Optional

from django.db.models import Q

from apps.tabtinspace.services.tabfiles_service import TabFilesService
from apps.tabtinspace.models import ContextItem

router = Router(tags=["Tabtin Space"])


class FileUploadRequest(BaseModel):
    file_record_id: UUID = Field(..., description="已上传的 OSS FileRecord ID")
    collection_id: Optional[UUID] = Field(default=None, description="目标文件夹 ID")
    title: Optional[str] = Field(default=None, max_length=255, description="显示名称，不传则使用原始文件名")


class FileArchiveFromChatRequest(BaseModel):
    file_record_id: UUID = Field(..., description="聊天中的 FileRecord ID")
    collection_id: Optional[UUID] = Field(default=None, description="目标文件夹 ID")


class FileInviteCollaboratorsRequest(BaseModel):
    user_ids: list[str] = Field(..., description="被邀请用户 ID 列表")
    permission: str = Field(default="viewer", description="viewer / editor / admin")


class FileUpdateCollaboratorRequest(BaseModel):
    permission: str = Field(..., description="viewer / editor / admin")


def _get_tabfiles_item(host_id: UUID, item_id: UUID) -> ContextItem:
    return ContextItem.objects.get(
        Q(workspace_id=host_id) | Q(project_id=host_id),
        id=item_id,
        item_type='tabfiles',
    )


def _upload_file_to_host(request: HttpRequest, host_id: UUID, data: FileUploadRequest):
    service = TabFilesService(user=request.auth)
    try:
        item = service.upload_to_space(
            space_id=host_id,
            file_record_id=data.file_record_id,
            collection_id=data.collection_id,
            title=data.title,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    if not item:
        return permission_denied_response(_("tabtinspace.tabfile_upload_failed"))

    _push_context_item_ws(item, 'resource_created', request.auth)

    from apps.tabtinspace.schemas.context_item import ContextItemOut
    return 201, success_response(
        data=ContextItemOut.from_orm(item).dict(),
        message="文件已添加到云盘",
    )


def _archive_file_to_host(request: HttpRequest, host_id: UUID, data: FileArchiveFromChatRequest):
    service = TabFilesService(user=request.auth)
    try:
        item = service.archive_from_chat(
            space_id=host_id,
            file_record_id=data.file_record_id,
            collection_id=data.collection_id,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    if not item:
        return permission_denied_response(_("tabtinspace.tabfile_archive_failed"))

    _push_context_item_ws(item, 'resource_created', request.auth)

    from apps.tabtinspace.schemas.context_item import ContextItemOut
    return 201, success_response(
        data=ContextItemOut.from_orm(item).dict(),
        message="文件已归档到云盘",
    )


def _get_file_download_url_for_host(
    request: HttpRequest,
    host_id: UUID,
    item_id: UUID,
    preview_max_bytes: Optional[int] = None,
):
    service = TabFilesService(user=request.auth)
    if not service.check_space_permission(str(host_id), 'viewer'):
        return permission_denied_response(_("tabtinspace.permission_denied"))

    try:
        item = _get_tabfiles_item(host_id, item_id)
    except ContextItem.DoesNotExist:
        return not_found_response(_("tabtinspace.tabfile_not_found"))

    from apps.tabtinspace.services.cloud_resource_acl import check_item_resource_permission
    if not check_item_resource_permission(request.auth, item, 'viewer'):
        return permission_denied_response(_("tabtinspace.permission_denied"))

    return _resolve_file_download_response(item, preview_max_bytes)


# 预览：有界正整数；默认上限与客户端 PDF 预览阈值对齐
_PREVIEW_MAX_BYTES_LIMIT = 100 * 1024 * 1024
# 仅这些 MIME 允许内联预览；HTML / 可执行 / 压缩包 / 未知一律下载
_PREVIEW_SAFE_MIME_TYPES = frozenset({
    "application/pdf",
    "application/json",
    "application/ld+json",
    "application/x-ndjson",
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/msword",
    "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/bmp",
    # image/svg+xml 故意不在白名单：SVG 可嵌脚本，仅允许下载
    "audio/mpeg",
    "audio/mp4",
    "audio/wav",
    "audio/x-wav",
    "audio/ogg",
    "video/mp4",
    "video/webm",
    "video/quicktime",
})
_GENERIC_MIME_MARKDOWN_EXTENSIONS = (".md", ".markdown", ".mark")


def _normalize_mime_type(raw: str) -> str:
    mime = (raw or "").split(";", 1)[0].strip().lower()
    return mime


def _is_preview_safe_mime(mime_type: str) -> bool:
    return _normalize_mime_type(mime_type) in _PREVIEW_SAFE_MIME_TYPES


def _resolve_preview_mime_type(stored_mime_type: str, file_name: str) -> str:
    """用安全扩展名补足普通上传遗留的通用 MIME，不覆盖明确类型。"""
    stored_mime = _normalize_mime_type(stored_mime_type)
    if stored_mime and stored_mime != "application/octet-stream":
        return stored_mime

    normalized_name = str(file_name or "").lower()
    if normalized_name.endswith(_GENERIC_MIME_MARKDOWN_EXTENSIONS):
        return "text/markdown"
    return stored_mime


def _validate_preview_max_bytes(preview_max_bytes: Optional[int]):
    """校验 preview_max_bytes；合法返回 (value, None)，非法返回 (None, error_response)。"""
    if preview_max_bytes is None:
        return None, None
    try:
        value = int(preview_max_bytes)
    except (TypeError, ValueError):
        return None, error_response(
            "VALIDATION_ERROR",
            "preview_max_bytes 必须是正整数",
            status_code=400,
        )
    if value <= 0:
        return None, error_response(
            "VALIDATION_ERROR",
            "preview_max_bytes 必须是正整数",
            status_code=400,
        )
    if value > _PREVIEW_MAX_BYTES_LIMIT:
        return None, error_response(
            "VALIDATION_ERROR",
            f"preview_max_bytes 不能超过 {_PREVIEW_MAX_BYTES_LIMIT}",
            status_code=400,
        )
    return value, None


def _resolve_file_download_response(item: ContextItem, preview_max_bytes: Optional[int] = None):
    validated_preview, err = _validate_preview_max_bytes(preview_max_bytes)
    if err is not None:
        return err
    preview_max_bytes = validated_preview

    file_record_id = UUID(item.resource_id)
    file_size = TabFilesService.get_file_size(file_record_id)
    file_name = (item.metadata or {}).get("file_name", item.title)
    mime_type = _normalize_mime_type((item.metadata or {}).get("mime_type", "") or "")
    preview_mime_type = _resolve_preview_mime_type(
        mime_type,
        file_name,
    )
    if file_size is None:
        return error_response('DOWNLOAD_FAILED', '文件不存在或未完成上传', status_code=500)

    mime_preview_safe = _is_preview_safe_mime(preview_mime_type)
    if preview_max_bytes is not None:
        if not mime_preview_safe:
            return success_response(data={
                'url': '',
                'file_name': file_name,
                'mime_type': mime_type,
                'file_size': file_size,
                'preview_eligible': False,
                'mime_preview_safe': False,
            })
        if file_size > preview_max_bytes:
            return success_response(data={
                'url': '',
                'file_name': file_name,
                'mime_type': mime_type,
                'file_size': file_size,
                'preview_eligible': False,
                'mime_preview_safe': True,
            })

    url = TabFilesService.get_download_url(
        file_record_id,
        as_attachment=preview_max_bytes is None,
    )
    if not url:
        return error_response('DOWNLOAD_FAILED', '无法生成下载链接', status_code=500)

    return success_response(data={
        'url': url,
        'file_name': file_name,
        'mime_type': mime_type,
        'file_size': file_size,
        # 下载路径（无 preview_max_bytes）保持旧语义 True；预览路径走到此处即已通过大小/MIME 护栏
        'preview_eligible': True,
        'mime_preview_safe': mime_preview_safe,
    })


# ── Organization-only（：宿主直接是 Organization，不挂 workspace/project）──

def _upload_file_to_organization(request: HttpRequest, organization_id: UUID, data: FileUploadRequest):
    service = TabFilesService(user=request.auth)
    try:
        item = service.upload_to_organization(
            organization_id=organization_id,
            file_record_id=data.file_record_id,
            collection_id=data.collection_id,
            title=data.title,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    if not item:
        return permission_denied_response(_("tabtinspace.tabfile_upload_failed"))

    _push_context_item_ws(item, 'resource_created', request.auth)

    from apps.tabtinspace.schemas.context_item import ContextItemOut
    return 201, success_response(
        data=ContextItemOut.from_orm(item).dict(),
        message="文件已添加到云盘",
    )


def _archive_file_to_organization(request: HttpRequest, organization_id: UUID, data: FileArchiveFromChatRequest):
    service = TabFilesService(user=request.auth)
    try:
        item = service.archive_from_chat_to_organization(
            organization_id=organization_id,
            file_record_id=data.file_record_id,
            collection_id=data.collection_id,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    if not item:
        return permission_denied_response(_("tabtinspace.tabfile_archive_failed"))

    _push_context_item_ws(item, 'resource_created', request.auth)

    from apps.tabtinspace.schemas.context_item import ContextItemOut
    return 201, success_response(
        data=ContextItemOut.from_orm(item).dict(),
        message="文件已归档到云盘",
    )


@router.post("/organizations/{organization_id}/files/upload", auth=jwt_auth, response=RESP_CREATE)
def upload_file_to_organization(request: HttpRequest, organization_id: UUID, data: FileUploadRequest):
    return _upload_file_to_organization(request, organization_id, data)


@router.post("/organizations/{organization_id}/files/from-chat", auth=jwt_auth, response=RESP_CREATE)
def archive_file_from_chat_organization(
    request: HttpRequest, organization_id: UUID, data: FileArchiveFromChatRequest,
):
    return _archive_file_to_organization(request, organization_id, data)


@router.get(
    "/organizations/{organization_id}/files/{item_id}/download-url",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR},
)
def get_organization_file_download_url(
    request: HttpRequest,
    organization_id: UUID,
    item_id: UUID,
    preview_max_bytes: Optional[int] = None,
):
    service = TabFilesService(user=request.auth)
    if not service.check_organization_permission(str(organization_id), 'viewer'):
        return permission_denied_response(_("tabtinspace.permission_denied"))

    try:
        item = ContextItem.objects.get(
            organization_id=organization_id,
            id=item_id,
            item_type='tabfiles',
        )
    except ContextItem.DoesNotExist:
        return not_found_response(_("tabtinspace.tabfile_not_found"))

    # ：下载需资源级 viewer（owner / FilePermission），组织角色不够
    from apps.tabtinspace.services.cloud_resource_acl import check_item_resource_permission
    if not check_item_resource_permission(request.auth, item, 'viewer'):
        return permission_denied_response(_("tabtinspace.permission_denied"))

    return _resolve_file_download_response(item, preview_max_bytes)


@router.post(
    "/organizations/{organization_id}/files/{file_record_id}/trash",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR, **RESP_ERR_400},
    summary="组织级云盘裸文件移入回收站",
)
def trash_organization_file(request: HttpRequest, organization_id: UUID, file_record_id: UUID):
    service = TabFilesService(user=request.auth)
    try:
        item = service.trash_organization_file(organization_id, file_record_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    _push_context_item_ws(item, 'resource_trashed', request.auth)
    return success_response(message=_("tabtinspace.tabfile_trashed"))


@router.post(
    "/organizations/{organization_id}/files/{file_record_id}/restore",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR, **RESP_ERR_400},
    summary="从回收站恢复组织级云盘裸文件",
)
def restore_organization_file(request: HttpRequest, organization_id: UUID, file_record_id: UUID):
    service = TabFilesService(user=request.auth)
    try:
        item = service.restore_organization_file_from_trash(organization_id, file_record_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    _push_context_item_ws(item, 'resource_restored', request.auth)
    from apps.tabtinspace.schemas.context_item import ContextItemOut
    return success_response(
        data=ContextItemOut.from_orm(item).dict(),
        message=_("tabtinspace.tabfile_restored"),
    )


@router.delete(
    "/organizations/{organization_id}/files/{file_record_id}/permanent",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR, **RESP_ERR_400},
    summary="永久删除回收站中的组织级云盘裸文件",
)
def permanent_delete_organization_file(request: HttpRequest, organization_id: UUID, file_record_id: UUID):
    from apps.tabtinspace.services.context_sync_publisher import (
        resolve_cloud_resource_recipient_user_ids,
    )

    service = TabFilesService(user=request.auth)
    # ：永久删除前快照接收人（ContextItem / ACL 删除后无法反查）
    recipients = resolve_cloud_resource_recipient_user_ids(
        'tabfiles',
        str(file_record_id),
        str(organization_id),
    )
    if request.auth and getattr(request.auth, 'id', None):
        recipients.add(str(request.auth.id))
    try:
        service.permanent_delete_organization_file(organization_id, file_record_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    _publish_context_sync(
        space_id=None,
        organization_id=str(organization_id),
        event_type='resource_deleted',
        extra={
            'resource_type': 'tabfiles',
            'resource_id': str(file_record_id),
            'user_id': str(request.auth.id) if request.auth else None,
        },
        recipient_user_ids=recipients,
    )
    return success_response(message=_("tabtinspace.tabfile_permanently_deleted"))


@router.get(
    "/files/shared-with-me",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR},
    summary="列出分享给我的云盘文件",
)
def list_files_shared_with_me_endpoint(request: HttpRequest, organization_id: str = ""):
    from apps.tabtinspace.services.tabfiles_share_service import list_files_shared_with_me

    try:
        files = list_files_shared_with_me(
            viewer=request.auth,
            organization_id=(organization_id or None),
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response({"files": files, "total": len(files)})


@router.get(
    "/files/{file_record_id}/collaborators",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR},
    summary="列出云盘文件协作者",
)
def list_file_collaborators_endpoint(request: HttpRequest, file_record_id: UUID):
    from apps.tabtinspace.services.tabfiles_share_service import list_file_collaborators

    try:
        result = list_file_collaborators(file_record_id, request.auth)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response(result)


@router.post(
    "/files/{file_record_id}/collaborators",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR, **RESP_ERR_400},
    summary="邀请云盘文件协作者",
)
def invite_file_collaborators_endpoint(
    request: HttpRequest,
    file_record_id: UUID,
    data: FileInviteCollaboratorsRequest,
):
    from apps.tabtinspace.services.tabfiles_share_service import invite_file_collaborators

    try:
        result = invite_file_collaborators(
            file_record_id=file_record_id,
            user_ids=data.user_ids,
            permission=data.permission,
            inviter=request.auth,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response(result)


@router.patch(
    "/files/{file_record_id}/collaborators/{user_id}",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR, **RESP_ERR_400},
    summary="更新云盘文件协作者权限",
)
def update_file_collaborator_endpoint(
    request: HttpRequest,
    file_record_id: UUID,
    user_id: str,
    data: FileUpdateCollaboratorRequest,
):
    from apps.tabtinspace.services.tabfiles_share_service import (
        update_file_collaborator_permission,
    )

    try:
        result = update_file_collaborator_permission(
            file_record_id=file_record_id,
            user_id=user_id,
            permission=data.permission,
            actor=request.auth,
        )
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response(result)


@router.delete(
    "/files/{file_record_id}/collaborators/{user_id}",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR, **RESP_ERR_400},
    summary="撤销云盘文件协作者",
)
def revoke_file_collaborator_endpoint(
    request: HttpRequest,
    file_record_id: UUID,
    user_id: str,
):
    from apps.tabtinspace.services.tabfiles_share_service import revoke_file_collaborator

    try:
        revoke_file_collaborator(file_record_id, user_id, request.auth)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)
    return success_response(message="已撤销协作者")


# ── Workspace / Project 正式路径 ─────────────────────────────────────────────

@router.post("/workspaces/{workspace_id}/files/upload", auth=jwt_auth, response=RESP_CREATE)
def upload_file_to_workspace(request: HttpRequest, workspace_id: UUID, data: FileUploadRequest):
    return _upload_file_to_host(request, workspace_id, data)


@router.post("/workspaces/{workspace_id}/files/from-chat", auth=jwt_auth, response=RESP_CREATE)
def archive_file_from_chat_workspace(request: HttpRequest, workspace_id: UUID, data: FileArchiveFromChatRequest):
    return _archive_file_to_host(request, workspace_id, data)


@router.get(
    "/workspaces/{workspace_id}/files/{item_id}/download-url",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR},
)
def get_workspace_file_download_url(
    request: HttpRequest,
    workspace_id: UUID,
    item_id: UUID,
    preview_max_bytes: Optional[int] = None,
):
    return _get_file_download_url_for_host(request, workspace_id, item_id, preview_max_bytes)


@router.post("/projects/{project_id}/files/upload", auth=jwt_auth, response=RESP_CREATE)
def upload_file_to_project(request: HttpRequest, project_id: UUID, data: FileUploadRequest):
    return _upload_file_to_host(request, project_id, data)


@router.post("/projects/{project_id}/files/from-chat", auth=jwt_auth, response=RESP_CREATE)
def archive_file_from_chat_project(request: HttpRequest, project_id: UUID, data: FileArchiveFromChatRequest):
    return _archive_file_to_host(request, project_id, data)


@router.get(
    "/projects/{project_id}/files/{item_id}/download-url",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR},
)
def get_project_file_download_url(
    request: HttpRequest,
    project_id: UUID,
    item_id: UUID,
    preview_max_bytes: Optional[int] = None,
):
    return _get_file_download_url_for_host(request, project_id, item_id, preview_max_bytes)


def _trash_file_for_host(request: HttpRequest, host_id: UUID, file_record_id: UUID):
    service = TabFilesService(user=request.auth)
    try:
        item = service.trash_file(host_id, file_record_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    _push_context_item_ws(item, 'resource_trashed', request.auth)
    return success_response(message=_("tabtinspace.tabfile_trashed"))


def _restore_file_for_host(request: HttpRequest, host_id: UUID, file_record_id: UUID):
    service = TabFilesService(user=request.auth)
    try:
        item = service.restore_file_from_trash(host_id, file_record_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    _push_context_item_ws(item, 'resource_restored', request.auth)
    from apps.tabtinspace.schemas.context_item import ContextItemOut
    return success_response(
        data=ContextItemOut.from_orm(item).dict(),
        message=_("tabtinspace.tabfile_restored"),
    )


def _permanent_delete_file_for_host(request: HttpRequest, host_id: UUID, file_record_id: UUID):
    from apps.services.billing.organization_resolver import resolve_organization_id_from_space
    from apps.tabtinspace.services.context_sync_publisher import (
        resolve_cloud_resource_recipient_user_ids,
    )

    service = TabFilesService(user=request.auth)
    org_id = resolve_organization_id_from_space(str(host_id))
    recipients = resolve_cloud_resource_recipient_user_ids(
        'tabfiles',
        str(file_record_id),
        str(org_id) if org_id else None,
    )
    if request.auth and getattr(request.auth, 'id', None):
        recipients.add(str(request.auth.id))
    try:
        service.permanent_delete_file(host_id, file_record_id)
    except ServiceError as e:
        return error_response(e.code, e.message, status_code=e.status)

    _publish_context_sync(
        space_id=host_id,
        event_type='resource_deleted',
        extra={
            'resource_type': 'tabfiles',
            'resource_id': str(file_record_id),
            'user_id': str(request.auth.id) if request.auth else None,
        },
        recipient_user_ids=recipients,
    )
    return success_response(message=_("tabtinspace.tabfile_permanently_deleted"))


# ── Workspace / Project 回收站（补齐与 upload/download-url 对等的正式路径，
#    与下方 /spaces/... 别名功能一致；有了这组正式路径后 /spaces/... 三个回收站
#    别名才具备被彻底删除的前提）─────────────────────────────────────────────

@router.post(
    "/workspaces/{workspace_id}/files/{file_record_id}/trash",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR, **RESP_ERR_400},
    summary="云盘裸文件移入回收站",
)
def trash_workspace_file(request: HttpRequest, workspace_id: UUID, file_record_id: UUID):
    return _trash_file_for_host(request, workspace_id, file_record_id)


@router.post(
    "/workspaces/{workspace_id}/files/{file_record_id}/restore-from-trash",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR, **RESP_ERR_400},
    summary="从回收站恢复云盘裸文件",
)
def restore_workspace_file_from_trash(request: HttpRequest, workspace_id: UUID, file_record_id: UUID):
    return _restore_file_for_host(request, workspace_id, file_record_id)


@router.delete(
    "/workspaces/{workspace_id}/files/{file_record_id}/permanent",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR, **RESP_ERR_400},
    summary="永久删除回收站中的云盘裸文件",
)
def permanent_delete_workspace_file(request: HttpRequest, workspace_id: UUID, file_record_id: UUID):
    return _permanent_delete_file_for_host(request, workspace_id, file_record_id)


@router.post(
    "/projects/{project_id}/files/{file_record_id}/trash",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR, **RESP_ERR_400},
    summary="云盘裸文件移入回收站",
)
def trash_project_file(request: HttpRequest, project_id: UUID, file_record_id: UUID):
    return _trash_file_for_host(request, project_id, file_record_id)


@router.post(
    "/projects/{project_id}/files/{file_record_id}/restore-from-trash",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR, **RESP_ERR_400},
    summary="从回收站恢复云盘裸文件",
)
def restore_project_file_from_trash(request: HttpRequest, project_id: UUID, file_record_id: UUID):
    return _restore_file_for_host(request, project_id, file_record_id)


@router.delete(
    "/projects/{project_id}/files/{file_record_id}/permanent",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR, **RESP_ERR_400},
    summary="永久删除回收站中的云盘裸文件",
)
def permanent_delete_project_file(request: HttpRequest, project_id: UUID, file_record_id: UUID):
    return _permanent_delete_file_for_host(request, project_id, file_record_id)


# ── /spaces/... 过渡别名（已废弃，：不要在新代码里引用）────────────────
#
# 保留原因：CLI（packages/cli-routes/src/routes/drive.ts、
# packages/tabtin-cli-go/cmd/apps_drive_remote.go）与 Electron
# OrganizationResourceTrashPanel 仍直接拼接这组 URL；上方已补齐
# workspaces/projects 的回收站三件套（trash/restore-from-trash/permanent），
# 具备了迁移前提。待这些调用方切换完成后可整块删除本节。

@router.post("/spaces/{space_id}/files/upload", auth=jwt_auth, response=RESP_CREATE)
def upload_file_to_space(request: HttpRequest, space_id: UUID, data: FileUploadRequest):
    """@deprecated  请改用 /workspaces or /projects 对应正式路径。"""
    return _upload_file_to_host(request, space_id, data)


@router.post("/spaces/{space_id}/files/from-chat", auth=jwt_auth, response=RESP_CREATE)
def archive_file_from_chat(request: HttpRequest, space_id: UUID, data: FileArchiveFromChatRequest):
    """@deprecated  请改用 /workspaces or /projects 对应正式路径。"""
    return _archive_file_to_host(request, space_id, data)


@router.get("/spaces/{space_id}/files/{item_id}/download-url", auth=jwt_auth, response={200: dict, **RESP_ERR})
def get_file_download_url(
    request: HttpRequest,
    space_id: UUID,
    item_id: UUID,
    preview_max_bytes: Optional[int] = None,
):
    """@deprecated  请改用 /workspaces or /projects 对应正式路径。"""
    return _get_file_download_url_for_host(request, space_id, item_id, preview_max_bytes)


@router.post(
    "/spaces/{space_id}/files/{file_record_id}/trash",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR, **RESP_ERR_400},
    summary="云盘裸文件移入回收站（deprecated，见 /workspaces or /projects）",
)
def trash_file(request: HttpRequest, space_id: UUID, file_record_id: UUID):
    """@deprecated  请改用 /workspaces or /projects 对应正式路径。"""
    return _trash_file_for_host(request, space_id, file_record_id)


@router.post(
    "/spaces/{space_id}/files/{file_record_id}/restore-from-trash",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR, **RESP_ERR_400},
    summary="从回收站恢复云盘裸文件（deprecated，见 /workspaces or /projects）",
)
def restore_file_from_trash(request: HttpRequest, space_id: UUID, file_record_id: UUID):
    """@deprecated  请改用 /workspaces or /projects 对应正式路径。"""
    return _restore_file_for_host(request, space_id, file_record_id)


@router.delete(
    "/spaces/{space_id}/files/{file_record_id}/permanent",
    auth=jwt_auth,
    response={200: dict, **RESP_ERR, **RESP_ERR_400},
    summary="永久删除回收站中的云盘裸文件（deprecated，见 /workspaces or /projects）",
)
def permanent_delete_file(request: HttpRequest, space_id: UUID, file_record_id: UUID):
    """@deprecated  请改用 /workspaces or /projects 对应正式路径。"""
    return _permanent_delete_file_for_host(request, space_id, file_record_id)


__all__ = ["router"]
