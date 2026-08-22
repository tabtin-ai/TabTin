"""TGE-012 回归测试：extension_event 触发必须有 organization 范围过滤。"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase


class _FakeTrackerQuerySet:
    def __init__(self, trackers):
        self.trackers = trackers

    def filter(self, **_kwargs):
        return self

    def only(self, *_fields):
        return self

    def __getitem__(self, item):
        if isinstance(item, slice):
            return self.trackers[item]
        return self.trackers[item]

    def __iter__(self):
        return iter(self.trackers)


def _tracker(tracker_id: str, trigger_config: dict, *, space_id: str = "sp-1"):
    return SimpleNamespace(
        id=tracker_id,
        trigger_config=trigger_config,
        organization_id="wt-1",
        space_id=space_id,
    )


def _allowed_decision():
    return SimpleNamespace(allowed=True, reason="", first_trigger=False)


def _blocked_decision(reason: str = "circuit_breaker(2/60s)"):
    return SimpleNamespace(allowed=False, reason=reason, first_trigger=False)


class TestTGE012OrganizationScopeGuard(SimpleTestCase):
    """TGE-012: _on_event_for_tracker 在 organization_id 为空时必须跳过 extension_event 匹配。"""

    @patch("apps.extensions.consumers.Tracker", create=True)
    @patch("apps.extensions.consumers.start_tracker_run", create=True)
    def test_empty_organization_skips_extension_event_matching(self, mock_start, mock_tracker_cls):
        from apps.extensions.consumers import _on_event_for_tracker
        from apps.extensions.event_bus import Event

        event = Event(
            source="tabdoc",
            event_type="tabdoc.resource.created",
            organization_id="",
            payload={"title": "test"},
        )

        result = _on_event_for_tracker(event)

        self.assertEqual(result, 0, "organization_id 为空时应返回 0，不触发任何 Tracker")
        mock_tracker_cls.objects.filter.assert_not_called()

    @patch("apps.extensions.consumers.Tracker", create=True)
    @patch("apps.extensions.consumers.start_tracker_run", create=True)
    def test_none_organization_skips_extension_event_matching(self, mock_start, mock_tracker_cls):
        from apps.extensions.consumers import _on_event_for_tracker
        from apps.extensions.event_bus import Event

        event = Event(
            source="tabdoc",
            event_type="tabdoc.resource.created",
            organization_id="",
            payload={},
        )
        event.organization_id = None

        result = _on_event_for_tracker(event)

        self.assertEqual(result, 0)
        mock_tracker_cls.objects.filter.assert_not_called()

    def test_consumer_code_has_organization_guard(self):
        """验证 _on_event_for_tracker 源码中存在 organization_id 空值检查。"""
        import inspect
        from apps.extensions.consumers import _on_event_for_tracker

        source = inspect.getsource(_on_event_for_tracker)
        self.assertIn(
            "not event.organization_id",
            source,
            "_on_event_for_tracker 必须检查 organization_id 为空的情况",
        )

    def test_consumer_always_filters_by_organization(self):
        """验证 Tracker 查询始终包含 organization 过滤条件（不再有条件分支）。"""
        import inspect
        from apps.extensions.consumers import _on_event_for_tracker

        source = inspect.getsource(_on_event_for_tracker)
        self.assertIn(
            "organization=event.organization_id",
            source,
            "Tracker.objects.filter 必须始终包含 organization 过滤条件",
        )


class TestExtensionEventTrackerContract(SimpleTestCase):
    """extension_event Tracker 的 event_key 匹配与 storm guard 回归。"""

    def test_cli_on_event_key_hits_matching_tracker(self):
        from apps.extensions.consumers import _on_event_for_tracker
        from apps.extensions.event_bus import Event

        event = Event(
            source="tabdoc",
            event_type="tabdoc.document.published",
            organization_id="wt-1",
            space_id="sp-1",
            payload={"title": "Roadmap"},
            event_id="evt-hit",
        )
        qs = _FakeTrackerQuerySet([
            _tracker("tracker-hit", {"event_key": "tabdoc.document.published"}),
            _tracker("tracker-miss", {"event_key": "tabmail.email.received"}),
        ])

        with patch("apps.tracker.models.Tracker") as mock_tracker_cls, \
                patch("django.core.cache.cache.add", return_value=True), \
                patch(
                    "apps.tracker.services.tracker_trigger_service.apply_storm_guard",
                    return_value=_allowed_decision(),
                ) as mock_guard, \
                patch("apps.tracker.services.tracker_executor.start_tracker_run", return_value="run-1") as mock_start:
            mock_tracker_cls.objects.filter.return_value = qs

            result = _on_event_for_tracker(event)

        self.assertEqual(result, 1)
        mock_guard.assert_called_once()
        mock_start.assert_called_once()
        self.assertEqual(mock_start.call_args.kwargs["tracker_id"], "tracker-hit")
        self.assertEqual(
            mock_start.call_args.kwargs["trigger_context"]["event_key"],
            "tabdoc.document.published",
        )

    def test_different_event_key_does_not_cross_trigger(self):
        from apps.extensions.consumers import _on_event_for_tracker
        from apps.extensions.event_bus import Event

        event = Event(
            source="tabmail",
            event_type="tabmail.email.received",
            organization_id="wt-1",
            space_id="sp-1",
            payload={"title": "Hello"},
            event_id="evt-miss",
        )
        qs = _FakeTrackerQuerySet([
            _tracker("tracker-doc", {"event_key": "tabdoc.document.published"}),
            _tracker("tracker-site", {"event_key": "tabsite.page.saved"}),
        ])

        with patch("apps.tracker.models.Tracker") as mock_tracker_cls, \
                patch("django.core.cache.cache.add", return_value=True), \
                patch("apps.tracker.services.tracker_trigger_service.apply_storm_guard") as mock_guard, \
                patch("apps.tracker.services.tracker_executor.start_tracker_run") as mock_start:
            mock_tracker_cls.objects.filter.return_value = qs

            result = _on_event_for_tracker(event)

        self.assertEqual(result, 0)
        mock_guard.assert_not_called()
        mock_start.assert_not_called()

    def test_extension_event_storm_guard_blocks_run_start(self):
        from apps.extensions.consumers import _on_event_for_tracker
        from apps.extensions.event_bus import Event

        qs = _FakeTrackerQuerySet([
            _tracker("tracker-storm", {
                "event_key": "tabdoc.document.published",
                "circuit_breaker_threshold": 2,
            }),
        ])

        with patch("apps.tracker.models.Tracker") as mock_tracker_cls, \
                patch("django.core.cache.cache.add", return_value=True), \
                patch(
                    "apps.tracker.services.tracker_trigger_service.apply_storm_guard",
                    return_value=_blocked_decision(),
                ) as mock_guard, \
                patch("apps.tracker.services.tracker_executor.start_tracker_run") as mock_start:
            mock_tracker_cls.objects.filter.return_value = qs
            results = [
                _on_event_for_tracker(Event(
                    source="tabdoc",
                    event_type="tabdoc.document.published",
                    organization_id="wt-1",
                    space_id="sp-1",
                    payload={"title": f"doc-{idx}"},
                    event_id=f"evt-storm-{idx}",
                ))
                for idx in range(5)
            ]

        self.assertEqual(results, [0, 0, 0, 0, 0])
        self.assertEqual(mock_guard.call_count, 5)
        mock_start.assert_not_called()
