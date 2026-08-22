from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from apps.services.common.public_share.exceptions import ShareNotFoundError
from apps.services.common.public_share.service import PublicShareService


class _DummyShareManager:
    def __init__(self, share):
        self.share = share

    def using(self, _alias):
        return self

    def select_related(self, *_args):
        return self

    def get(self, share_id):
        if share_id != self.share.share_id:
            raise _DummyShareModel.DoesNotExist()
        return self.share


class _DummyShareModel:
    class DoesNotExist(Exception):
        pass

    objects = None


class _DummyShareService(PublicShareService):
    share_model = _DummyShareModel
    resource_model = object
    db_alias = "default"
    share_select_related = ("resource",)

    @classmethod
    def check_resource_admin(cls, resource, user, *, required_role="admin"):
        return True

    @classmethod
    def serialize_meta(cls, share):
        return {}

    @classmethod
    def serialize_content(cls, share):
        return {}


def _share_for_resource(resource):
    share = SimpleNamespace(
        share_id="share_1",
        resource=resource,
        share_type="public",
        is_active=True,
        has_password=False,
        is_expired=lambda: False,
    )
    _DummyShareModel.objects = _DummyShareManager(share)
    return share


def test_get_share_by_id_rejects_resource_with_trashed_at():
    resource = SimpleNamespace(id="res_1", trashed_at=datetime.now(timezone.utc), status="active")
    _share_for_resource(resource)

    with pytest.raises(ShareNotFoundError):
        _DummyShareService.get_share_by_id("share_1")


def test_verify_share_access_rejects_trashed_status_resource():
    resource = SimpleNamespace(id="res_1", trashed_at=None, status="trashed")
    share = _share_for_resource(resource)

    with pytest.raises(ShareNotFoundError):
        _DummyShareService.verify_share_access(share)
