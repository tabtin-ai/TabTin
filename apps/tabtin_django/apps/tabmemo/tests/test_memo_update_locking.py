from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.db import DatabaseError
from django.test import SimpleTestCase

from apps.tabmemo.error_codes import ErrorCode
from apps.tabtinspace.services.base import ServiceError


def _make_service(user=None):
    from apps.tabmemo.services.memo_service import MemoService

    svc = MemoService(user=user or MagicMock(id=uuid4()))
    svc.check_space_permission = MagicMock(return_value=True)
    svc.check_organization_permission = MagicMock(return_value=True)
    return svc


def _make_memo():
    memo = MagicMock()
    memo.id = uuid4()
    return memo


class MemoUpdateLockingTests(SimpleTestCase):
    def test_get_memo_can_lock_nowait(self):
        from apps.tabmemo.services.memo_service import MemoService

        memo = _make_memo()
        qs = MagicMock()
        locked_qs = MagicMock()

        with patch("apps.tabmemo.services.memo_service.Memo") as MockMemo:
            MockMemo.objects.using.return_value = qs
            qs.select_for_update.return_value = locked_qs
            locked_qs.get.return_value = memo

            svc = _make_service()
            svc._check_memo_access = MagicMock()
            result = MemoService._get_memo(
                svc,
                str(memo.id),
                for_update=True,
                for_update_nowait=True,
            )

        self.assertEqual(result, memo)
        qs.select_for_update.assert_called_once_with(nowait=True)

    def test_update_lock_conflict_returns_save_busy(self):
        svc = _make_service()
        svc._get_memo = MagicMock(side_effect=DatabaseError("could not obtain lock"))

        with patch(
            "apps.tabmemo.services.memo_service._apply_update_memo_db_timeouts"
        ), self.assertRaises(ServiceError) as ctx:
            svc.update_memo.__wrapped__(svc, str(uuid4()), tags=["new"])

        self.assertEqual(ctx.exception.code, ErrorCode.SAVE_BUSY)
        self.assertEqual(ctx.exception.status, 409)

    def test_update_non_lock_database_error_is_not_rewritten(self):
        svc = _make_service()
        svc._get_memo = MagicMock(side_effect=DatabaseError("connection failed"))

        with patch(
            "apps.tabmemo.services.memo_service._apply_update_memo_db_timeouts"
        ), self.assertRaises(DatabaseError):
            svc.update_memo.__wrapped__(svc, str(uuid4()), tags=["new"])
