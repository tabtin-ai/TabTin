"""
DeviceService — 设备管理服务

负责 Device 的注册（upsert）、状态更新、列表查询、删除。
支持执行设备（control）和能力设备（data）两类角色。
"""
import json
import logging
import threading
import time
from typing import List, Optional, Dict, Any
from uuid import UUID

from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.models import Q
from django.utils import timezone

from apps.services.common.device_capability_registry import (
    DEVICE_RUNTIME_TYPES,
    infer_device_role,
    is_user_level_device,
    normalize_device_capabilities,
    normalize_device_type,
)
from apps.tabtinspace.models import Device, Organization
from apps.tabtinspace.services.execution_binding import resolve_control_device
from .base import BaseService

logger = logging.getLogger(__name__)

# ── DV-2：stale 巡检的「墙钟跳变」防护常量 ──────────────────────────────
# 巡检 beat 调度间隔（须与 `tabtinspace/tasks.py` 的
# `"cleanup-stale-online-devices".schedule` 对齐：120s）。
_CLEANUP_BEAT_INTERVAL_SECONDS = 120
# 墙钟跳变阈值：两次巡检的**实际**间隔若超过它，判定服务端自身停摆过（休眠/重启）。
# 单机 dev 尤甚——celery 与 Electron 同机，休眠时心跳「发」「收」一起冻结，唤醒后
# 巡检会拿休眠前的旧 `last_heartbeat_at` 把在线设备误标 offline。取 2× 间隔以容忍
# 正常调度抖动（队列延迟 / worker 繁忙）。
_CLEANUP_WALLCLOCK_GAP_SECONDS = _CLEANUP_BEAT_INTERVAL_SECONDS * 2
# 记录上轮巡检运行时刻的 cache key + TTL。单 sentinel key 无泄漏顾虑；TTL 取足够长
# 以覆盖整夜休眠（Redis 在休眠中不重启、key 仍在 → 唤醒后能算出真实 gap）。
_CLEANUP_LAST_RUN_CACHE_KEY = "device:cleanup_stale:last_run_ts"
_CLEANUP_LAST_RUN_TTL_SECONDS = 7 * 24 * 3600


def _normalize_runtime_snapshot_for_compare(system_info: Optional[Dict[str, Any]]) -> str:
    if not isinstance(system_info, dict):
        return ""
    snapshot = system_info.get("host_runtime_snapshot")
    if not isinstance(snapshot, dict):
        return ""

    comparable = dict(snapshot)
    comparable.pop("reported_at", None)
    try:
        return json.dumps(comparable, sort_keys=True, ensure_ascii=False)
    except TypeError:
        return str(comparable)

# ---------------------------------------------------------------------------
# HeartbeatCache — 内存防抖层
# ---------------------------------------------------------------------------
_DEBOUNCE_SECONDS = 30
_FLUSH_INTERVAL_SECONDS = 5


class _HeartbeatEntry:
    __slots__ = ('fingerprint', 'user_id', 'last_db_write', 'capabilities', 'system_info')

    def __init__(self, fingerprint: str, user_id: str):
        self.fingerprint = fingerprint
        self.user_id = user_id
        self.last_db_write: float = 0.0
        self.capabilities: Optional[List[str]] = None
        self.system_info: Optional[Dict[str, Any]] = None


class HeartbeatCache:
    """心跳防抖缓存（双层架构）。

    Layer 1 — 进程内内存缓存（热路径，零延迟）：
        相同 fingerprint 在 _DEBOUNCE_SECONDS 内的重复心跳只更新内存，
        超过阈值或数据变更时才进入 Layer 2 检查。

    Layer 2 — Redis 跨进程防抖（G-078 修复）：
        在多 worker 部署下（如 4 个 uvicorn worker），每个进程维护独立的
        内存缓存，导致防抖效果与 worker 数量成反比。Redis 层使用 SET NX
        提供跨进程协调，同一 fingerprint 在防抖窗口内只有一个 worker 能
        真正写 DB。Redis 不可用时优雅降级为纯内存防抖。

    Known limitation: Layer 1 仍为进程级单例。在 worker 进程回收/重启后
    缓存冷启动，第一次心跳必定穿透到 Layer 2（Redis 或 DB）。这是可接受的
    trade-off——热路径零延迟 vs. 冷启动单次额外 RTT。
    """
    _instance: Optional['HeartbeatCache'] = None
    _lock = threading.Lock()

    _REDIS_DEBOUNCE_PREFIX = "hb:debounce:"

    def __init__(self):
        self._entries: Dict[str, _HeartbeatEntry] = {}
        self._cache_lock = threading.Lock()
        self._hits = 0
        self._misses = 0

    @classmethod
    def get(cls) -> 'HeartbeatCache':
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    def should_write_db(self, fingerprint: str, user_id: str,
                        capabilities: Optional[List[str]] = None,
                        system_info: Optional[Dict[str, Any]] = None) -> bool:
        """判断是否需要写 DB。返回 True 则调用方应执行 DB 更新。"""
        import random
        now = time.monotonic()
        with self._cache_lock:
            # G-079: 提高 eviction 触发概率（1%→5%），并在缓存条目数超过阈值时强制触发，
            # 防止大量短生命周期设备（CI/CD Daemon）造成内存泄漏。
            if len(self._entries) > 500 or random.random() < 0.05:
                self._evict_stale(now)

            entry = self._entries.get(fingerprint)
            if entry is None:
                entry = _HeartbeatEntry(fingerprint, user_id)
                self._entries[fingerprint] = entry
                self._misses += 1
            else:
                self._hits += 1

            prev_capabilities = list(entry.capabilities or []) if isinstance(entry.capabilities, list) else []
            prev_home_dir = (
                entry.system_info.get("home_dir")
                if isinstance(entry.system_info, dict)
                else None
            )
            prev_runtime_snapshot = _normalize_runtime_snapshot_for_compare(entry.system_info)
            next_home_dir = (
                system_info.get("home_dir")
                if isinstance(system_info, dict)
                else None
            )
            next_runtime_snapshot = _normalize_runtime_snapshot_for_compare(system_info)
            capabilities_changed = capabilities is not None and capabilities != prev_capabilities
            home_dir_changed = (
                system_info is not None
                and bool(next_home_dir)
                and next_home_dir != prev_home_dir
            )
            runtime_snapshot_changed = (
                system_info is not None
                and next_runtime_snapshot != prev_runtime_snapshot
            )

            entry.capabilities = capabilities
            entry.system_info = system_info

            data_changed = capabilities_changed or home_dir_changed or runtime_snapshot_changed
            time_expired = now - entry.last_db_write >= _DEBOUNCE_SECONDS

            if not data_changed and not time_expired:
                return False

            entry.last_db_write = now

        if data_changed:
            self._redis_debounce_invalidate(fingerprint)
            return True

        return self._redis_debounce_acquire(fingerprint)

    def _redis_debounce_acquire(self, fingerprint: str) -> bool:
        """G-078: Redis 跨进程防抖 — 使用 SET NX 争夺写权。
        返回 True 表示当前 worker 获得写权，False 表示其他 worker 已在窗口内写入。
        Redis 不可用时降级为 True（允许写入，防抖失效但功能不受影响）。
        """
        try:
            from django.core.cache import cache
            key = f"{self._REDIS_DEBOUNCE_PREFIX}{fingerprint}"
            return cache.add(key, "1", _DEBOUNCE_SECONDS)
        except Exception:
            return True

    @staticmethod
    def _redis_debounce_invalidate(fingerprint: str) -> None:
        """数据变更时清除 Redis 防抖 key，确保变更立即写入。"""
        try:
            from django.core.cache import cache
            cache.delete(f"{HeartbeatCache._REDIS_DEBOUNCE_PREFIX}{fingerprint}")
        except Exception:
            pass

    def _evict_stale(self, now: float) -> None:
        """清理超过 10 分钟未写 DB 的缓存条目（已持有 _cache_lock）。"""
        cutoff = now - 600
        stale = [fp for fp, e in self._entries.items() if e.last_db_write < cutoff]
        for fp in stale:
            del self._entries[fp]
        if stale:
            logger.debug("[HeartbeatCache] evicted %d stale entries", len(stale))

    def get_stats(self) -> Dict[str, int]:
        with self._cache_lock:
            return {'hits': self._hits, 'misses': self._misses, 'entries': len(self._entries)}

    def invalidate(self, fingerprint: str) -> None:
        with self._cache_lock:
            self._entries.pop(fingerprint, None)
        self._redis_debounce_invalidate(fingerprint)


_OS_NAME_MAP = {
    "macOS": "darwin", "macos": "darwin",
    "Windows": "win32", "windows": "win32",
    "Linux": "linux",
}


class DeviceService(BaseService):
    """设备服务（执行设备 + 能力设备）"""

    @staticmethod
    def _normalize_device_type(device_type: Optional[str]) -> str:
        return normalize_device_type(device_type)

    @staticmethod
    def _normalize_os_info(os_info: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        """归一化 os_info.os 为 process.platform 标准值（darwin/linux/win32）。"""
        if not os_info or not isinstance(os_info, dict):
            return os_info or {}
        raw_os = os_info.get("os", "")
        if raw_os in _OS_NAME_MAP:
            os_info["os"] = _OS_NAME_MAP[raw_os]
            os_info.setdefault("platform", os_info["os"])
        return os_info

    @classmethod
    def _normalize_capabilities(
        cls,
        capabilities: Optional[List[str]],
        *,
        device_type: Optional[str],
    ) -> List[str]:
        return normalize_device_capabilities(capabilities, device_type=device_type)

    def register_device(
        self,
        organization_id: UUID,
        fingerprint: str,
        device_type: str,
        name: str,
        os_info: Optional[Dict[str, Any]] = None,
        capabilities: Optional[List[str]] = None,
        machine_key: Optional[str] = None,
        previous_fingerprint: Optional[str] = None,
        recovery_fingerprints: Optional[List[str]] = None,
        identity_verified: bool = False,
    ) -> Optional[Device]:
        """注册或更新设备（upsert by fingerprint + user_id）。

        用户级设备（Electron）：跨 Organization 时不更新 organization_id，直接返回已有设备
        并刷新 status/heartbeat。团队级设备（Daemon/Cloud）：跨 Organization 时返回 None
        （409 由上层 API 处理）。

        控制面启用后，只有已完成设备凭证校验的内部调用可迁移跨账号 Electron 投影。

         硬件锚定：若携带 previous_fingerprint / machine_key，优先 reclaim 旧 Device 行
        （改 fingerprint、写 machine_key），保留 Device.id 与 Space 绑定。
        """
        if not self.user:
            return None

        if not self.check_organization_permission(str(organization_id), 'viewer'):
            return None

        try:
            organization = Organization.objects.get(id=organization_id)
        except Organization.DoesNotExist:
            return None

        try:
            normalized_device_type = self._normalize_device_type(device_type)
            normalized_machine_key = (machine_key or '').strip()
            # `previous_fingerprint` 仅来自当前运行档自己的持久化文件，可兼容没有
            # machine_key 的早期 Device。数组候选可能来自历史目录，必须走完整机钥门。
            normalized_previous = (previous_fingerprint or '').strip()
            if normalized_previous == fingerprint:
                normalized_previous = ''
            recovery_candidates = []
            for candidate in recovery_fingerprints or []:
                normalized = (candidate or '').strip()
                if (
                    normalized
                    and normalized != fingerprint
                    and normalized != normalized_previous
                    and normalized not in recovery_candidates
                ):
                    recovery_candidates.append(normalized)

            # fingerprint 在 DB 层全局唯一；按 (fingerprint, user_id) 查会漏掉「其他用户
            # 在同一台 Electron 上注册过」的行，进而 INSERT 触发 IntegrityError 并误报 403。
            other_user_device = (
                Device.objects.filter(fingerprint=fingerprint)
                .exclude(user_id=self.user.id)
                .select_related('organization')
                .first()
            )
            if other_user_device:
                if is_user_level_device(normalized_device_type) and (
                    not getattr(settings, 'DAEMON_CONTROL_ENABLED', False)
                    or identity_verified
                ):
                    normalized_capabilities = self._normalize_capabilities(
                        capabilities,
                        device_type=normalized_device_type,
                    )
                    normalized_role = infer_device_role(normalized_device_type)
                    previous_user_id = other_user_device.user_id
                    other_user_device.user_id = self.user.id
                    other_user_device.organization = organization
                    other_user_device.name = name
                    other_user_device.device_type = normalized_device_type
                    other_user_device.role = normalized_role
                    other_user_device.os_info = self._normalize_os_info(os_info)
                    other_user_device.capabilities = normalized_capabilities
                    other_user_device.status = 'online'
                    other_user_device.last_heartbeat_at = timezone.now()
                    if normalized_machine_key:
                        other_user_device.machine_key = normalized_machine_key
                    other_user_device.save()
                    logger.info(
                        "[Device] transferred user-level device projection: fingerprint=%s, "
                        "from_user=%s to_user=%s, organization=%s",
                        fingerprint, previous_user_id, self.user.id, organization_id,
                    )
                    if other_user_device.organization_id:
                        try:
                            from apps.services.common.ws.device_broadcast import _broadcast_device_status
                            _broadcast_device_status(other_user_device, 'online')
                        except Exception as exc:
                            logger.warning("[Device] register broadcast failed for %s: %s", fingerprint, exc)
                    return other_user_device
                from .base import ServiceError
                raise ServiceError(
                    'DEVICE_FINGERPRINT_CONFLICT',
                    '该设备指纹已被其他用户注册',
                    409,
                )

            # 当前运行档自己的 previous_fingerprint 可兼容没有 machine_key 的
            # 早期 Device；旧设备仍必须同用户、同类型且离线。
            if (
                normalized_previous
                and normalized_machine_key
                and is_user_level_device(normalized_device_type)
            ):
                reclaimed = self._reclaim_device_by_previous_fingerprint(
                    organization=organization,
                    fingerprint=fingerprint,
                    previous_fingerprint=normalized_previous,
                    machine_key=normalized_machine_key,
                    device_type=normalized_device_type,
                    name=name,
                    os_info=os_info,
                    capabilities=capabilities,
                )
                if reclaimed is not None:
                    return reclaimed

            # 历史目录候选只是线索，不是接管凭据。须证明旧设备与当前安装
            # 同档、同机，且唯一离线；否则保留原现场，后续走显式接管。
            if normalized_machine_key and is_user_level_device(normalized_device_type):
                for recovery_fingerprint in recovery_candidates:
                    reclaimed = self._reclaim_device_by_recovery_fingerprint(
                        organization=organization,
                        fingerprint=fingerprint,
                        recovery_fingerprint=recovery_fingerprint,
                        machine_key=normalized_machine_key,
                        device_type=normalized_device_type,
                        name=name,
                        os_info=os_info,
                        capabilities=capabilities,
                    )
                    if reclaimed is not None:
                        return reclaimed

            if (
                normalized_machine_key
                and is_user_level_device(normalized_device_type)
            ):
                reclaimed = self._reclaim_device_by_machine_key(
                    organization=organization,
                    fingerprint=fingerprint,
                    machine_key=normalized_machine_key,
                    device_type=normalized_device_type,
                    name=name,
                    os_info=os_info,
                    capabilities=capabilities,
                )
                if reclaimed is not None:
                    return reclaimed

            existing = Device.objects.filter(
                fingerprint=fingerprint, user_id=self.user.id,
            ).select_related('organization').first()

            if existing and str(existing.organization_id) != str(organization_id):
                if is_user_level_device(normalized_device_type):
                    existing.status = 'online'
                    existing.last_heartbeat_at = timezone.now()
                    update_fields = ['status', 'last_heartbeat_at', 'updated_at']
                    if name and name != existing.name:
                        existing.name = name
                        update_fields.append('name')
                    if capabilities is not None:
                        normalized_caps = self._normalize_capabilities(
                            capabilities, device_type=normalized_device_type,
                        )
                        if normalized_caps != (existing.capabilities or []):
                            existing.capabilities = normalized_caps
                            update_fields.append('capabilities')
                    if normalized_machine_key and existing.machine_key != normalized_machine_key:
                        existing.machine_key = normalized_machine_key
                        update_fields.append('machine_key')
                    existing.save(update_fields=update_fields)
                    logger.info(
                        "[Device] user-level device found in another organization, "
                        "returning existing: fingerprint=%s, registered_wt=%s, requested_wt=%s",
                        fingerprint, existing.organization_id, organization_id,
                    )
                    if existing.organization_id:
                        try:
                            from apps.services.common.ws.device_broadcast import _broadcast_device_status
                            _broadcast_device_status(existing, 'online')
                        except Exception as exc:
                            logger.warning("[Device] register broadcast failed for %s: %s", fingerprint, exc)
                    return existing
                else:
                    from .base import ServiceError
                    raise ServiceError(
                        'DEVICE_BOUND_IN_OTHER_ORGANIZATION',
                        f'Device {fingerprint} is registered in another organization',
                        409,
                    )

            normalized_capabilities = self._normalize_capabilities(
                capabilities,
                device_type=normalized_device_type,
            )
            normalized_role = infer_device_role(normalized_device_type)
            defaults = {
                'organization': organization,
                'name': name,
                'device_type': normalized_device_type,
                'role': normalized_role,
                'os_info': self._normalize_os_info(os_info),
                'capabilities': normalized_capabilities,
                'status': 'online',
                'last_heartbeat_at': timezone.now(),
            }
            if normalized_machine_key:
                defaults['machine_key'] = normalized_machine_key
            device, created = Device.objects.update_or_create(
                fingerprint=fingerprint,
                user_id=self.user.id,
                defaults=defaults,
            )
            if not created and device.status == 'busy':
                Device.objects.filter(id=device.id, status='busy').update(
                    last_heartbeat_at=timezone.now(),
                )
                device.refresh_from_db()
            logger.info(
                "[Device] %s device: fingerprint=%s, name=%s, user=%s, organization=%s",
                "registered" if created else "updated",
                fingerprint, name, self.user.id, organization_id,
            )

            if device.organization_id:
                try:
                    from apps.services.common.ws.device_broadcast import _broadcast_device_status
                    _broadcast_device_status(device, 'online')
                except Exception as exc:
                    logger.warning("[Device] register broadcast failed for %s: %s", fingerprint, exc)

            return device
        except IntegrityError as exc:
            logger.warning(
                "[Device] register_device IntegrityError: fingerprint=%s, user=%s — %s",
                fingerprint, self.user.id, exc,
            )
            return None

    def _reclaim_device_identity(
        self,
        *,
        organization,
        fingerprint: str,
        lookup_fingerprint: str,
        device_type: str,
        name: str,
        os_info: Optional[Dict[str, Any]],
        capabilities: Optional[List[str]],
        machine_key: str,
        reason: str,
        allow_legacy_without_machine_key: bool = False,
    ) -> Optional[Device]:
        """把旧 fingerprint 行改成新 fingerprint，保留主键。"""
        legacy = (
            Device.objects.filter(
                fingerprint=lookup_fingerprint,
                user_id=self.user.id,
            )
            .select_related('organization')
            .first()
        )
        if not legacy:
            return None
        same_machine_key = bool(machine_key) and legacy.machine_key == machine_key
        if (
            legacy.device_type != device_type
            or legacy.status != 'offline'
            or not (same_machine_key or (allow_legacy_without_machine_key and not legacy.machine_key))
        ):
            logger.warning(
                "[Device] reclaim skipped (%s): legacy device is not a unique "
                "offline same-profile Electron fingerprint=%s",
                reason,
                lookup_fingerprint,
            )
            return None
        conflict = (
            Device.objects.filter(fingerprint=fingerprint)
            .exclude(id=legacy.id)
            .first()
        )
        if conflict:
            # 旧客户端可能已为当前安装身份创建新行，却没有上报旧指纹；
            # 补丁发布后重试 reclaim 时会撞到这条「新且未绑定 / 已自动建 Space」的行。
            # 保留 legacy 的 id 才能让所有既有 Space 继续视作本机，因此先把误建行的
            # 执行绑定转回 legacy 再删除它。仅限同用户 Electron，不能据此合并他机。
            if (
                conflict.user_id == self.user.id
                and is_user_level_device(conflict.device_type)
            ):
                self._merge_duplicate_user_device(legacy, conflict)
            else:
                logger.warning(
                    "[Device] reclaim skipped (%s): new fingerprint already exists "
                    "fingerprint=%s legacy=%s",
                    reason, fingerprint, lookup_fingerprint,
                )
                return None

        normalized_capabilities = self._normalize_capabilities(
            capabilities, device_type=device_type,
        )
        # 用户级设备跨 Organization 注册不迁移归属（与 register_device 既有契约一致）；
        # reclaim 只换 fingerprint / machine_key，刻意不写 legacy.organization。
        legacy.fingerprint = fingerprint
        legacy.name = name
        legacy.device_type = device_type
        legacy.role = infer_device_role(device_type)
        legacy.os_info = self._normalize_os_info(os_info)
        legacy.capabilities = normalized_capabilities
        legacy.status = 'online'
        legacy.last_heartbeat_at = timezone.now()
        if machine_key:
            legacy.machine_key = machine_key
        legacy.save()
        logger.info(
            "[Device] reclaimed device (%s): id=%s %s → %s user=%s org=%s",
            reason, legacy.id, lookup_fingerprint, fingerprint, self.user.id,
            legacy.organization_id,
        )
        if legacy.organization_id:
            try:
                from apps.services.common.ws.device_broadcast import _broadcast_device_status
                _broadcast_device_status(legacy, 'online')
            except Exception as exc:
                logger.warning("[Device] register broadcast failed for %s: %s", fingerprint, exc)
        return legacy

    @staticmethod
    def _merge_duplicate_user_device(legacy: Device, duplicate: Device) -> None:
        """合并错误新建的用户级 Device 到保留绑定的旧 Device。"""
        from apps.tabtinspace.models import Workspace

        duplicate_id = duplicate.id
        with transaction.atomic():
            Workspace.objects.filter(device_id=duplicate.id).update(device=legacy)
            duplicate.delete()
        logger.info(
            "[Device] merged duplicate installation device: duplicate=%s → legacy=%s",
            duplicate_id, legacy.id,
        )

    def _reclaim_device_by_previous_fingerprint(
        self,
        *,
        organization,
        fingerprint: str,
        previous_fingerprint: str,
        machine_key: str,
        device_type: str,
        name: str,
        os_info: Optional[Dict[str, Any]],
        capabilities: Optional[List[str]],
    ) -> Optional[Device]:
        """恢复当前运行档持久化的旧身份，兼容缺少 machine_key 的早期记录。"""
        return self._reclaim_device_identity(
            organization=organization,
            fingerprint=fingerprint,
            lookup_fingerprint=previous_fingerprint,
            device_type=device_type,
            name=name,
            os_info=os_info,
            capabilities=capabilities,
            machine_key=machine_key,
            reason='previous_fingerprint',
            allow_legacy_without_machine_key=True,
        )

    def _reclaim_device_by_recovery_fingerprint(
        self,
        *,
        organization,
        fingerprint: str,
        recovery_fingerprint: str,
        machine_key: str,
        device_type: str,
        name: str,
        os_info: Optional[Dict[str, Any]],
        capabilities: Optional[List[str]],
    ) -> Optional[Device]:
        """仅恢复同机同档、唯一且离线的历史安装身份。"""
        candidates = list(
            Device.objects.filter(
                user_id=self.user.id,
                machine_key=machine_key,
                device_type=device_type,
            )
            .exclude(fingerprint=fingerprint)
            .select_related('organization')[:2]
        )
        if (
            len(candidates) != 1
            or candidates[0].status != 'offline'
            or candidates[0].fingerprint != recovery_fingerprint
        ):
            return None
        return self._reclaim_device_identity(
            organization=organization,
            fingerprint=fingerprint,
            lookup_fingerprint=recovery_fingerprint,
            device_type=device_type,
            name=name,
            os_info=os_info,
            capabilities=capabilities,
            machine_key=machine_key,
            reason='recovery_fingerprint',
        )

    def _reclaim_device_by_machine_key(
        self,
        *,
        organization,
        fingerprint: str,
        machine_key: str,
        device_type: str,
        name: str,
        os_info: Optional[Dict[str, Any]],
        capabilities: Optional[List[str]],
    ) -> Optional[Device]:
        """重装恢复：同 user + machine_key 唯一且离线的旧行才更新安装 fingerprint。"""
        by_key = list(
            Device.objects.filter(
                user_id=self.user.id,
                machine_key=machine_key,
                device_type=device_type,
            )
            .exclude(fingerprint=fingerprint)
            .select_related('organization')[:2]
        )
        # 多个同机历史身份、或旧客户端仍在线都属于歧义，必须走显式接管 UI，
        # 不能静默迁移。
        if len(by_key) != 1 or by_key[0].status != 'offline':
            return None
        return self._reclaim_device_identity(
            organization=organization,
            fingerprint=fingerprint,
            lookup_fingerprint=by_key[0].fingerprint,
            device_type=device_type,
            name=name,
            os_info=os_info,
            capabilities=capabilities,
            machine_key=machine_key,
            reason='machine_key',
        )

    def heartbeat(
        self,
        fingerprint: str,
        capabilities: Optional[List[str]] = None,
        system_info: Optional[Dict[str, Any]] = None,
    ) -> Optional[Device]:
        """设备心跳 — 刷新 last_heartbeat_at 并确保 status='online'。

        独立于 WS 连接，由 Electron/Daemon 定时 HTTP 调用。
        WS 重连期间设备仍能通过心跳保持 online 状态，不被 Celery 清理任务标记 offline。
        Daemon 额外上报 capabilities 和 system_info（运行时监控数据）。

        使用 HeartbeatCache 防抖：30 秒内重复心跳跳过 DB 写入，降低高频心跳对数据库压力。
        """
        if not self.user:
            return None

        cache = HeartbeatCache.get()

        try:
            device = Device.objects.get(fingerprint=fingerprint, user_id=self.user.id)
        except Device.DoesNotExist:
            try:
                from apps.services.common.ws.metrics import device_heartbeats
                device_heartbeats.labels(result='not_found').inc()
            except Exception:
                pass
            return None

        # git_status 同步独立于 DB 防抖 — 每次心跳都处理，避免长延迟
        git_status = None
        if system_info is not None:
            git_status = system_info.pop('git_status', None)
            if git_status and isinstance(git_status, dict):
                try:
                    self._sync_git_status_to_workspaces(device, git_status)
                except Exception as exc:
                    logger.debug("[Device] git_status sync error: %s", exc)

            # 支持多 organization：git_statuses 为数组，每项对应不同目录的 git 状态
            git_statuses = system_info.pop('git_statuses', None)
            if git_statuses and isinstance(git_statuses, list):
                for gs in git_statuses:
                    if gs and isinstance(gs, dict):
                        try:
                            self._sync_git_status_to_workspaces(device, gs)
                        except Exception as exc:
                            logger.debug("[Device] git_statuses[*] sync error: %s", exc)

        normalized_requested_capabilities = (
            self._normalize_capabilities(capabilities, device_type=device.device_type)
            if capabilities is not None
            else None
        )
        old_capabilities = list(device.capabilities or []) if isinstance(device.capabilities, list) else []
        status_changed = device.status == 'offline'
        needs_db = status_changed or cache.should_write_db(
            fingerprint, str(self.user.id), normalized_requested_capabilities, system_info,
        )

        try:
            from apps.services.common.ws.metrics import device_heartbeats
            device_heartbeats.labels(result='ok' if needs_db else 'debounced').inc()
        except Exception:
            pass

        if not needs_db:
            return device

        device.last_heartbeat_at = timezone.now()
        update_fields = ['last_heartbeat_at', 'updated_at']
        if status_changed:
            device.status = 'online'
            update_fields.append('status')
            logger.info("[Device] heartbeat revived: fingerprint=%s (was offline)", fingerprint)
            _should_broadcast = True
        else:
            _should_broadcast = False
        capabilities_changed = False
        if capabilities is not None:
            normalized_capabilities = normalized_requested_capabilities or []
            capabilities_changed = normalized_capabilities != old_capabilities
            device.capabilities = normalized_capabilities
            update_fields.append('capabilities')
        if system_info is not None:
            merged_os_info = {**(device.os_info or {}), 'runtime': system_info}
            # home_dir 策略：每次心跳覆盖顶层值，确保 SandboxPolicyResolver
            # 始终使用设备最新的 $HOME（应对用户切换、容器环境变更等场景）。
            home_dir = system_info.get('home_dir')
            if home_dir:
                prev_home = (device.os_info or {}).get('home_dir')
                if prev_home and prev_home != home_dir:
                    logger.info(
                        "[Device] home_dir changed: fingerprint=%s, %s → %s",
                        fingerprint, prev_home, home_dir,
                    )
                merged_os_info['home_dir'] = home_dir
            device.os_info = merged_os_info
            update_fields.append('os_info')

        device.save(update_fields=update_fields)
        setattr(device, "_capabilities_changed", capabilities_changed)

        if (_should_broadcast or capabilities_changed) and device.organization_id:
            try:
                from apps.services.common.ws.device_broadcast import _broadcast_device_status
                _broadcast_device_status(device, device.status or 'offline')
            except Exception as exc:
                logger.debug("[Device] heartbeat broadcast failed for %s: %s", fingerprint, exc)

        return device

    def update_device_status(
        self,
        fingerprint: str,
        status: str,
        user_id: Optional[str] = None,
    ) -> Optional[Device]:
        """更新设备在线状态（由 WS connect/disconnect 钩子调用）。

        user_id 非空时校验设备归属，防止通过伪造 fingerprint 修改他人设备状态。
        """
        try:
            lookup = {'fingerprint': fingerprint}
            if user_id:
                lookup['user_id'] = user_id
            device = Device.objects.get(**lookup)
        except Device.DoesNotExist:
            return None

        old_status = device.status
        update_fields = ['status', 'updated_at']
        device.status = status
        if status == 'online':
            device.last_heartbeat_at = timezone.now()
            update_fields.append('last_heartbeat_at')
        device.save(update_fields=update_fields)

        status_changed = old_status != status
        setattr(device, "_status_changed", status_changed)
        setattr(device, "_previous_status", old_status)

        if status_changed:
            logger.info(
                "[Device] status changed: fingerprint=%s, %s → %s",
                fingerprint, old_status, status,
            )

        return device

    def report_offline(self, fingerprint: str) -> Optional[Device]:
        """主动上报离线 — Electron/Daemon 关闭时调用。

        立即将设备标记为 offline 并广播状态变更，
        避免依赖心跳超时的 Celery 清理产生延迟。
        """
        if not self.user:
            return None

        try:
            device = Device.objects.get(fingerprint=fingerprint, user_id=self.user.id)
        except Device.DoesNotExist:
            return None

        if device.status == 'offline':
            return device

        device.status = 'offline'
        device.save(update_fields=['status', 'updated_at'])
        logger.info("[Device] explicit offline report: fingerprint=%s", fingerprint)

        if device.organization_id:
            try:
                from apps.services.common.ws.device_broadcast import _broadcast_device_status
                _broadcast_device_status(device, 'offline')
            except Exception as exc:
                logger.debug("[Device] offline broadcast failed for %s: %s", fingerprint, exc)

        return device

    def get_device(self, device_id: UUID) -> Optional[Device]:
        """获取单个设备，检查所有权。"""
        try:
            device = Device.objects.get(id=device_id)
        except Device.DoesNotExist:
            return None

        if not self.user:
            return None
        if str(device.user_id) != str(self.user.id):
            return None
        return device

    def get_device_by_fingerprint(self, fingerprint: str) -> Optional[Device]:
        """通过 fingerprint 获取设备。"""
        try:
            return Device.objects.get(fingerprint=fingerprint)
        except Device.DoesNotExist:
            return None

    def list_devices(self, organization_id: Optional[UUID] = None) -> List[Device]:
        """列出当前用户的设备。

        用户级设备（Electron）始终返回（不受 organization_id 过滤），
        团队级设备（Daemon/Cloud）仅返回属于指定 organization 的。
        """
        if not self.user:
            return []

        qs = Device.objects.filter(user_id=self.user.id)
        if organization_id:
            from apps.services.common.device_capability_registry import USER_LEVEL_DEVICE_TYPES
            qs = qs.filter(
                Q(organization_id=organization_id) | Q(device_type__in=USER_LEVEL_DEVICE_TYPES)
            )
        return list(qs.order_by('-last_heartbeat_at', '-created_at'))

    def update_device(
        self,
        device_id: UUID,
        name: Optional[str] = None,
        capabilities: Optional[List[str]] = None,
    ) -> Optional[Device]:
        """更新设备名称或能力列表。"""
        device = self.get_device(device_id)
        if not device:
            return None

        update_fields = ['updated_at']
        if name is not None:
            device.name = name
            update_fields.append('name')
        if capabilities is not None:
            device.capabilities = self._normalize_capabilities(
                capabilities,
                device_type=device.device_type,
            )
            update_fields.append('capabilities')

        device.save(update_fields=update_fields)
        logger.info("[Device] updated: id=%s, name=%s, caps=%s", device_id, name, capabilities)
        return device

    def _active_workspaces_bound_to_device(self, device_id: UUID) -> int:
        """统计仍以该设备为执行设备的活跃 workspace 数量。

        Workspace 是执行设备绑定的事实源；个人 Space 壳在退役窗口内仍计入，
        防止删除设备时漏掉尚未迁出的绑定。
        """
        from apps.tabtinspace.models import Workspace

        return Workspace.objects.filter(device_id=device_id).count()

    def delete_device(self, device_id: UUID, force: bool = False) -> bool:
        """删除设备。

         根因 1：设备与 workspace 的执行绑定是 ``on_delete=SET_NULL``，
        直接删设备会把绑定静默清空，随后其他设备的「开箱即用自愈」会无声接管、
        目录被换成别处本地路径。为此在删除前拦截：若该设备仍是某些活跃 workspace
        的执行设备，除非调用方显式 ``force=True`` 确认，否则拒绝删除并告知影响面。
        """
        from .base import ServiceError

        device = self.get_device(device_id)
        if not device:
            return False
        if not force:
            bound_count = self._active_workspaces_bound_to_device(device_id)
            if bound_count > 0:
                raise ServiceError(
                    'DEVICE_BOUND_TO_WORKSPACE',
                    f'该设备仍是 {bound_count} 个 Space 的执行设备，'
                    f'删除会导致这些 Space 的工作目录绑定丢失。'
                    f'请先迁移或删除这些 Space，或确认强制删除。',
                    409,
                    data={'workspace_count': bound_count},
                )
        try:
            from apps.services.common.ws.device_broadcast import _broadcast_device_status
            _broadcast_device_status(device, 'offline')
        except Exception as exc:
            logger.warning("[Device] delete broadcast failed for %s: %s", device_id, exc)
        logger.info(
            "[Device] deleted: id=%s, fingerprint=%s, name=%s, user=%s",
            device_id, device.fingerprint, device.name, device.user_id,
        )
        device.delete()
        return True

    @staticmethod
    def _git_status_changed(old: Optional[Dict[str, Any]], new: Dict[str, Any]) -> bool:
        """比较两份 git_status 是否有实质变化（排除 collected_at 等时间戳字段）。"""
        if old is None:
            return True
        _VOLATILE_KEYS = {'collected_at'}
        old_cmp = {k: v for k, v in old.items() if k not in _VOLATILE_KEYS}
        new_cmp = {k: v for k, v in new.items() if k not in _VOLATILE_KEYS}
        return old_cmp != new_cmp

    def _sync_git_status_to_workspaces(self, device: Device, git_status: Dict[str, Any]) -> None:
        """将 Daemon 上报的 git_status 同步到绑定该设备的所有 Workspace。

        仅在 git_status 实质变化时才写 DB 和广播，避免 collected_at 每次不同导致的无意义 IO。
        """
        from apps.tabtinspace.models import Workspace

        try:
            for workspace in Workspace.objects.filter(device=device):
                old_status = workspace.git_status or {}

                if not self._git_status_changed(old_status, git_status):
                    continue

                workspace.git_status = git_status
                workspace.save(update_fields=['git_status', 'updated_at'])
                self._broadcast_git_status(workspace, device, git_status)

        except Exception as exc:
            logger.warning("[Device] git_status sync failed for device %s: %s", device.fingerprint, exc)

    @staticmethod
    def _broadcast_git_status(space, device: Device, git_status: Dict[str, Any]) -> None:
        """广播 git.status 事件到 organization group。

        Phase 1: 通过 organization group 广播（与 device.status 一致），前端无需显式订阅。
        Phase 2 可改为 topic group 精确投递（需前端先 subscribe git.status.{space_id}）。
        """
        try:
            from asgiref.sync import async_to_sync
            from channels.layers import get_channel_layer
            from apps.services.common.ws.protocol import (
                CHANNEL_SAFE_PATTERN, build_envelope, new_event_id,
            )

            event_id = new_event_id()
            envelope = build_envelope(
                "git.status",
                event_id,
                {
                    "space_id": str(space.id),
                    "device_id": str(device.id),
                    "git_status": git_status,
                },
                event_id=event_id,
                organization_id=str(space.organization_id),
            )

            channel_layer = get_channel_layer()
            if channel_layer is None:
                return

            group_name = CHANNEL_SAFE_PATTERN.sub(".", f"organization.{space.organization_id}")
            async_to_sync(channel_layer.group_send)(
                group_name,
                {"type": "broadcast_message", "message": envelope},
            )
        except Exception as exc:
            logger.debug("[Device] git.status broadcast failed: %s", exc)

    @classmethod
    def cleanup_stale_online_devices(
        cls, timeout_minutes: int = 5, *, detect_wallclock_gap: bool = True
    ) -> int:
        """将超过 timeout_minutes 未收到心跳的 'online' 设备标记为 'offline'。

        由 Celery Beat 定时任务调用，防止因 TCP 半开连接导致设备假在线。
        逐个更新并广播 device.status 事件，确保前端实时感知。
        同时清理路由缓存（device_action_ready / daemon_channel / runtime_channel），
        防止异常断开导致缓存残留引发消息路由到幽灵设备。

        DV-2（墙钟跳变防护）：`detect_wallclock_gap=True`（默认）时，若距上轮巡检的
        **实际**间隔远超调度间隔（服务端自身休眠/重启过，单机 dev 心跳收发齐冻结），
        本轮**跳过**标记——避免拿休眠前的旧 `last_heartbeat_at` 误判在线设备离线。
        下一轮（下个调度周期）设备已重连心跳、间隔恢复正常即照常巡检；真离线设备至多
        延迟一轮被收口。测试可传 `detect_wallclock_gap=False` 隔离纯 staleness 逻辑。
        """
        now = timezone.now()

        # DV-2：墙钟跳变（休眠/重启）防护——只在「有上轮记录且间隔异常大」时跳过；
        # 无记录（首跑 / cache 丢失）按现状照常巡检（fail-safe 偏向清理幽灵设备，
        # 避免 cache 异常导致永不收口）。
        if detect_wallclock_gap:
            from django.core.cache import cache
            now_ts = now.timestamp()
            last_run_ts = cache.get(_CLEANUP_LAST_RUN_CACHE_KEY)
            cache.set(_CLEANUP_LAST_RUN_CACHE_KEY, now_ts, timeout=_CLEANUP_LAST_RUN_TTL_SECONDS)
            if last_run_ts is not None:
                try:
                    gap = now_ts - float(last_run_ts)
                except (TypeError, ValueError):
                    gap = 0.0
                if gap > _CLEANUP_WALLCLOCK_GAP_SECONDS:
                    logger.info(
                        "[Device] cleanup: wall-clock gap %.0fs (>%ds) detected "
                        "(sleep/restart); skip offline this round to grant reconnect grace",
                        gap, _CLEANUP_WALLCLOCK_GAP_SECONDS,
                    )
                    return 0

        cutoff = now - timezone.timedelta(minutes=timeout_minutes)
        stale_devices = list(
            Device.objects.filter(status__in=('online', 'busy'))
            .exclude(last_heartbeat_at__gte=cutoff)
            .select_related('organization')[:200]
        )
        if not stale_devices:
            return 0

        count = 0
        for device in stale_devices:
            device.status = 'offline'
            device.save(update_fields=['status', 'updated_at'])
            count += 1

            cls._cleanup_routing_caches(device)

            if device.organization_id:
                try:
                    from apps.services.common.ws.device_broadcast import _broadcast_device_status
                    _broadcast_device_status(device, 'offline')
                except Exception as exc:
                    logger.debug("[Device] cleanup broadcast failed for %s: %s", device.fingerprint, exc)

        logger.info("[Device] cleanup: marked %d stale devices as offline (cutoff=%s)", count, cutoff)
        return count

    @staticmethod
    def _cleanup_routing_caches(device: Device) -> None:
        """清理设备路由相关的 Redis 缓存。

        异常断开时 WS disconnect handler 可能未执行，这些缓存会残留到 TTL 过期。
        由 cleanup_stale_online_devices 在标记 offline 时同步调用，确保 routing
        不再命中已失联的设备。

        G-033: 删除前重新校验设备状态，避免与新连接 auth 竞态误删刚重连设备的缓存。
        """
        try:
            from django.core.cache import cache
            from apps.services.common.ws.bus import clear_device_action_ready

            fp = device.fingerprint

            # G-033: 在 cleanup_stale_online_devices 标记 offline 到此处之间，
            # 设备可能已重连并通过 auth 写入新的路由缓存。
            # 重新查询 DB 确认设备仍为 offline，避免误删新连接的缓存。
            current_status = (
                Device.objects.filter(fingerprint=fp)
                .values_list('status', flat=True)
                .first()
            )
            if current_status and current_status != 'offline':
                logger.debug(
                    "[Device] skip routing cache cleanup: device %s reconnected (status=%s)",
                    fp, current_status,
                )
                return

            clear_device_action_ready(fp)
            cache.delete(f"daemon_channel:{fp}")
            cache.delete(f"runtime_channel:{fp}")
        except Exception as exc:
            logger.debug("[Device] routing cache cleanup failed for %s: %s", device.fingerprint, exc)

    @classmethod
    def mark_busy(cls, device_id: str) -> bool:
        """标记设备为 busy（正在执行Agent runtime 任务）。仅 online 设备可标记。"""
        updated = Device.objects.filter(
            id=device_id, status='online',
        ).update(status='busy')
        if updated:
            try:
                device = Device.objects.select_related('organization').get(id=device_id)
                from apps.services.common.ws.device_broadcast import _broadcast_device_status
                _broadcast_device_status(device, 'busy')
            except Exception:
                logger.warning("[Device] mark_busy broadcast failed: %s", device_id, exc_info=True)
        return updated > 0

    @classmethod
    def mark_idle(cls, device_id: str) -> bool:
        """将 busy 设备恢复为 online。"""
        updated = Device.objects.filter(
            id=device_id, status='busy',
        ).update(status='online')
        if updated:
            try:
                device = Device.objects.select_related('organization').get(id=device_id)
                from apps.services.common.ws.device_broadcast import _broadcast_device_status
                _broadcast_device_status(device, 'online')
            except Exception:
                logger.warning("[Device] mark_idle broadcast failed: %s", device_id, exc_info=True)
        return updated > 0

    @classmethod
    def get_bound_device_id(cls, space) -> str | None:
        """获取 Space 绑定的 Daemon 设备 ID。"""
        device = resolve_control_device(space=space)
        if device and getattr(device, 'device_type', None) in DEVICE_RUNTIME_TYPES:
            return str(device.id)
        return None

    @classmethod
    def mark_idle_if_bound(cls, space) -> None:
        """若 Space 绑定了 Daemon，将其从 busy 恢复为 online。"""
        try:
            device_id = cls.get_bound_device_id(space)
            if device_id:
                cls.mark_idle(device_id)
        except Exception:
            logger.debug("[Device] mark_idle_if_bound failed", exc_info=True)
