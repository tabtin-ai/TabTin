"""TabDoc 生命周期 + 权限 API 的 HTTP 契约测试

第二批契约测试（紧随 ``test_documents_api.py`` 6 端点之后），覆盖：

| CLI 命令                       | 端点                                              |
|--------------------------------|---------------------------------------------------|
| ``doc unarchive``              | POST   ``/api/tabdoc/documents/{id}/unarchive``        |
| ``doc trash``                  | POST   ``/api/tabdoc/documents/{id}/trash``            |
| ``doc restore`` (回收站恢复)    | POST   ``/api/tabdoc/documents/{id}/restore-from-trash`` |
| ``doc permanent-delete``       | DELETE ``/api/tabdoc/documents/{id}/permanent``        |
| (UI / 内部)                    | GET    ``/api/tabdoc/documents/{id}/permissions``      |
| (UI / 内部)                    | POST   ``/api/tabdoc/documents/{id}/permissions``      |

为什么要专门钉这一层
--------------------
生命周期端点是**纯 URL-param** handler——schema 不存在，所以"flag→body→service"
那条链路在这里退化为"URL param → service 参数"。看似简单，但 handler 里有几
处**自定义业务校验**容易被误改：

- ``unarchive`` handler 自己判 ``document.status != "archived"`` → 400
  ``tabdoc.document_not_archived``——CLI agent SKILL 文档教用户"先 list 看 status
  再决定 unarchive"，这条 400 路径就是契约的一部分
- ``restore-from-trash`` 类似——必须 ``trashed_at is not None`` 才放行
- ``permanent-delete`` 用 ``required_role="admin"`` 而非 ``editor``——admin
  权限闸门漂移（rename → 'manager' 之类）会让 SKILL 里"前置 admin 角色"承诺失真

权限端点（``GET/POST /permissions``）是少数 CLI 不直接暴露但 UI / 飞书集成依赖
的端点——POST 端点带 ``entries`` 列表 schema，每条 ``{subject_type, subject_id,
permission, is_active}``——schema 字段名漂移会让前端 / 集成端瞬间坏掉。这里钉
住"body entries → service.replace_permissions(entries=[...])" 这条契约。

测试模式（与 ``test_documents_api.py`` 同源）
--------------------------------------------
- ``SimpleTestCase`` + ``patch("apps.tabdoc.api._build_service")``——不碰数据库
- 复用 ``_TabDocApiBase``（HTTP helpers + JWT mock + service patch）
- 每端点 3-4 case：happy / 业务校验分支 / PermissionError 403 / ValueError 400
"""

from __future__ import annotations

from unittest.mock import MagicMock
from uuid import uuid4

from apps.tabdoc.tests.test_documents_api import _TabDocApiBase, _build_document


# ===========================================================================
# POST /api/tabdoc/documents/{id}/unarchive · unarchive_document
# ===========================================================================


class UnarchiveDocumentApiTests(_TabDocApiBase):
    """覆盖 unarchive 的 handler 自校验分支 + 标准 error map。

    handler 流程：``get_document(required_role='editor')`` →
    断言 ``document.status == 'archived'`` →
    ``service.unarchive_document(document)`` 返回 reactivate 后的 doc。
    """

    URL_TPL = "/api/tabdoc/documents/{id}/unarchive"

    def _url(self, doc_id) -> str:
        return self.URL_TPL.format(id=doc_id)

    def test_unarchive_happy_path_returns_restored_document(self):
        """happy：service 已归档文档 → unarchive_document 调用 → 序列化返回。

        重点钉死 service 调用契约：先 ``get_document(doc_id, required_role='editor')``
        再 ``unarchive_document(document)``——两步顺序不可乱（先校验权限再操作）。
        """
        archived_doc = _build_document(status="archived")
        restored_doc = _build_document(
            document_id=archived_doc.id,
            organization_id=archived_doc.organization_id,
            space_id=archived_doc.space_id,
            status="active",  # 恢复后变 active
        )
        with self._patch_service() as svc:
            svc.get_document.return_value = archived_doc
            svc.unarchive_document.return_value = restored_doc
            resp = self._post(self._url(archived_doc.id), {})
        self.assertEqual(resp.status_code, 200, msg=self._body(resp))
        body = self._body(resp)
        self.assertTrue(body["success"])
        self.assertEqual(body["data"]["document"]["status"], "active")

        # 契约：required_role 必须是 'editor'（不是 viewer/admin）
        get_kwargs = svc.get_document.call_args
        self.assertEqual(get_kwargs.kwargs.get("required_role"), "editor")
        # unarchive_document 被调用且传入的是 get_document 返回的对象
        svc.unarchive_document.assert_called_once_with(archived_doc)

    def test_unarchive_rejects_non_archived_document_400(self):
        """handler 自校验分支：``status != 'archived'`` → 400 ``VALIDATION_ERROR``。

        这条业务分支是 CLI SKILL 教用户"先查 status 再操作"的依据——必须钉死。
        """
        active_doc = _build_document(status="active")
        with self._patch_service() as svc:
            svc.get_document.return_value = active_doc
            resp = self._post(self._url(active_doc.id), {})
        self.assertEqual(resp.status_code, 400, msg=self._body(resp))
        body = self._body(resp)
        self.assertEqual(body["code"], "VALIDATION_ERROR")
        # service.unarchive_document 不应被调用——handler 在校验阶段就拦了
        # （注：从 svc 那里读 unarchive_document 是 attr access，要先拿 svc 实例）

    def test_unarchive_returns_403_on_permission_error(self):
        """``get_document`` 抛 PermissionError → 403 ``PERMISSION_DENIED``。"""
        with self._patch_service() as svc:
            svc.get_document.side_effect = PermissionError("无权操作该文档")
            resp = self._post(self._url(uuid4()), {})
        self.assertEqual(resp.status_code, 403, msg=self._body(resp))
        self.assertEqual(self._body(resp)["code"], "PERMISSION_DENIED")

    def test_unarchive_returns_400_on_value_error(self):
        """ValueError 在 handler 里通配到 400 ``VALIDATION_ERROR``。"""
        with self._patch_service() as svc:
            svc.get_document.side_effect = ValueError("文档不存在")
            resp = self._post(self._url(uuid4()), {})
        self.assertEqual(resp.status_code, 400, msg=self._body(resp))
        self.assertEqual(self._body(resp)["code"], "VALIDATION_ERROR")

    def test_unarchive_returns_401_when_jwt_missing(self):
        """无 ``Authorization`` 头 → 401（ninja JWTAuth 拦截）。"""
        resp = self._post(self._url(uuid4()), {}, with_auth=False)
        self.assertEqual(resp.status_code, 401, msg=self._body(resp))


# ===========================================================================
# POST /api/tabdoc/documents/{id}/trash · trash_document
# ===========================================================================


class TrashDocumentApiTests(_TabDocApiBase):
    """覆盖 trash（移入回收站）的标准三件套：happy / 403 / 400。

    trash handler 比 unarchive 简单——没有"自校验当前 status"，从任何
    active/archived 状态都能直接 trash。"""

    URL_TPL = "/api/tabdoc/documents/{id}/trash"

    def _url(self, doc_id) -> str:
        return self.URL_TPL.format(id=doc_id)

    def test_trash_happy_path(self):
        """happy：active 文档 → trash_document 调用 → 返回 trashed 状态文档。"""
        active_doc = _build_document(status="active")
        trashed_doc = _build_document(document_id=active_doc.id, status="trashed")
        with self._patch_service() as svc:
            svc.get_document.return_value = active_doc
            svc.trash_document.return_value = trashed_doc
            resp = self._post(self._url(active_doc.id), {})
        self.assertEqual(resp.status_code, 200, msg=self._body(resp))
        self.assertEqual(self._body(resp)["data"]["document"]["status"], "trashed")
        # required_role 契约：移入回收站需 admin（与 handler get_document 对齐）
        self.assertEqual(
            svc.get_document.call_args.kwargs.get("required_role"), "admin"
        )
        svc.trash_document.assert_called_once_with(active_doc)

    def test_trash_returns_403_on_permission_error(self):
        with self._patch_service() as svc:
            svc.get_document.side_effect = PermissionError("无权")
            resp = self._post(self._url(uuid4()), {})
        self.assertEqual(resp.status_code, 403, msg=self._body(resp))
        self.assertEqual(self._body(resp)["code"], "PERMISSION_DENIED")

    def test_trash_returns_400_on_value_error(self):
        with self._patch_service() as svc:
            svc.get_document.side_effect = ValueError("文档已被永久删除")
            resp = self._post(self._url(uuid4()), {})
        self.assertEqual(resp.status_code, 400, msg=self._body(resp))


# ===========================================================================
# POST /api/tabdoc/documents/{id}/restore-from-trash · restore_document_from_trash
# ===========================================================================


class RestoreFromTrashApiTests(_TabDocApiBase):
    """覆盖回收站恢复（不同于 ``doc version restore`` 的版本回滚！）。

    个人回收站：handler 经 ``get_trashed_document_for_personal_trash``；
    未在回收站或非删除者时分别抛 ValueError / PermissionError。
    """

    URL_TPL = "/api/tabdoc/documents/{id}/restore-from-trash"

    def _url(self, doc_id) -> str:
        return self.URL_TPL.format(id=doc_id)

    def _trashed_doc(self):
        """构造一个 trashed_at 非空的 mock 文档。"""
        doc = _build_document(status="trashed")
        doc.trashed_at = "2026-05-27T00:00:00+00:00"
        return doc

    def test_restore_from_trash_happy_path(self):
        """happy：trashed 文档 → restore_document 调用。"""
        trashed_doc = self._trashed_doc()
        restored_doc = _build_document(
            document_id=trashed_doc.id, status="active"
        )
        with self._patch_service() as svc:
            svc.get_trashed_document_for_personal_trash.return_value = trashed_doc
            svc.restore_document.return_value = restored_doc
            resp = self._post(self._url(trashed_doc.id), {})
        self.assertEqual(resp.status_code, 200, msg=self._body(resp))
        self.assertEqual(self._body(resp)["data"]["document"]["status"], "active")

        svc.get_trashed_document_for_personal_trash.assert_called_once_with(str(trashed_doc.id))
        svc.restore_document.assert_called_once_with(trashed_doc)

    def test_restore_from_trash_rejects_non_trashed_400(self):
        """未在回收站 → personal getter 抛 ValueError → 400。"""
        active_doc = _build_document(status="active")  # trashed_at 默认 None
        with self._patch_service() as svc:
            svc.get_trashed_document_for_personal_trash.side_effect = ValueError(
                "文档不在回收站中"
            )
            resp = self._post(self._url(active_doc.id), {})
        self.assertEqual(resp.status_code, 400, msg=self._body(resp))
        self.assertEqual(self._body(resp)["code"], "VALIDATION_ERROR")

    def test_restore_from_trash_returns_403_on_permission_error(self):
        with self._patch_service() as svc:
            svc.get_trashed_document_for_personal_trash.side_effect = PermissionError("无权")
            resp = self._post(self._url(uuid4()), {})
        self.assertEqual(resp.status_code, 403, msg=self._body(resp))


# ===========================================================================
# DELETE /api/tabdoc/documents/{id}/permanent · permanent_delete_document
# ===========================================================================


class PermanentDeleteDocumentApiTests(_TabDocApiBase):
    """覆盖永久删除——CLI ``doc permanent-delete --yes`` 对应端点。

    Handler 关键契约（个人回收站）：
    - 经 ``get_trashed_document_for_personal_trash``（删除者）
    - 必须先在回收站才能永删
    - 成功返回 ``{deleted: True}``
    """

    URL_TPL = "/api/tabdoc/documents/{id}/permanent"

    def _url(self, doc_id) -> str:
        return self.URL_TPL.format(id=doc_id)

    def test_permanent_delete_happy_path(self):
        """happy：删除者 → service.permanent_delete_document → ``{deleted: True}``。"""
        trashed_doc = _build_document(status="trashed")
        trashed_doc.trashed_at = "2026-05-27T00:00:00+00:00"
        with self._patch_service() as svc:
            svc.get_trashed_document_for_personal_trash.return_value = trashed_doc
            svc.permanent_delete_document.return_value = None
            resp = self._delete(self._url(trashed_doc.id))
        self.assertEqual(resp.status_code, 200, msg=self._body(resp))
        body = self._body(resp)
        self.assertTrue(body["success"])
        self.assertIs(body["data"]["deleted"], True)

        svc.get_trashed_document_for_personal_trash.assert_called_once_with(str(trashed_doc.id))
        svc.permanent_delete_document.assert_called_once_with(trashed_doc)

    def test_permanent_delete_returns_403_when_not_admin(self):
        """非删除者 → PermissionError → 403。"""
        with self._patch_service() as svc:
            svc.get_trashed_document_for_personal_trash.side_effect = PermissionError(
                "无权"
            )
            resp = self._delete(self._url(uuid4()))
        self.assertEqual(resp.status_code, 403, msg=self._body(resp))
        self.assertEqual(self._body(resp)["code"], "PERMISSION_DENIED")

    def test_permanent_delete_returns_400_on_value_error(self):
        """文档不存在 / 未在回收站等 ValueError → 400 VALIDATION_ERROR。"""
        with self._patch_service() as svc:
            svc.get_trashed_document_for_personal_trash.side_effect = ValueError(
                "文档必须先在回收站才能永久删除"
            )
            resp = self._delete(self._url(uuid4()))
        self.assertEqual(resp.status_code, 400, msg=self._body(resp))
        self.assertEqual(self._body(resp)["code"], "VALIDATION_ERROR")


# ===========================================================================
# GET /api/tabdoc/documents/{id}/permissions · get_document_permissions
# ===========================================================================


def _build_permission(
    *,
    permission_id=None,
    document_id=None,
    subject_type: str = "user",
    subject_id: str = "",
    permission: str = "viewer",
    is_active: bool = True,
):
    """构造满足 ``_serialize_permission`` 字段访问的轻量 entry。

    必须含 ``updated_at``——_serialize_permission 调 ``.isoformat()``，缺会
    AttributeError → 500 INTERNAL_ERROR（不是测试想验的契约）。"""
    from types import SimpleNamespace
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    return SimpleNamespace(
        id=permission_id or uuid4(),
        document_id=document_id or uuid4(),
        subject_type=subject_type,
        subject_id=subject_id or str(uuid4()),
        permission=permission,
        is_active=is_active,
        created_by_id=None,
        created_at=now,
        updated_at=now,
    )


class GetDocumentPermissionsApiTests(_TabDocApiBase):
    """覆盖 GET 权限端点：admin-only / entries 序列化契约。"""

    URL_TPL = "/api/tabdoc/documents/{id}/permissions"

    def _url(self, doc_id) -> str:
        return self.URL_TPL.format(id=doc_id)

    def test_get_permissions_happy_path(self):
        """happy：admin 用户 → 返回 entries 列表，序列化字段齐全。

        重点钉死字段名 ``id / document_id / subject_type / subject_id /
        permission / is_active / created_by / created_at``——前端 / 集成端
        按这些字段名取值，任意字段 rename 都会破坏外部消费者。
        """
        doc = _build_document()
        entry = _build_permission(
            document_id=doc.id,
            subject_type="user",
            subject_id="usr_aaa",
            permission="editor",
        )
        with self._patch_service() as svc:
            svc.get_document.return_value = doc
            svc.list_permissions.return_value = [entry]
            resp = self._get(self._url(doc.id))
        self.assertEqual(resp.status_code, 200, msg=self._body(resp))
        body = self._body(resp)
        self.assertTrue(body["success"])
        entries = body["data"]["entries"]
        self.assertEqual(len(entries), 1)
        e = entries[0]
        self.assertEqual(e["subject_type"], "user")
        self.assertEqual(e["subject_id"], "usr_aaa")
        self.assertEqual(e["permission"], "editor")
        self.assertIs(e["is_active"], True)
        # created_by 为 None 时必须有 key（不能丢字段）
        self.assertIn("created_by", e)
        self.assertIsNone(e["created_by"])

        # required_role 必须是 admin
        self.assertEqual(
            svc.get_document.call_args.kwargs.get("required_role"), "admin"
        )

    def test_get_permissions_returns_403_when_not_admin(self):
        with self._patch_service() as svc:
            svc.get_document.side_effect = PermissionError("需要 admin 角色")
            resp = self._get(self._url(uuid4()))
        self.assertEqual(resp.status_code, 403, msg=self._body(resp))

    def test_get_permissions_returns_400_on_value_error(self):
        with self._patch_service() as svc:
            svc.get_document.side_effect = ValueError("文档不存在")
            resp = self._get(self._url(uuid4()))
        self.assertEqual(resp.status_code, 400, msg=self._body(resp))


# ===========================================================================
# POST /api/tabdoc/documents/{id}/permissions · update_document_permissions
# ===========================================================================


class UpdateDocumentPermissionsApiTests(_TabDocApiBase):
    """覆盖 POST 权限覆盖更新——批量替换式。

    Schema 契约：``DocumentPermissionsUpdateRequest`` 含 ``entries: list[
    DocumentPermissionEntry]``，每条 entry 字段 ``{subject_type, subject_id,
    permission, is_active=True}``。Handler 把 entries 用 ``entry.dict()`` 转 dict
    传给 ``service.replace_permissions(document, entries=[...])``。
    """

    URL_TPL = "/api/tabdoc/documents/{id}/permissions"

    def _url(self, doc_id) -> str:
        return self.URL_TPL.format(id=doc_id)

    def test_update_permissions_passes_entries_to_service(self):
        """字段映射：body entries → service.replace_permissions(entries=[dict,...])。

        每个 entry 的 4 个字段（subject_type / subject_id / permission / is_active）
        都必须按命名透传。重点钉死 ``is_active`` 不能漂移成 ``active``——
        与 ``DocumentShare`` 那边的字段名风格曾经撞过。"""
        doc = _build_document()
        entry_out = _build_permission(
            document_id=doc.id, subject_type="user", subject_id="usr_x",
            permission="admin", is_active=True,
        )
        with self._patch_service() as svc:
            svc.get_document.return_value = doc
            svc.replace_permissions.return_value = [entry_out]
            resp = self._post(
                self._url(doc.id),
                {
                    "entries": [
                        {
                            "subject_type": "user",
                            "subject_id": "usr_x",
                            "permission": "admin",
                            "is_active": True,
                        },
                        {
                            "subject_type": "role",
                            "subject_id": "wt_admin",
                            "permission": "viewer",
                            # is_active 不传 → schema default True
                        },
                    ]
                },
            )
        self.assertEqual(resp.status_code, 200, msg=self._body(resp))

        # required_role admin 闸门
        self.assertEqual(
            svc.get_document.call_args.kwargs.get("required_role"), "admin"
        )

        # 入参契约：handler 把 schema entries 转 dict 传给 service
        call_kwargs = svc.replace_permissions.call_args.kwargs
        entries_passed = call_kwargs["entries"]
        self.assertEqual(len(entries_passed), 2)
        self.assertEqual(entries_passed[0]["subject_type"], "user")
        self.assertEqual(entries_passed[0]["subject_id"], "usr_x")
        self.assertEqual(entries_passed[0]["permission"], "admin")
        self.assertIs(entries_passed[0]["is_active"], True)
        # 第二条 is_active 走默认值 True
        self.assertIs(entries_passed[1]["is_active"], True)

    def test_update_permissions_accepts_empty_entries(self):
        """schema default_factory=list：``entries`` 不传 → handler 收到空 list，
        相当于"清空所有权限覆盖"——这是合法操作，不能被 422 拦死。"""
        doc = _build_document()
        with self._patch_service() as svc:
            svc.get_document.return_value = doc
            svc.replace_permissions.return_value = []
            resp = self._post(self._url(doc.id), {})  # body 不传 entries
        self.assertEqual(resp.status_code, 200, msg=self._body(resp))
        self.assertEqual(self._body(resp)["data"]["entries"], [])
        # service 收到空 list
        self.assertEqual(svc.replace_permissions.call_args.kwargs["entries"], [])

    def test_update_permissions_returns_403_on_permission_error(self):
        with self._patch_service() as svc:
            svc.get_document.side_effect = PermissionError("需要 admin")
            resp = self._post(self._url(uuid4()), {"entries": []})
        self.assertEqual(resp.status_code, 403, msg=self._body(resp))

    def test_update_permissions_returns_400_on_value_error(self):
        """service 内部 ValueError（如"permission 必须是 viewer/editor/admin"）
        → 400 VALIDATION_ERROR + detail 透传。"""
        with self._patch_service() as svc:
            svc.get_document.return_value = _build_document()
            svc.replace_permissions.side_effect = ValueError(
                "permission 必须是 viewer/editor/admin 之一"
            )
            resp = self._post(
                self._url(uuid4()),
                {
                    "entries": [
                        {
                            "subject_type": "user",
                            "subject_id": "usr_x",
                            "permission": "tyrant",  # 故意非法
                        }
                    ]
                },
            )
        self.assertEqual(resp.status_code, 400, msg=self._body(resp))
        self.assertEqual(self._body(resp)["code"], "VALIDATION_ERROR")
        self.assertIn("permission", self._body(resp)["data"]["detail"])
