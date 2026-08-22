"""
统一的会话管理器
解决会话创建、验证、清理的一致性问题
"""

import secrets
import logging
from datetime import timedelta
from django.utils import timezone
from django.db import OperationalError, transaction
from .models import UserSession
from .utils import hash_string, get_client_ip, get_user_agent, parse_user_agent

logger = logging.getLogger(__name__)

_SESSION_KEY_HASH_LEN = 64
MAX_ACTIVE_SESSIONS = 10
LAST_ACTIVITY_TOUCH_INTERVAL = timedelta(seconds=30)


def _is_lock_contention(exc: BaseException) -> bool:
    message = str(exc).lower()
    return "lock timeout" in message or "deadlock detected" in message


class SessionManager:
    """统一的会话管理器"""

    @staticmethod
    def hash_session_key(session_key: str) -> str:
        """对会话密钥做 SHA-256 哈希，截断至 DB 字段长度（公开方法，供外部直接查询时使用）"""
        return hash_string(session_key)[:_SESSION_KEY_HASH_LEN]

    @staticmethod
    def create_session(user, request, session_type='web', expire_hours=24):
        """
        创建用户会话

        DB 中仅存储 session_key 的 SHA-256 哈希；返回的 session 对象上
        session_key 属性为明文，供调用方嵌入 JWT。调用方对该对象做
        save() 时必须使用 update_fields 以避免将明文回写 DB。

        Args:
            user: 用户对象
            request: HTTP请求对象
            session_type: 会话类型 ('web', 'mobile', 'api')
            expire_hours: 过期小时数

        Returns:
            UserSession: 创建的会话对象（session_key 为明文）
        """
        try:
            with transaction.atomic():
                raw_key = SessionManager._generate_session_key()
                hashed_key = SessionManager.hash_session_key(raw_key)

                device_info = parse_user_agent(get_user_agent(request))
                device_id, client_type = SessionManager._resolve_client_metadata(
                    request=request,
                    session_type=session_type,
                    device_info=device_info,
                )
                expires_at = timezone.now() + timedelta(hours=expire_hours)

                logger.info("创建会话: user_id=%s, expires=%sh", user.id, expire_hours)

                # 清理发生在新会话创建前，需为本次登录预留一个名额。
                SessionManager._cleanup_old_sessions(
                    user,
                    keep_recent=MAX_ACTIVE_SESSIONS - 1,
                )

                session = UserSession.objects.create(
                    user=user,
                    session_key=hashed_key,
                    session_type=session_type,
                    ip_address=get_client_ip(request),
                    user_agent=get_user_agent(request),
                    device_info=device_info,
                    device_id=device_id,
                    client_type=client_type,
                    revoked_by_admin_account_id='',
                    revoked_reason='',
                    expires_at=expires_at,
                    is_active=True,
                )

                # 内存中恢复明文，供调用方嵌入 JWT（DB 只存哈希）
                session.session_key = raw_key

                logger.info("会话创建成功: session_id=%s, user=%s", session.id, user.username)
                return session

        except Exception as e:
            logger.error("会话创建失败: user_id=%s, error=%s", user.id, e)
            raise

    @staticmethod
    def _generate_session_key():
        """生成高熵会话密钥（256 bits）"""
        return secrets.token_hex(32)

    @staticmethod
    def _resolve_client_metadata(request, session_type, device_info):
        """解析客户端会话元数据，兼容旧客户端未传头的登录请求。"""
        device_id = (
            request.META.get('HTTP_X_DEVICE_ID')
            or request.META.get('HTTP_X_TABTIN_DEVICE_ID')
            or device_info.get('device_id')
            or ''
        )
        client_type = (
            request.META.get('HTTP_X_CLIENT_TYPE')
            or request.META.get('HTTP_X_TABTIN_CLIENT_TYPE')
            or session_type
            or 'web'
        )
        return device_id, client_type

    @staticmethod
    def _cleanup_old_sessions(user, keep_recent):
        """
        清理用户的旧会话（CA-24: select_for_update 消除 count-to-slice 竞态）

        必须在 transaction.atomic() 上下文内调用。

        Args:
            user: 用户对象
            keep_recent: 保留最近的会话数量
        """
        try:
            active_sessions = (
                UserSession.objects
                .select_for_update()
                .filter(user=user, is_active=True)
                .order_by('-created_at')
            )

            session_ids = list(active_sessions.values_list('id', flat=True))
            if len(session_ids) > keep_recent:
                old_ids = session_ids[keep_recent:]
                UserSession.objects.filter(id__in=old_ids).update(is_active=False)
                logger.info("清理旧会话: user=%s, 清理数量=%d", user.username, len(old_ids))

        except Exception as e:
            logger.error("清理旧会话失败: user_id=%s, error=%s", user.id, e)

    @staticmethod
    def rotate_session(old_session_key: str, user, request,
                       session_type: str = 'web', expire_hours: int = 24):
        """轮换会话：原子地吊销旧 session 并创建新 session。

        Token refresh 时调用，确保旧 access token（携带旧 sid）立即失效，
        符合 CA-1「refresh 后立即吊销旧凭据」语义。

        Returns:
            UserSession: 新创建的会话对象（session_key 为明文）
        """
        try:
            with transaction.atomic():
                if old_session_key:
                    hashed_old = SessionManager.hash_session_key(old_session_key)
                    invalidated = UserSession.objects.filter(
                        session_key=hashed_old,
                        is_active=True,
                    ).update(is_active=False)
                    if invalidated:
                        logger.info(
                            "rotate_session: 旧 session 已吊销 user=%s",
                            user.id,
                        )

                raw_key = SessionManager._generate_session_key()
                hashed_key = SessionManager.hash_session_key(raw_key)

                device_info = parse_user_agent(get_user_agent(request))
                device_id, client_type = SessionManager._resolve_client_metadata(
                    request=request,
                    session_type=session_type,
                    device_info=device_info,
                )
                expires_at = timezone.now() + timedelta(hours=expire_hours)

                # 轮换已先吊销旧会话，仍为即将创建的新会话预留一个名额。
                SessionManager._cleanup_old_sessions(
                    user,
                    keep_recent=MAX_ACTIVE_SESSIONS - 1,
                )

                session = UserSession.objects.create(
                    user=user,
                    session_key=hashed_key,
                    session_type=session_type,
                    ip_address=get_client_ip(request),
                    user_agent=get_user_agent(request),
                    device_info=device_info,
                    device_id=device_id,
                    client_type=client_type,
                    revoked_by_admin_account_id='',
                    revoked_reason='',
                    expires_at=expires_at,
                    is_active=True,
                )

                session.session_key = raw_key

                logger.info(
                    "rotate_session: 新 session 已创建 session_id=%s, user=%s",
                    session.id, user.username,
                )
                return session

        except Exception as e:
            logger.error("rotate_session 失败: user_id=%s, error=%s", user.id, e)
            raise

    @staticmethod
    def validate_session(session_key):
        """
        验证会话是否有效

        过期 / 吊销标记在 transaction.atomic() 内用条件 UPDATE 完成，
        避免与 invalidate_session 竞态写入。last_activity 是旁路记账，
        在事务外节流更新；写锁超时不得把有效会话判成未登录。

        Args:
            session_key: 明文会话键（来自 JWT sid）

        Returns:
            UserSession or None: 有效的会话对象（session_key 属性为明文）或 None
        """
        try:
            hashed_key = SessionManager.hash_session_key(session_key)

            with transaction.atomic():
                session = UserSession.objects.select_related('user').get(
                    session_key=hashed_key,
                    is_active=True
                )

                if session.is_expired():
                    # CR-015: 条件 UPDATE 替代 instance.save()，
                    # 多并发请求仅首个匹配行被更新，其余为空操作（幂等）
                    UserSession.objects.filter(
                        pk=session.pk, is_active=True
                    ).update(is_active=False)
                    logger.info("会话已过期: session_id=%s", session.id)
                    return None

                if session.revoked_at:
                    UserSession.objects.filter(
                        pk=session.pk, is_active=True
                    ).update(is_active=False)
                    logger.info("会话已被后台吊销: session_id=%s", session.id)
                    return None

                device_identifier = session.device_id or (session.device_info or {}).get("device_id")
                if device_identifier:
                    from apps.tabtinspace.services.device_control_guard import is_device_blocked
                    if is_device_blocked(device_identifier):
                        logger.info(
                            "设备已封禁，会话拒绝: session_id=%s device=%s",
                            session.id,
                            device_identifier,
                        )
                        return None

            # last_activity 是旁路记账，失败不能让有效会话变成未登录。
            # 写操作放到校验事务外，避免 UPDATE 锁超时把整段 atomic 打成 aborted。

            session.session_key = session_key
            SessionManager._touch_last_activity(session)
            return session

        except UserSession.DoesNotExist:
            return None
        except OperationalError as e:
            if _is_lock_contention(e):
                logger.warning("会话验证锁超时: error=%s", e)
                return None
            logger.error("会话验证失败: error=%s", e)
            return None
        except Exception as e:
            logger.error("会话验证失败: error=%s", e)
            return None

    @staticmethod
    def _touch_last_activity(session):
        """Best-effort last_activity 更新；锁竞争时跳过，不失败校验。"""
        now = timezone.now()
        last = session.last_activity
        if last and (now - last) < LAST_ACTIVITY_TOUCH_INTERVAL:
            return
        try:
            UserSession.objects.filter(
                pk=session.pk, is_active=True
            ).update(last_activity=now)
        except OperationalError as exc:
            if _is_lock_contention(exc):
                logger.warning(
                    "会话活跃时间更新跳过: session_id=%s error=%s",
                    session.id, exc,
                )
                return
            raise

    @staticmethod
    def validate_session_for_refresh(session_key):
        """
        验证会话并加行排他锁，专用于 refresh token 流程的 TOCTOU 保护。

        **必须在 transaction.atomic() 上下文内调用。**

        与 validate_session() 的区别：
        - 使用 select_for_update() 防止并发读后写竞态（CR-002）
        - 不自动更新 last_activity（由调用方在同一事务中通过 UPDATE 统一处理）

        Args:
            session_key: 明文会话键

        Returns:
            UserSession or None: 锁定的会话对象（session_key 为明文）或 None
        """
        try:
            hashed_key = SessionManager.hash_session_key(session_key)
            session = (
                UserSession.objects
                .select_for_update()
                .select_related('user')
                .get(session_key=hashed_key, is_active=True)
            )

            if session.is_expired():
                UserSession.objects.filter(
                    pk=session.pk, is_active=True
                ).update(is_active=False)
                logger.info("refresh 校验 session 已过期: session_id=%s", session.id)
                return None

            if session.revoked_at:
                UserSession.objects.filter(
                    pk=session.pk, is_active=True
                ).update(is_active=False)
                logger.info("refresh 校验 session 已吊销: session_id=%s", session.id)
                return None

            device_identifier = session.device_id or (session.device_info or {}).get("device_id")
            if device_identifier:
                from apps.tabtinspace.services.device_control_guard import is_device_blocked
                if is_device_blocked(device_identifier):
                    logger.info(
                        "refresh 校验设备已封禁: session_id=%s device=%s",
                        session.id,
                        device_identifier,
                    )
                    return None

            session.session_key = session_key
            return session

        except UserSession.DoesNotExist:
            return None
        except Exception as e:
            logger.error("validate_session_for_refresh 失败: error=%s", e)
            return None

    @staticmethod
    def check_session_active(session_id) -> bool:
        """
        轻量级 session 存活检查，供长时运行操作（AI 生成、Celery 任务等）
        在执行过程中周期性调用，以感知 session 是否被撤销。

        仅做条件读取，不更新 last_activity，不加锁。

        Args:
            session_id: UserSession 主键

        Returns:
            bool: session 仍然活跃且未过期返回 True，否则 False
        """
        try:
            return UserSession.objects.filter(
                pk=session_id,
                is_active=True,
                expires_at__gt=timezone.now(),
            ).exists()
        except Exception as e:
            logger.error("session 存活检查失败: session_id=%s, error=%s", session_id, e)
            return False

    @staticmethod
    def invalidate_session(session_key):
        """
        使会话失效

        Args:
            session_key: 明文会话键（来自 JWT sid 或 session 对象的内存属性）

        Returns:
            bool: 是否成功
        """
        try:
            hashed_key = SessionManager.hash_session_key(session_key)
            updated = UserSession.objects.filter(
                session_key=hashed_key,
                is_active=True
            ).update(is_active=False)

            if updated:
                logger.info("会话已失效")
                return True
            else:
                logger.warning("会话不存在或已失效")
                return False

        except Exception as e:
            logger.error("会话失效失败: error=%s", e)
            return False

    @staticmethod
    def invalidate_all_user_sessions(user_id) -> int:
        """
        使指定用户的所有活跃会话失效（用于账号禁用场景）

        Args:
            user_id: 用户 ID

        Returns:
            int: 被失效的会话数量
        """
        try:
            count = UserSession.objects.filter(
                user_id=user_id,
                is_active=True,
            ).update(is_active=False)
            if count:
                logger.info("批量失效用户会话: user_id=%s, count=%d", user_id, count)
            return count
        except Exception as e:
            logger.error("批量失效用户会话失败: user_id=%s, error=%s", user_id, e)
            return 0

    @staticmethod
    def cleanup_expired_sessions():
        """清理所有过期的会话（定时任务使用）"""
        try:
            expired_count = UserSession.objects.filter(
                expires_at__lt=timezone.now(),
                is_active=True
            ).update(is_active=False)

            logger.info("清理过期会话: 数量=%d", expired_count)
            return expired_count

        except Exception as e:
            logger.error("清理过期会话失败: error=%s", e)
            return 0

    @staticmethod
    def get_user_sessions(user, active_only=True):
        """
        获取用户的会话列表

        Args:
            user: 用户对象
            active_only: 是否只返回活跃会话

        Returns:
            QuerySet: 会话查询集
        """
        queryset = UserSession.objects.filter(user=user)
        if active_only:
            queryset = queryset.filter(is_active=True)

        return queryset.order_by('-last_activity')
