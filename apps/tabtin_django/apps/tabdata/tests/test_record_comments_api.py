"""记录详情内部评论 API 的垂直切片测试。"""

from __future__ import annotations

import json
import uuid
from datetime import timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import Client, TestCase
from django.utils import timezone

from apps.agent.models import Agent
from apps.services.common.thread_context import set_current_execution_agent_id
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.exceptions import RLSAccessDenied
from apps.tabdata.models import (
    RecordComment,
    Table,
    TablePermission,
    TableRecord,
    TableShare,
    TableView,
)
from apps.tabdata.native.ddl_manager import DDLManager
from apps.tabdata.native.record_io import NativeRecordIO
from apps.tabdata.services.comment_service import RecordCommentService
from apps.tabdata.services.record_service import RecordService
from apps.tabdata.services.rls_service import RLSContext
from apps.tabtinspace.models import Organization, OrganizationMember
from apps.users.auth.models import UserSession
from apps.users.auth.session_manager import SessionManager
from apps.users.auth.utils import generate_jwt_token

User = get_user_model()


def _jwt_headers(user) -> dict[str, str]:
    raw_key = f"record_comment_{uuid.uuid4().hex}"
    UserSession.objects.create(
        session_key=SessionManager.hash_session_key(raw_key),
        user=user,
        session_type="web",
        ip_address="127.0.0.1",
        user_agent="record-comment-test",
        expires_at=timezone.now() + timedelta(hours=2),
    )
    token = generate_jwt_token(
        user,
        expire_hours=1,
        token_type="access",
        session_key=raw_key,
    )
    return {"HTTP_AUTHORIZATION": f"Bearer {token}"}


class RecordCommentAPITests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self) -> None:
        self.client = Client()
        invite_gate_patcher = patch(
            "apps.users.auth.invite_gate_middleware.is_invite_gate_enabled",
            return_value=False,
        )
        invite_gate_patcher.start()
        self.addCleanup(invite_gate_patcher.stop)
        suffix = uuid.uuid4().hex[:8]
        self.owner = User.objects.create_user(
            username=f"comment_owner_{suffix}",
            email=f"comment_owner_{suffix}@example.com",
            password="x",
        )
        self.viewer = User.objects.create_user(
            username=f"comment_viewer_{suffix}",
            email=f"comment_viewer_{suffix}@example.com",
            password="x",
        )
        self.other_viewer = User.objects.create_user(
            username=f"comment_other_{suffix}",
            email=f"comment_other_{suffix}@example.com",
            password="x",
        )
        self.mentioned_user = User.objects.create_user(
            username=f"comment_mentioned_{suffix}",
            email=f"comment_mentioned_{suffix}@example.com",
            password="x",
        )
        self.outsider = User.objects.create_user(
            username=f"comment_outsider_{suffix}",
            email=f"comment_outsider_{suffix}@example.com",
            password="x",
        )
        self.organization = Organization.objects.create(
            name=f"评论测试组织 {suffix}",
            owner=self.owner,
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.viewer,
            role="viewer",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.other_viewer,
            role="viewer",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.mentioned_user,
            role="viewer",
        )

        self.space_id = uuid.uuid4()
        self.table = Table.objects.using(TABDATA_DB_ALIAS).create(
            organization_id=self.organization.id,
            space_id=self.space_id,
            owner_id=self.owner.id,
            name="评论测试表",
        )
        TablePermission.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            subject_type="user",
            subject_id=str(self.viewer.id),
            permission="viewer",
            is_active=True,
            granted_by=str(self.owner.id),
        )
        TablePermission.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            subject_type="user",
            subject_id=str(self.other_viewer.id),
            permission="viewer",
            is_active=True,
            granted_by=str(self.owner.id),
        )
        TablePermission.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            subject_type="user",
            subject_id=str(self.mentioned_user.id),
            permission="viewer",
            is_active=True,
            granted_by=str(self.owner.id),
        )
        self.record = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            created_by_id=self.owner.id,
            updated_by_id=self.owner.id,
            data={},
        )

        ddl = DDLManager(db_alias=TABDATA_DB_ALIAS)
        ddl.ensure_schema(self.space_id)
        ddl.create_native_table(self.space_id, self.table.id)
        NativeRecordIO(
            self.space_id,
            self.table.id,
            db_alias=TABDATA_DB_ALIAS,
        ).insert_record(
            self.record.id,
            {},
            {
                "__order": 0,
                "__version": 1,
                "__created_at": self.record.created_at,
                "__updated_at": self.record.updated_at,
                "__created_by": self.owner.id,
                "__updated_by": self.owner.id,
            },
        )
        self.addCleanup(self._drop_native_schema)

    def _drop_native_schema(self) -> None:
        DDLManager(db_alias=TABDATA_DB_ALIAS).drop_schema(self.space_id)

    def _create_native_record(self) -> TableRecord:
        record = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            created_by_id=self.owner.id,
            updated_by_id=self.owner.id,
            data={},
        )
        NativeRecordIO(
            self.space_id,
            self.table.id,
            db_alias=TABDATA_DB_ALIAS,
        ).insert_record(
            record.id,
            {},
            {
                "__order": 0,
                "__version": 1,
                "__created_at": record.created_at,
                "__updated_at": record.updated_at,
                "__created_by": self.owner.id,
                "__updated_by": self.owner.id,
            },
        )
        return record

    def _create_share(
        self,
        *,
        permission: str,
        password: str = "",
        view: TableView | None = None,
    ) -> TableShare:
        share = TableShare.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            view=view,
            share_type="data",
            share_id=uuid.uuid4().hex[:20],
            permission=permission,
            created_by=self.owner,
        )
        if password:
            share.set_password(password)
            share.save(using=TABDATA_DB_ALIAS, update_fields=["password_hash"])
        return share

    def _create_record_only_view(self) -> TableView:
        return TableView.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            name="只显示首条记录",
            view_type="grid",
            filter={
                "conjunction": "and",
                "filterSet": [
                    {
                        "field_id": "__id",
                        "operator": "equals",
                        "value": str(self.record.id),
                    }
                ],
            },
            created_by=self.owner,
        )

    def test_viewer_can_create_and_list_comment(self) -> None:
        auth = _jwt_headers(self.viewer)
        response = self.client.post(
            f"/api/tabdata/records/{self.record.id}/comments",
            data=json.dumps(
                {
                    "content": "  第一条评论  ",
                    "client_request_id": str(uuid.uuid4()),
                }
            ),
            content_type="application/json",
            **auth,
        )

        self.assertEqual(response.status_code, 201, response.content)
        comment = response.json()["data"]["comment"]
        self.assertEqual(comment["content"], "第一条评论")
        self.assertEqual(
            comment["actor"],
            {
                "type": "human",
                "id": str(self.viewer.id),
                "name": self.viewer.get_display_name(),
            },
        )
        self.assertEqual(
            comment["authorization_subject"],
            {
                "type": "user",
                "id": str(self.viewer.id),
                "name": self.viewer.get_display_name(),
            },
        )
        self.assertEqual(comment["capabilities"], {"can_delete": True})
        self.assertEqual(
            comment["audit"],
            {"agent_run_id": None, "session_id": None},
        )

        response = self.client.get(
            f"/api/tabdata/records/{self.record.id}/comments",
            **auth,
        )
        self.assertEqual(response.status_code, 200, response.content)
        payload = response.json()["data"]
        self.assertEqual(payload["total"], 1)
        self.assertFalse(payload["has_more"])
        self.assertIsNone(payload["next_cursor"])
        self.assertEqual([item["id"] for item in payload["comments"]], [comment["id"]])

    def test_internal_audit_is_visible_only_to_author_or_table_admin(self) -> None:
        run_id = str(uuid.uuid4())
        session_id = str(uuid.uuid4())
        comment = RecordComment.objects.using(TABDATA_DB_ALIAS).create(
            record=self.record,
            content="受限审计字段",
            author=self.viewer,
            author_name=self.viewer.get_display_name(),
            actor_type=RecordComment.ACTOR_TYPE_AGENT,
            actor_id=str(uuid.uuid4()),
            actor_name="审计 Agent",
            agent_run_id=run_id,
            session_id=session_id,
        )

        viewer_response = self.client.get(
            f"/api/tabdata/records/{self.record.id}/comments",
            **_jwt_headers(self.other_viewer),
        )
        self.assertEqual(viewer_response.status_code, 200, viewer_response.content)
        viewer_comment = viewer_response.json()["data"]["comments"][0]
        self.assertEqual(viewer_comment["id"], str(comment.id))
        self.assertNotIn("audit", viewer_comment)

        owner_response = self.client.get(
            f"/api/tabdata/records/{self.record.id}/comments",
            **_jwt_headers(self.owner),
        )
        self.assertEqual(owner_response.status_code, 200, owner_response.content)
        owner_comment = owner_response.json()["data"]["comments"][0]
        self.assertEqual(
            owner_comment["audit"],
            {"agent_run_id": run_id, "session_id": session_id},
        )

    def test_comment_mention_candidates_use_canonical_member_contract(self) -> None:
        self.mentioned_user.nickname = "候选成员"
        self.mentioned_user.save(update_fields=["nickname"])

        response = self.client.get(
            f"/api/tabdata/records/{self.record.id}/comment-mention-candidates"
            "?q=候选&limit=10",
            **_jwt_headers(self.viewer),
        )

        self.assertEqual(response.status_code, 200, response.content)
        candidates = response.json()["data"]["candidates"]
        self.assertEqual(len(candidates), 1)
        self.assertEqual(
            candidates[0],
            {
                "user_id": str(self.mentioned_user.id),
                "display_name": "候选成员",
                "account_name": self.mentioned_user.username,
                "avatar": None,
                "email": self.mentioned_user.email[0]
                + "***"
                + self.mentioned_user.email.split("@", 1)[0][-1]
                + "@example.com",
            },
        )

    def test_comment_mention_search_filters_before_the_member_window(self) -> None:
        self.mentioned_user.nickname = "窗口外精确候选"
        self.mentioned_user.save(update_fields=["nickname"])

        with patch(
            "apps.tabdata.services.comment_service.MAX_MENTION_CANDIDATES",
            2,
        ):
            response = self.client.get(
                f"/api/tabdata/records/{self.record.id}/comment-mention-candidates"
                "?q=窗口外精确候选&limit=2",
                **_jwt_headers(self.viewer),
            )

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(
            [item["user_id"] for item in response.json()["data"]["candidates"]],
            [str(self.mentioned_user.id)],
        )

    def test_comment_mention_candidates_honor_parent_document_inherited_viewer(self) -> None:
        self.mentioned_user.nickname = "父文档继承候选"
        self.mentioned_user.save(update_fields=["nickname"])
        TablePermission.objects.using(TABDATA_DB_ALIAS).filter(
            table=self.table,
            subject_type="user",
            subject_id=str(self.mentioned_user.id),
        ).delete()

        with patch(
            "apps.tabdoc.services.embedded_access."
            "get_current_parent_document_resource_role",
            return_value="viewer",
        ) as inherited_role:
            response = self.client.get(
                f"/api/tabdata/records/{self.record.id}/comment-mention-candidates"
                "?q=父文档继承候选",
                **_jwt_headers(self.viewer),
            )

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(
            [item["user_id"] for item in response.json()["data"]["candidates"]],
            [str(self.mentioned_user.id)],
        )
        inherited_role.assert_called()

    def test_comment_mention_candidates_include_organization_member_without_table_access(self) -> None:
        suffix = uuid.uuid4().hex[:8]
        no_access = User.objects.create_user(
            username=f"no_comment_access_{suffix}",
            nickname="无表权限候选",
            email=f"no_comment_access_{suffix}@example.com",
            password="x",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=no_access,
            role="viewer",
        )

        response = self.client.get(
            f"/api/tabdata/records/{self.record.id}/comment-mention-candidates"
            "?q=无表权限候选",
            **_jwt_headers(self.viewer),
        )

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(
            [candidate["user_id"] for candidate in response.json()["data"]["candidates"]],
            [str(no_access.id)],
        )

    def test_comment_mention_candidates_include_organization_member_hidden_by_rls(self) -> None:
        original_get_record_data = RecordService.get_record_data

        def _candidate_rls_gate(instance, record_id, *args, **kwargs):
            if str(instance.user.id) == str(self.mentioned_user.id):
                raise RLSAccessDenied("candidate hidden")
            return original_get_record_data(instance, record_id, *args, **kwargs)

        with patch.object(
            RecordService,
            "get_record_data",
            autospec=True,
            side_effect=_candidate_rls_gate,
        ):
            response = self.client.get(
                f"/api/tabdata/records/{self.record.id}/comment-mention-candidates"
                "?q=comment_mentioned",
                **_jwt_headers(self.viewer),
            )

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(
            [candidate["user_id"] for candidate in response.json()["data"]["candidates"]],
            [str(self.mentioned_user.id)],
        )

    def test_comment_share_with_password_supports_logged_in_crud_and_candidates(self) -> None:
        view = self._create_record_only_view()
        share = self._create_share(
            permission="comment",
            password="comment-secret",
            view=view,
        )
        headers = {
            **_jwt_headers(self.outsider),
            "HTTP_X_TABLE_SHARE_PASSWORD": "comment-secret",
        }
        request_id = str(uuid.uuid4())

        wrong_password = self.client.get(
            f"/api/tabdata/shared/{share.share_id}/records/{self.record.id}/comments",
            **{
                **_jwt_headers(self.outsider),
                "HTTP_X_TABLE_SHARE_PASSWORD": "wrong",
            },
        )
        self.assertEqual(wrong_password.status_code, 403, wrong_password.content)

        created = self.client.post(
            f"/api/tabdata/shared/{share.share_id}/records/{self.record.id}/comments",
            data=json.dumps(
                {
                    "content": "分享页评论",
                    "client_request_id": request_id,
                    "mention_user_ids": [str(self.mentioned_user.id)],
                }
            ),
            content_type="application/json",
            **headers,
        )
        self.assertEqual(created.status_code, 201, created.content)
        created_data = created.json()["data"]
        self.assertTrue(created_data["created"])
        self.assertEqual(
            created_data["comment"]["mentions"],
            [str(self.mentioned_user.id)],
        )
        self.assertEqual(
            created_data["comment"]["authorization_subject"]["id"],
            str(self.outsider.id),
        )
        self.assertNotIn("audit", created_data["comment"])

        listed = self.client.get(
            f"/api/tabdata/shared/{share.share_id}/records/{self.record.id}/comments",
            **headers,
        )
        self.assertEqual(listed.status_code, 200, listed.content)
        self.assertEqual(
            [comment["id"] for comment in listed.json()["data"]["comments"]],
            [created_data["comment"]["id"]],
        )
        self.assertNotIn("audit", listed.json()["data"]["comments"][0])

        resolved = self.client.patch(
            f"/api/tabdata/shared/{share.share_id}/records/{self.record.id}"
            f"/comment-threads/{created_data['comment']['id']}/status",
            data=json.dumps({"status": "resolved"}),
            content_type="application/json",
            **headers,
        )
        self.assertEqual(resolved.status_code, 200, resolved.content)
        self.assertEqual(resolved.json()["data"]["thread"]["status"], "resolved")
        resolved_list = self.client.get(
            f"/api/tabdata/shared/{share.share_id}/records/{self.record.id}"
            "/comments?status=resolved",
            **headers,
        )
        self.assertEqual(resolved_list.status_code, 200, resolved_list.content)
        self.assertEqual(
            [comment["id"] for comment in resolved_list.json()["data"]["comments"]],
            [created_data["comment"]["id"]],
        )

        candidates = self.client.get(
            f"/api/tabdata/shared/{share.share_id}/records/{self.record.id}"
            "/comment-mention-candidates?q=mentioned",
            **headers,
        )
        self.assertEqual(candidates.status_code, 200, candidates.content)
        self.assertIn(
            str(self.mentioned_user.id),
            [item["user_id"] for item in candidates.json()["data"]["candidates"]],
        )

        deleted = self.client.delete(
            f"/api/tabdata/shared/{share.share_id}/records/{self.record.id}"
            f"/comments/{created_data['comment']['id']}",
            **headers,
        )
        self.assertEqual(deleted.status_code, 200, deleted.content)
        self.assertEqual(deleted.json()["data"]["deleted"], True)
        self.assertEqual(
            deleted.json()["data"]["comment_id"],
            created_data["comment"]["id"],
        )
        self.assertNotIn("audit", deleted.json()["data"]["comment"])

    def test_comment_share_rejects_anonymous_view_only_and_filtered_out_records(self) -> None:
        hidden_record = self._create_native_record()
        view = self._create_record_only_view()
        comment_share = self._create_share(permission="comment", view=view)

        anonymous = self.client.get(
            f"/api/tabdata/shared/{comment_share.share_id}"
            f"/records/{self.record.id}/comments"
        )
        self.assertEqual(anonymous.status_code, 403, anonymous.content)

        anonymous_create = self.client.post(
            f"/api/tabdata/shared/{comment_share.share_id}"
            f"/records/{self.record.id}/comments",
            data=json.dumps({"content": "anonymous"}),
            content_type="application/json",
        )
        self.assertEqual(
            anonymous_create.status_code, 403, anonymous_create.content
        )

        anonymous_candidates = self.client.get(
            f"/api/tabdata/shared/{comment_share.share_id}"
            f"/records/{self.record.id}/comment-mention-candidates"
        )
        self.assertEqual(
            anonymous_candidates.status_code, 403, anonymous_candidates.content
        )

        anonymous_delete = self.client.delete(
            f"/api/tabdata/shared/{comment_share.share_id}"
            f"/records/{self.record.id}/comments/{uuid.uuid4()}"
        )
        self.assertEqual(
            anonymous_delete.status_code, 403, anonymous_delete.content
        )

        hidden = self.client.post(
            f"/api/tabdata/shared/{comment_share.share_id}"
            f"/records/{hidden_record.id}/comments",
            data=json.dumps({"content": "不可见行"}),
            content_type="application/json",
            **_jwt_headers(self.outsider),
        )
        self.assertEqual(hidden.status_code, 404, hidden.content)

        view_share = self._create_share(permission="view", view=view)
        denied = self.client.get(
            f"/api/tabdata/shared/{view_share.share_id}"
            f"/records/{self.record.id}/comments",
            **_jwt_headers(self.outsider),
        )
        self.assertEqual(denied.status_code, 403, denied.content)

        edit_share = self._create_share(permission="edit", view=view)
        allowed = self.client.get(
            f"/api/tabdata/shared/{edit_share.share_id}"
            f"/records/{self.record.id}/comments",
            **_jwt_headers(self.outsider),
        )
        self.assertEqual(allowed.status_code, 200, allowed.content)

    def test_anonymous_comment_share_records_remain_readable_but_edit_writes_require_login(self) -> None:
        view = self._create_record_only_view()
        comment_share = self._create_share(permission="comment", view=view)
        view_share = self._create_share(permission="view", view=view)
        edit_share = self._create_share(permission="edit", view=view)

        comment_meta = self.client.get(
            f"/api/tabdata/shared/{comment_share.share_id}"
        )
        self.assertEqual(comment_meta.status_code, 200, comment_meta.content)
        comment_meta_data = comment_meta.json()["data"]
        self.assertFalse(comment_meta_data["requires_login"])
        self.assertEqual(comment_meta_data["permission"], "comment")
        self.assertIn("fields", comment_meta_data)
        comment_records = self.client.get(
            f"/api/tabdata/shared/{comment_share.share_id}/records"
        )
        self.assertEqual(comment_records.status_code, 200, comment_records.content)
        self.assertIn("records", comment_records.json()["data"])

        view_meta = self.client.get(f"/api/tabdata/shared/{view_share.share_id}")
        self.assertEqual(view_meta.status_code, 200, view_meta.content)
        self.assertFalse(view_meta.json()["data"]["requires_login"])
        self.assertEqual(view_meta.json()["data"]["permission"], "view")
        view_records = self.client.get(
            f"/api/tabdata/shared/{view_share.share_id}/records"
        )
        self.assertEqual(view_records.status_code, 200, view_records.content)
        self.assertIn("records", view_records.json()["data"])

        edit_records = self.client.get(
            f"/api/tabdata/shared/{edit_share.share_id}/records"
        )
        self.assertEqual(edit_records.status_code, 200, edit_records.content)
        self.assertIn("records", edit_records.json()["data"])

        edit_write = self.client.patch(
            f"/api/tabdata/shared/{edit_share.share_id}/records/{self.record.id}",
            data=json.dumps({"field_id": "Name", "value": "updated"}),
            content_type="application/json",
        )
        self.assertEqual(edit_write.status_code, 403, edit_write.content)

    def test_comment_share_applies_rls_before_exposing_record(self) -> None:
        view = self._create_record_only_view()
        share = self._create_share(permission="comment", view=view)

        with patch(
            "apps.tabdata.services.comment_service.build_rls_select_where",
            return_value=("FALSE", []),
        ) as apply_rls:
            response = self.client.get(
                f"/api/tabdata/shared/{share.share_id}"
                f"/records/{self.record.id}/comments",
                **_jwt_headers(self.outsider),
            )

        self.assertEqual(response.status_code, 404, response.content)
        apply_rls.assert_called_once()

    def test_record_comment_counts_include_visible_zero_and_omit_rls_hidden_rows(self) -> None:
        empty_record = self._create_native_record()
        hidden_record = self._create_native_record()
        service = RecordCommentService(user=self.viewer)
        for index in range(2):
            service.create_comment(
                self.record.id,
                content=f"计数评论 {index}",
                client_request_id=str(uuid.uuid4()),
                rls_context=RLSContext(user_id=str(self.viewer.id)),
            )
        service.create_comment(
            hidden_record.id,
            content="不应泄漏的评论",
            client_request_id=str(uuid.uuid4()),
            rls_context=RLSContext(user_id=str(self.viewer.id)),
        )

        def _gate_hidden_record(table, rls_context, query_builder, base_where):
            sql, params = base_where
            return (
                f'({sql}) AND ("__id" <> %s)',
                [*params, str(hidden_record.id)],
            )

        record_ids = ",".join(
            (str(self.record.id), str(empty_record.id), str(hidden_record.id))
        )
        with patch(
            "apps.tabdata.services.comment_service.build_rls_select_where",
            side_effect=_gate_hidden_record,
        ) as apply_rls, patch.object(
            RecordService,
            "get_record_data",
            side_effect=AssertionError("批量计数不得逐记录读取"),
        ) as get_record_data:
            response = self.client.get(
                f"/api/tabdata/tables/{self.table.id}/record-comment-counts"
                f"?record_ids={record_ids}",
                **_jwt_headers(self.viewer),
            )

        apply_rls.assert_called_once()
        get_record_data.assert_not_called()

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(
            response.json()["data"]["counts"],
            {
                str(self.record.id): 2,
                str(empty_record.id): 0,
            },
        )

    def test_record_comment_counts_reject_more_than_one_hundred_unique_ids(self) -> None:
        record_ids = ",".join(str(uuid.uuid4()) for _ in range(101))

        response = self.client.get(
            f"/api/tabdata/tables/{self.table.id}/record-comment-counts"
            f"?record_ids={record_ids}",
            **_jwt_headers(self.viewer),
        )

        self.assertEqual(response.status_code, 400, response.content)
        self.assertIn("100", response.json()["message"])

    def test_record_comment_counts_can_select_thread_status_without_changing_legacy_counts(self) -> None:
        service = RecordCommentService(user=self.viewer)
        rls_context = RLSContext(user_id=str(self.viewer.id))
        open_root, _ = service.create_comment(
            self.record.id,
            content="open root",
            client_request_id=str(uuid.uuid4()),
            rls_context=rls_context,
        )
        service.create_comment(
            self.record.id,
            content="open reply",
            client_request_id=str(uuid.uuid4()),
            reply_to_comment_id=open_root.id,
            rls_context=rls_context,
        )
        resolved_root, _ = service.create_comment(
            self.record.id,
            content="resolved root",
            client_request_id=str(uuid.uuid4()),
            rls_context=rls_context,
        )
        service.update_thread_status(
            self.record.id,
            resolved_root.id,
            status="resolved",
            rls_context=rls_context,
        )
        endpoint = (
            f"/api/tabdata/tables/{self.table.id}/record-comment-counts"
            f"?record_ids={self.record.id}"
        )
        auth = _jwt_headers(self.viewer)

        legacy = self.client.get(endpoint, **auth).json()["data"]
        open_counts = self.client.get(f"{endpoint}&status=open", **auth).json()["data"]
        resolved_counts = self.client.get(
            f"{endpoint}&status=resolved", **auth
        ).json()["data"]

        self.assertEqual(legacy["counts"][str(self.record.id)], 3)
        self.assertEqual(open_counts["counts"][str(self.record.id)], 2)
        self.assertEqual(open_counts["thread_counts"][str(self.record.id)], 1)
        self.assertEqual(resolved_counts["counts"][str(self.record.id)], 1)
        self.assertEqual(resolved_counts["thread_counts"][str(self.record.id)], 1)

    def test_create_is_idempotent_filters_mentions_and_ignores_agent_header(self) -> None:
        auth = _jwt_headers(self.viewer)
        request_id = str(uuid.uuid4())
        body = {
            "content": "幂等评论",
            "client_request_id": request_id,
            "mention_user_ids": [
                str(self.mentioned_user.id),
                str(self.outsider.id),
                str(self.viewer.id),
                str(self.mentioned_user.id),
                "not-a-uuid",
            ],
        }
        headers = {
            **auth,
            "HTTP_X_TABTIN_AGENT_ID": str(uuid.uuid4()),
            "HTTP_X_TABTIN_AGENT_RUN_ID": "run-comment-1",
            "HTTP_X_TABTIN_SESSION_ID": "session-comment-1",
        }

        first = self.client.post(
            f"/api/tabdata/records/{self.record.id}/comments",
            data=json.dumps(body),
            content_type="application/json",
            **headers,
        )
        second = self.client.post(
            f"/api/tabdata/records/{self.record.id}/comments",
            data=json.dumps(body),
            content_type="application/json",
            **headers,
        )

        self.assertEqual(first.status_code, 201, first.content)
        self.assertEqual(second.status_code, 201, second.content)
        first_data = first.json()["data"]
        second_data = second.json()["data"]
        self.assertTrue(first_data["created"])
        self.assertFalse(second_data["created"])
        self.assertEqual(first_data["comment"]["id"], second_data["comment"]["id"])
        self.assertEqual(
            first_data["comment"]["mentions"],
            [str(self.mentioned_user.id)],
        )
        self.assertEqual(first_data["comment"]["actor"]["type"], "human")
        self.assertEqual(
            first_data["comment"]["audit"],
            {
                "agent_run_id": None,
                "session_id": None,
            },
        )

        self.assertEqual(
            RecordComment.objects.using(TABDATA_DB_ALIAS).filter(
                record=self.record,
                author=self.viewer,
                client_request_id=request_id,
            ).count(),
            1,
        )
        stored = RecordComment.objects.using(TABDATA_DB_ALIAS).get(
            id=first_data["comment"]["id"]
        )
        self.assertEqual(stored.agent_run_id, "")
        self.assertEqual(stored.session_id, "")

    def test_create_reply_keeps_parent_context_in_api_and_storage(self) -> None:
        service = RecordCommentService(user=self.viewer)
        parent, _ = service.create_comment(
            self.record.id,
            content="需要确认的原评论",
            client_request_id=str(uuid.uuid4()),
            rls_context=RLSContext(user_id=str(self.viewer.id)),
        )

        request_id = str(uuid.uuid4())
        body = {
            "content": "这是回复",
            "client_request_id": request_id,
            "mention_user_ids": [str(self.mentioned_user.id)],
            "reply_to_comment_id": str(parent.id),
        }

        response = self.client.post(
            f"/api/tabdata/records/{self.record.id}/comments",
            data=json.dumps(body),
            content_type="application/json",
            **_jwt_headers(self.other_viewer),
        )
        retry = self.client.post(
            f"/api/tabdata/records/{self.record.id}/comments",
            data=json.dumps(body),
            content_type="application/json",
            **_jwt_headers(self.other_viewer),
        )

        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(retry.status_code, 201, retry.content)
        response_data = response.json()["data"]
        retry_data = retry.json()["data"]
        self.assertTrue(response_data["created"])
        self.assertFalse(retry_data["created"])
        payload = response_data["comment"]
        self.assertEqual(retry_data["comment"]["id"], payload["id"])
        self.assertEqual(payload["reply_to"]["id"], str(parent.id))
        self.assertEqual(payload["reply_to"]["author_name"], parent.actor_name)
        self.assertEqual(payload["reply_to"]["content"], parent.content)
        self.assertEqual(payload["mentions"], [str(self.mentioned_user.id)])
        stored = RecordComment.objects.using(TABDATA_DB_ALIAS).get(id=payload["id"])
        self.assertEqual(stored.parent_id, parent.id)

    def test_comment_thread_status_can_be_resolved_reopened_and_filtered(self) -> None:
        service = RecordCommentService(user=self.viewer)
        root, _ = service.create_comment(
            self.record.id,
            content="需要确认的根评论",
            client_request_id=str(uuid.uuid4()),
            rls_context=RLSContext(user_id=str(self.viewer.id)),
        )
        reply, _ = service.create_comment(
            self.record.id,
            content="补充说明",
            client_request_id=str(uuid.uuid4()),
            reply_to_comment_id=root.id,
            rls_context=RLSContext(user_id=str(self.viewer.id)),
        )
        auth = _jwt_headers(self.other_viewer)

        resolved = self.client.patch(
            f"/api/tabdata/records/{self.record.id}/comment-threads/{root.id}/status",
            data=json.dumps({"status": "resolved"}),
            content_type="application/json",
            **auth,
        )

        self.assertEqual(resolved.status_code, 200, resolved.content)
        resolved_thread = resolved.json()["data"]["thread"]
        self.assertEqual(resolved_thread["id"], str(root.id))
        self.assertEqual(resolved_thread["status"], "resolved")
        self.assertEqual(resolved_thread["resolved_by_user_id"], str(self.other_viewer.id))
        self.assertIsNotNone(resolved_thread["resolved_at"])

        open_list = self.client.get(
            f"/api/tabdata/records/{self.record.id}/comments?status=open",
            **auth,
        ).json()["data"]
        self.assertEqual(open_list["comments"], [])
        self.assertEqual(open_list["thread_total"], 0)
        self.assertEqual(open_list["open_thread_total"], 0)

        resolved_list = self.client.get(
            f"/api/tabdata/records/{self.record.id}/comments?status=resolved",
            **auth,
        ).json()["data"]
        self.assertEqual(
            [comment["id"] for comment in resolved_list["comments"]],
            [str(root.id), str(reply.id)],
        )
        self.assertEqual(resolved_list["thread_total"], 1)
        self.assertTrue(all(
            comment["thread"]["id"] == str(root.id)
            and comment["thread"]["status"] == "resolved"
            for comment in resolved_list["comments"]
        ))

        reopened = self.client.patch(
            f"/api/tabdata/records/{self.record.id}/comment-threads/{root.id}/status",
            data=json.dumps({"status": "open"}),
            content_type="application/json",
            **auth,
        )
        self.assertEqual(reopened.status_code, 200, reopened.content)
        self.assertEqual(reopened.json()["data"]["thread"]["status"], "open")
        self.assertIsNone(reopened.json()["data"]["thread"]["resolved_by_user_id"])
        self.assertIsNone(reopened.json()["data"]["thread"]["resolved_at"])

    def test_deleted_comments_are_placeholders_only_in_all_threads(self) -> None:
        service = RecordCommentService(user=self.viewer)
        rls_context = RLSContext(user_id=str(self.viewer.id))
        root, _ = service.create_comment(
            self.record.id,
            content="root body must not leak after deletion",
            client_request_id=str(uuid.uuid4()),
            rls_context=rls_context,
        )
        reply, _ = service.create_comment(
            self.record.id,
            content="reply body must not leak after deletion",
            client_request_id=str(uuid.uuid4()),
            reply_to_comment_id=root.id,
            rls_context=rls_context,
        )
        auth = _jwt_headers(self.viewer)

        deleted_reply = self.client.delete(
            f"/api/tabdata/records/{self.record.id}/comments/{reply.id}",
            **auth,
        )
        self.assertEqual(deleted_reply.status_code, 200, deleted_reply.content)
        # 旧客户端仍会收到原删除响应；正文清理由新的 all 审计列表负责。
        self.assertEqual(
            deleted_reply.json()["data"]["comment"]["content"],
            "reply body must not leak after deletion",
        )

        open_before_root_delete = self.client.get(
            f"/api/tabdata/records/{self.record.id}/comments?status=open",
            **auth,
        ).json()["data"]
        self.assertEqual(
            [comment["id"] for comment in open_before_root_delete["comments"]],
            [str(root.id)],
        )

        all_before_root_delete = self.client.get(
            f"/api/tabdata/records/{self.record.id}/comments?status=all",
            **auth,
        ).json()["data"]
        deleted_reply_payload = next(
            comment
            for comment in all_before_root_delete["comments"]
            if comment["id"] == str(reply.id)
        )
        self.assertTrue(deleted_reply_payload["is_deleted"])
        self.assertEqual(deleted_reply_payload["content"], "")
        self.assertEqual(deleted_reply_payload["mentions"], [])

        deleted_root = self.client.delete(
            f"/api/tabdata/records/{self.record.id}/comments/{root.id}",
            **auth,
        )
        self.assertEqual(deleted_root.status_code, 200, deleted_root.content)

        for status in ("open", "resolved"):
            with self.subTest(status=status):
                filtered = self.client.get(
                    f"/api/tabdata/records/{self.record.id}/comments?status={status}",
                    **auth,
                ).json()["data"]
                self.assertEqual(filtered["comments"], [])
                self.assertEqual(filtered["thread_total"], 0)

        all_after_root_delete = self.client.get(
            f"/api/tabdata/records/{self.record.id}/comments?status=all",
            **auth,
        ).json()["data"]
        self.assertEqual(
            [comment["id"] for comment in all_after_root_delete["comments"]],
            [str(root.id), str(reply.id)],
        )
        self.assertEqual(all_after_root_delete["thread_total"], 1)
        self.assertTrue(all(comment["is_deleted"] for comment in all_after_root_delete["comments"]))
        self.assertTrue(all(comment["content"] == "" for comment in all_after_root_delete["comments"]))

        legacy = self.client.get(
            f"/api/tabdata/records/{self.record.id}/comments",
            **auth,
        ).json()["data"]
        self.assertEqual(legacy["comments"], [])

    def test_comment_thread_status_validates_state_permission_and_idempotency(self) -> None:
        service = RecordCommentService(user=self.viewer)
        root, _ = service.create_comment(
            self.record.id,
            content="status permission",
            client_request_id=str(uuid.uuid4()),
            rls_context=RLSContext(user_id=str(self.viewer.id)),
        )
        endpoint = (
            f"/api/tabdata/records/{self.record.id}/comment-threads/{root.id}/status"
        )

        invalid = self.client.patch(
            endpoint,
            data=json.dumps({"status": "closed"}),
            content_type="application/json",
            **_jwt_headers(self.viewer),
        )
        self.assertEqual(invalid.status_code, 400, invalid.content)

        denied = self.client.patch(
            endpoint,
            data=json.dumps({"status": "resolved"}),
            content_type="application/json",
            **_jwt_headers(self.outsider),
        )
        self.assertEqual(denied.status_code, 404, denied.content)

        with patch(
            "apps.tabdata.services.table_event_service."
            "table_event_service._broadcast_to_live"
        ) as broadcast:
            with self.captureOnCommitCallbacks(execute=True, using=TABDATA_DB_ALIAS):
                first = self.client.patch(
                    endpoint,
                    data=json.dumps({"status": "resolved"}),
                    content_type="application/json",
                    **_jwt_headers(self.viewer),
                )
            with self.captureOnCommitCallbacks(execute=True, using=TABDATA_DB_ALIAS):
                retry = self.client.patch(
                    endpoint,
                    data=json.dumps({"status": "resolved"}),
                    content_type="application/json",
                    **_jwt_headers(self.viewer),
                )

        self.assertEqual(first.status_code, 200, first.content)
        self.assertEqual(retry.status_code, 200, retry.content)
        broadcast.assert_called_once_with(
            document_name=f"table:{self.table.id}",
            event="table.comment.changed",
            payload={"table_id": str(self.table.id)},
        )

    def test_status_filter_paginates_whole_threads_instead_of_splitting_replies(self) -> None:
        service = RecordCommentService(user=self.viewer)
        rls_context = RLSContext(user_id=str(self.viewer.id))
        older_root, _ = service.create_comment(
            self.record.id,
            content="older root",
            client_request_id=str(uuid.uuid4()),
            rls_context=rls_context,
        )
        older_reply, _ = service.create_comment(
            self.record.id,
            content="older reply",
            client_request_id=str(uuid.uuid4()),
            reply_to_comment_id=older_root.id,
            rls_context=rls_context,
        )
        newer_root, _ = service.create_comment(
            self.record.id,
            content="newer root",
            client_request_id=str(uuid.uuid4()),
            rls_context=rls_context,
        )
        auth = _jwt_headers(self.viewer)

        latest = self.client.get(
            f"/api/tabdata/records/{self.record.id}/comments?status=open&limit=1",
            **auth,
        ).json()["data"]
        self.assertEqual(
            [comment["id"] for comment in latest["comments"]],
            [str(newer_root.id)],
        )
        self.assertTrue(latest["has_more"])

        older = self.client.get(
            f"/api/tabdata/records/{self.record.id}/comments"
            f"?status=open&limit=1&before={latest['next_cursor']}",
            **auth,
        ).json()["data"]
        self.assertEqual(
            [comment["id"] for comment in older["comments"]],
            [str(older_root.id), str(older_reply.id)],
        )
        self.assertFalse(older["has_more"])

    def test_create_reply_rejects_missing_deleted_or_other_record_parent(self) -> None:
        service = RecordCommentService(user=self.viewer)
        rls_context = RLSContext(user_id=str(self.viewer.id))
        deleted_parent, _ = service.create_comment(
            self.record.id,
            content="随后删除的评论",
            client_request_id=str(uuid.uuid4()),
            rls_context=rls_context,
        )
        RecordComment.objects.using(TABDATA_DB_ALIAS).filter(
            id=deleted_parent.id
        ).update(is_deleted=True)

        other_record = self._create_native_record()
        other_record_parent, _ = service.create_comment(
            other_record.id,
            content="另一条记录的评论",
            client_request_id=str(uuid.uuid4()),
            rls_context=rls_context,
        )

        for label, parent_id in (
            ("missing", uuid.uuid4()),
            ("deleted", deleted_parent.id),
            ("other-record", other_record_parent.id),
        ):
            with self.subTest(parent=label):
                response = self.client.post(
                    f"/api/tabdata/records/{self.record.id}/comments",
                    data=json.dumps(
                        {
                            "content": "无效回复",
                            "client_request_id": str(uuid.uuid4()),
                            "reply_to_comment_id": str(parent_id),
                        }
                    ),
                    content_type="application/json",
                    **_jwt_headers(self.viewer),
                )

                self.assertEqual(response.status_code, 404, response.content)
                self.assertIn("回复的评论不存在", response.json()["message"])

    def test_create_mentions_notify_organization_members_without_table_access(self) -> None:
        suffix = uuid.uuid4().hex[:8]
        no_table_access = User.objects.create_user(
            username=f"mention_no_access_{suffix}",
            email=f"mention_no_access_{suffix}@example.com",
            password="x",
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=no_table_access,
            role="viewer",
        )
        original_get_record_data = RecordService.get_record_data

        def _candidate_rls_gate(instance, record_id, *args, **kwargs):
            if str(instance.user.id) == str(self.other_viewer.id):
                raise RLSAccessDenied("candidate hidden")
            return original_get_record_data(instance, record_id, *args, **kwargs)

        body = {
            "content": "只给有权限成员展示这段评论",
            "client_request_id": str(uuid.uuid4()),
            "mention_user_ids": [
                str(self.mentioned_user.id),
                str(no_table_access.id),
                str(self.other_viewer.id),
                str(self.viewer.id),
            ],
        }
        with patch.object(
            RecordService,
            "get_record_data",
            autospec=True,
            side_effect=_candidate_rls_gate,
        ), patch(
            "apps.tabdata.services.table_event_service."
            "table_event_service._broadcast_to_live"
        ), patch(
            "apps.services.notification.services.notification_service."
            "NotificationService.notify"
        ) as notify, patch(
            "apps.services.notification.services.notification_service."
            "NotificationService.notify_desktop_only",
            create=True,
        ) as notify_desktop_only:
            with self.captureOnCommitCallbacks(
                execute=True,
                using=TABDATA_DB_ALIAS,
            ):
                response = self.client.post(
                    f"/api/tabdata/records/{self.record.id}/comments",
                    data=json.dumps(body),
                    content_type="application/json",
                    **_jwt_headers(self.viewer),
                )

        self.assertEqual(response.status_code, 201, response.content)
        comment_id = response.json()["data"]["comment"]["id"]
        self.assertEqual(
            response.json()["data"]["comment"]["mentions"],
            [
                str(self.mentioned_user.id),
                str(no_table_access.id),
                str(self.other_viewer.id),
            ],
        )
        notification_by_user_id = {
            call.kwargs["user_id"]: call.kwargs
            for call in notify.call_args_list
        }
        self.assertEqual(
            set(notification_by_user_id),
            {
                str(self.mentioned_user.id),
                str(no_table_access.id),
                str(self.other_viewer.id),
            },
        )
        for user_id, notification in notification_by_user_id.items():
            self.assertEqual(notification["type"], "tabdata.comment.mention")
            self.assertEqual(notification["body"], body["content"])
            self.assertEqual(notification["metadata"]["resource_type"], "table")
            self.assertEqual(
                notification["metadata"]["source_event_id"],
                f"tabdata.comment:{comment_id}:mention:{user_id}",
            )
        notify_desktop_only.assert_not_called()

    def test_first_create_emits_generic_invalidation_and_mentions_once_after_commit(self) -> None:
        auth = _jwt_headers(self.viewer)
        request_id = str(uuid.uuid4())
        body = {
            "content": "请查看这条评论",
            "client_request_id": request_id,
            "mention_user_ids": [str(self.mentioned_user.id)],
        }

        with patch(
            "apps.tabdata.services.table_event_service."
            "table_event_service._broadcast_to_live"
        ) as broadcast, patch(
            "apps.services.notification.services.notification_service."
            "NotificationService.notify"
        ) as notify:
            with self.captureOnCommitCallbacks(
                execute=True,
                using=TABDATA_DB_ALIAS,
            ):
                first = self.client.post(
                    f"/api/tabdata/records/{self.record.id}/comments",
                    data=json.dumps(body),
                    content_type="application/json",
                    **auth,
                )
            with self.captureOnCommitCallbacks(
                execute=True,
                using=TABDATA_DB_ALIAS,
            ):
                retry = self.client.post(
                    f"/api/tabdata/records/{self.record.id}/comments",
                    data=json.dumps(body),
                    content_type="application/json",
                    **auth,
                )

        self.assertEqual(first.status_code, 201, first.content)
        self.assertEqual(retry.status_code, 201, retry.content)
        self.assertTrue(first.json()["data"]["created"])
        self.assertFalse(retry.json()["data"]["created"])
        broadcast.assert_called_once_with(
            document_name=f"table:{self.table.id}",
            event="table.comment.changed",
            payload={"table_id": str(self.table.id)},
        )
        notify.assert_called_once()
        notification_call = notify.call_args.kwargs
        self.assertEqual(notification_call["user_id"], str(self.mentioned_user.id))
        self.assertEqual(notification_call["type"], "tabdata.comment.mention")
        self.assertEqual(
            notification_call["organization_id"],
            str(self.organization.id),
        )
        self.assertEqual(
            notification_call["metadata"]["source_event_id"],
            "tabdata.comment:"
            + first.json()["data"]["comment"]["id"]
            + ":mention:"
            + str(self.mentioned_user.id),
        )

    def test_rls_table_never_emits_generic_comment_invalidation(self) -> None:
        self.table.rls_enabled = True
        self.table.save(using=TABDATA_DB_ALIAS, update_fields=["rls_enabled"])
        service = RecordCommentService(user=self.viewer)

        with patch(
            "apps.tabdata.services.table_event_service."
            "table_event_service._broadcast_to_live"
        ) as broadcast:
            with self.captureOnCommitCallbacks(
                execute=True,
                using=TABDATA_DB_ALIAS,
            ):
                comment, _ = service.create_comment(
                    self.record.id,
                    content="RLS 表不广播评论频率",
                    client_request_id=str(uuid.uuid4()),
                    rls_context=RLSContext(user_id=str(self.viewer.id)),
                )
            with self.captureOnCommitCallbacks(
                execute=True,
                using=TABDATA_DB_ALIAS,
            ):
                service.delete_comment(
                    self.record.id,
                    comment.id,
                    rls_context=RLSContext(user_id=str(self.viewer.id)),
                )

        broadcast.assert_not_called()

    def test_trusted_execution_agent_is_display_actor_but_user_remains_authorizer(self) -> None:
        agent = Agent.objects.using(TABDATA_DB_ALIAS).create(
            organization_id=self.organization.id,
            owner_user_id=self.viewer.id,
            name="测试执行 Agent",
            type="bot",
        )
        token = set_current_execution_agent_id(str(agent.id))
        try:
            service = RecordCommentService(user=self.viewer)
            comment, created = service.create_comment(
                self.record.id,
                content="Agent 写下的评论",
                client_request_id=str(uuid.uuid4()),
                rls_context=RLSContext(user_id=str(self.viewer.id)),
            )
        finally:
            token.var.reset(token)

        self.assertTrue(created)
        payload = service.serialize_comment(comment)
        self.assertEqual(
            payload["actor"],
            {"type": "agent", "id": str(agent.id), "name": agent.name},
        )
        self.assertEqual(payload["authorization_subject"]["id"], str(self.viewer.id))
        self.assertEqual(comment.author_id, self.viewer.id)

    def test_only_author_can_soft_delete_comment(self) -> None:
        service = RecordCommentService(user=self.viewer)
        comment, _ = service.create_comment(
            self.record.id,
            content="只能自己删除",
            client_request_id=str(uuid.uuid4()),
            rls_context=RLSContext(user_id=str(self.viewer.id)),
        )

        denied = self.client.delete(
            f"/api/tabdata/records/{self.record.id}/comments/{comment.id}",
            **_jwt_headers(self.other_viewer),
        )
        self.assertEqual(denied.status_code, 403, denied.content)

        deleted = self.client.delete(
            f"/api/tabdata/records/{self.record.id}/comments/{comment.id}",
            **_jwt_headers(self.viewer),
        )
        self.assertEqual(deleted.status_code, 200, deleted.content)
        deleted_comment = deleted.json()["data"]["comment"]
        self.assertTrue(deleted.json()["data"]["deleted"])
        self.assertEqual(deleted.json()["data"]["comment_id"], str(comment.id))
        self.assertTrue(deleted_comment["is_deleted"])
        self.assertEqual(deleted_comment["capabilities"], {"can_delete": False})

        comment.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertTrue(comment.is_deleted)
        self.assertIsNotNone(comment.deleted_at)
        listed = self.client.get(
            f"/api/tabdata/records/{self.record.id}/comments",
            **_jwt_headers(self.viewer),
        )
        self.assertEqual(listed.status_code, 200, listed.content)
        self.assertEqual(listed.json()["data"]["comments"], [])
        self.assertEqual(listed.json()["data"]["total"], 0)

    def test_delete_emits_generic_invalidation_only_once(self) -> None:
        service = RecordCommentService(user=self.viewer)
        comment, _ = service.create_comment(
            self.record.id,
            content="删除后刷新计数",
            client_request_id=str(uuid.uuid4()),
            rls_context=RLSContext(user_id=str(self.viewer.id)),
        )
        auth = _jwt_headers(self.viewer)

        with patch(
            "apps.tabdata.services.table_event_service."
            "table_event_service._broadcast_to_live"
        ) as broadcast:
            with self.captureOnCommitCallbacks(
                execute=True,
                using=TABDATA_DB_ALIAS,
            ):
                first = self.client.delete(
                    f"/api/tabdata/records/{self.record.id}/comments/{comment.id}",
                    **auth,
                )
            with self.captureOnCommitCallbacks(
                execute=True,
                using=TABDATA_DB_ALIAS,
            ):
                retry = self.client.delete(
                    f"/api/tabdata/records/{self.record.id}/comments/{comment.id}",
                    **auth,
                )

        self.assertEqual(first.status_code, 200, first.content)
        self.assertEqual(retry.status_code, 200, retry.content)
        broadcast.assert_called_once_with(
            document_name=f"table:{self.table.id}",
            event="table.comment.changed",
            payload={"table_id": str(self.table.id)},
        )

    def test_before_pagination_returns_latest_page_and_is_stable_for_equal_timestamps(self) -> None:
        service = RecordCommentService(user=self.viewer)
        comments = []
        for index in range(3):
            comment, _ = service.create_comment(
                self.record.id,
                content=f"分页评论 {index}",
                client_request_id=str(uuid.uuid4()),
                rls_context=RLSContext(user_id=str(self.viewer.id)),
            )
            comments.append(comment)

        fixed_at = timezone.now()
        RecordComment.objects.using(TABDATA_DB_ALIAS).filter(
            id__in=[comment.id for comment in comments]
        ).update(created_at=fixed_at)
        expected_ids = [str(comment.id) for comment in sorted(comments, key=lambda item: item.id)]

        auth = _jwt_headers(self.viewer)
        first = self.client.get(
            f"/api/tabdata/records/{self.record.id}/comments?limit=2",
            **auth,
        )
        self.assertEqual(first.status_code, 200, first.content)
        first_page = first.json()["data"]
        self.assertEqual(first_page["total"], 3)
        self.assertTrue(first_page["has_more"])
        self.assertIsNotNone(first_page["next_cursor"])
        self.assertEqual(
            [item["id"] for item in first_page["comments"]],
            expected_ids[-2:],
        )

        second = self.client.get(
            f"/api/tabdata/records/{self.record.id}/comments"
            f"?limit=2&before={first_page['next_cursor']}",
            **auth,
        )
        self.assertEqual(second.status_code, 200, second.content)
        second_page = second.json()["data"]
        actual_ids = [item["id"] for item in second_page["comments"] + first_page["comments"]]
        self.assertEqual(actual_ids, expected_ids)
        self.assertFalse(second_page["has_more"])

    def test_anchor_loads_a_comment_older_than_the_latest_page(self) -> None:
        comments = [
            RecordComment(
                record=self.record,
                content=f"通知定位评论 {index}",
                author=self.viewer,
                author_name=self.viewer.get_display_name(),
                actor_type=RecordComment.ACTOR_TYPE_HUMAN,
                actor_id=str(self.viewer.id),
                actor_name=self.viewer.get_display_name(),
            )
            for index in range(55)
        ]
        RecordComment.objects.using(TABDATA_DB_ALIAS).bulk_create(comments)
        fixed_at = timezone.now()
        RecordComment.objects.using(TABDATA_DB_ALIAS).filter(
            id__in=[comment.id for comment in comments]
        ).update(created_at=fixed_at)
        ordered_ids = [str(comment.id) for comment in sorted(comments, key=lambda item: item.id)]
        anchor_id = ordered_ids[4]
        auth = _jwt_headers(self.viewer)

        latest = self.client.get(
            f"/api/tabdata/records/{self.record.id}/comments?limit=50",
            **auth,
        )
        self.assertEqual(latest.status_code, 200, latest.content)
        self.assertNotIn(
            anchor_id,
            [item["id"] for item in latest.json()["data"]["comments"]],
        )

        anchored = self.client.get(
            f"/api/tabdata/records/{self.record.id}/comments"
            f"?limit=50&anchor={anchor_id}",
            **auth,
        )
        self.assertEqual(anchored.status_code, 200, anchored.content)
        anchored_data = anchored.json()["data"]
        self.assertEqual(
            [item["id"] for item in anchored_data["comments"]],
            ordered_ids[:5],
        )
        self.assertEqual(anchored_data["comments"][-1]["id"], anchor_id)

        conflicting = self.client.get(
            f"/api/tabdata/records/{self.record.id}/comments"
            f"?anchor={anchor_id}&before=invalid",
            **auth,
        )
        self.assertEqual(conflicting.status_code, 400, conflicting.content)

    def test_content_validation_rejects_blank_and_over_limit(self) -> None:
        auth = _jwt_headers(self.viewer)
        for content in ("   ", "x" * 2001):
            with self.subTest(length=len(content)):
                response = self.client.post(
                    f"/api/tabdata/records/{self.record.id}/comments",
                    data=json.dumps({"content": content}),
                    content_type="application/json",
                    **auth,
                )
                self.assertEqual(response.status_code, 400, response.content)
        self.assertFalse(
            RecordComment.objects.using(TABDATA_DB_ALIAS).filter(record=self.record).exists()
        )

    def test_user_without_table_permission_cannot_read_or_write(self) -> None:
        auth = _jwt_headers(self.outsider)
        created = self.client.post(
            f"/api/tabdata/records/{self.record.id}/comments",
            data=json.dumps({"content": "不应写入"}),
            content_type="application/json",
            **auth,
        )
        listed = self.client.get(
            f"/api/tabdata/records/{self.record.id}/comments",
            **auth,
        )
        self.assertEqual(created.status_code, 404, created.content)
        self.assertEqual(listed.status_code, 404, listed.content)
        self.assertFalse(
            RecordComment.objects.using(TABDATA_DB_ALIAS).filter(record=self.record).exists()
        )

    def test_rls_denial_returns_403_without_writing(self) -> None:
        with patch(
            "apps.tabdata.services.comment_service.RecordService.get_record_data",
            side_effect=RLSAccessDenied("denied"),
        ):
            response = self.client.post(
                f"/api/tabdata/records/{self.record.id}/comments",
                data=json.dumps({"content": "RLS 不可见"}),
                content_type="application/json",
                **_jwt_headers(self.viewer),
            )
        self.assertEqual(response.status_code, 403, response.content)
        self.assertFalse(
            RecordComment.objects.using(TABDATA_DB_ALIAS).filter(record=self.record).exists()
        )

    def test_soft_deleted_record_is_not_commentable(self) -> None:
        TableRecord.objects.using(TABDATA_DB_ALIAS).filter(id=self.record.id).update(
            is_deleted=True,
            deleted_at=timezone.now(),
        )
        response = self.client.post(
            f"/api/tabdata/records/{self.record.id}/comments",
            data=json.dumps({"content": "不应写入"}),
            content_type="application/json",
            **_jwt_headers(self.viewer),
        )
        self.assertEqual(response.status_code, 404, response.content)

    def test_record_soft_delete_hides_comments_and_restore_recovers_same_thread(self) -> None:
        service = RecordCommentService(user=self.viewer)
        comment, _ = service.create_comment(
            self.record.id,
            content="记录恢复后仍应存在",
            client_request_id=str(uuid.uuid4()),
            rls_context=RLSContext(user_id=str(self.viewer.id)),
        )
        auth = _jwt_headers(self.viewer)

        TableRecord.objects.using(TABDATA_DB_ALIAS).filter(id=self.record.id).update(
            is_deleted=True,
            deleted_at=timezone.now(),
        )
        hidden = self.client.get(
            f"/api/tabdata/records/{self.record.id}/comments",
            **auth,
        )
        self.assertEqual(hidden.status_code, 404, hidden.content)

        TableRecord.objects.using(TABDATA_DB_ALIAS).filter(id=self.record.id).update(
            is_deleted=False,
            deleted_at=None,
        )
        restored = self.client.get(
            f"/api/tabdata/records/{self.record.id}/comments",
            **auth,
        )
        self.assertEqual(restored.status_code, 200, restored.content)
        self.assertEqual(
            [item["id"] for item in restored.json()["data"]["comments"]],
            [str(comment.id)],
        )
