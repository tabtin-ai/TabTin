"""Tracker HTTP 路由聚合入口（波次 4 Stage 2.1 一刀切）。

- ``trackers.py``：主 CRUD + 生命周期（13 路由），挂在 ``/events/*``。
- ``sidechannel.py``：侧路（templates / webhook / SDK progress / filtered-events）。

合并后由 ``urls_deferred.py`` 一次性挂到 ``/api/tracker/`` 前缀下。
"""

from __future__ import annotations

from ninja import Router

from apps.tracker.api.trackers import router as _trackers_router
from apps.tracker.api.sidechannel import router as _sidechannel_router

router = Router(tags=["TabTracker"])
router.add_router("", _trackers_router)
router.add_router("", _sidechannel_router)
