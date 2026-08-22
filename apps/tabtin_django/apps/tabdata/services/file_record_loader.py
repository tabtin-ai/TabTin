"""tabdata.Attachment* ↔ oss attach helper。

单库治理（M3b）后：
- ``AttachmentUpload.file_record`` / ``AttachmentUpload.upload_task`` 已恢复为同库物理 FK，
  其 attach helper 改为填 FK 关系缓存（等价 select_related，避免列表 N+1）。
- ``AttachmentReference.file`` 仍是跨生命周期软引用（删 FileRecord 走 soft_delete 保留
  审计行 + dangling ref，物理 FK 的 on_delete 表达不了），保持 make_softref_property。
"""

from __future__ import annotations

from typing import Iterable

from apps.services.common.cross_db_softref import make_attach_helper


__all__ = [
    "attach_file_records_to_attachment_references",
    "attach_file_records_to_attachment_uploads",
    "attach_upload_tasks_to_attachment_uploads",
]


# AttachmentReference.file 仍是软引用（soft_delete 语义无法用 FK 表达）——保持原 helper。
attach_file_records_to_attachment_references = make_attach_helper(
    target_model="oss.FileRecord",
    cache_attr="_cached_file",
    id_attr="file_id",
    name="attach_file_records_to_attachment_references",
)


def _prime_fk(instances: list, fk_field: str, target_model: str) -> None:
    """批量 fetch target 并填 FK 关系缓存（FK 已是物理外键，等价 select_related）。"""
    if not instances:
        return
    from django.apps import apps as _apps

    app_label, model_name = target_model.split(".", 1)
    Target = _apps.get_model(app_label, model_name)
    field = instances[0]._meta.get_field(fk_field)
    id_attr = f"{fk_field}_id"
    wanted = {str(getattr(o, id_attr)) for o in instances if getattr(o, id_attr, None)}
    targets = {str(t.id): t for t in Target.objects.filter(id__in=wanted)} if wanted else {}
    for o in instances:
        raw = getattr(o, id_attr, None)
        field.set_cached_value(o, targets.get(str(raw)) if raw else None)


def attach_file_records_to_attachment_uploads(uploads: Iterable) -> None:
    """批量预填 ``AttachmentUpload.file_record`` FK 缓存。"""
    _prime_fk(list(uploads), "file_record", "oss.FileRecord")


def attach_upload_tasks_to_attachment_uploads(uploads: Iterable) -> None:
    """批量预填 ``AttachmentUpload.upload_task`` FK 缓存。"""
    _prime_fk(list(uploads), "upload_task", "oss.UploadTask")
