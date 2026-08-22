"""
工具函数
"""

import hashlib
import json
import logging
import secrets
import string
from datetime import datetime, timedelta
from django.utils import timezone
from django.core.cache import cache
from django_redis import get_redis_connection
from django.conf import settings
import jwt


def generate_verification_code(length=6):
    """生成数字验证码"""
    return ''.join(secrets.choice(string.digits) for _ in range(length))


def generate_random_string(length=32):
    """生成随机字符串"""
    alphabet = string.ascii_letters + string.digits
    return ''.join(secrets.choice(alphabet) for _ in range(length))


def hash_string(text):
    """对字符串进行SHA256哈希"""
    return hashlib.sha256(text.encode()).hexdigest()


def log_security_event(event, request=None, user=None, success=True, reason="", extra=None):
    """记录结构化安全事件日志"""
    logger = logging.getLogger("auth.security")
    payload = {
        "event": event,
        "success": success,
        "reason": reason,
    }
    if user:
        payload["user_id"] = str(user.id)
    if request is not None:
        payload["ip"] = get_client_ip(request)
        payload["user_agent"] = get_user_agent(request)
    if extra:
        payload.update(extra)
    logger.info(json.dumps(payload, ensure_ascii=False))


def mask_email(email):
    """邮箱脱敏显示"""
    if not email or '@' not in email:
        return email

    local, domain = email.split('@', 1)
    if len(local) <= 2:
        masked_local = local[0] + '*' * (len(local) - 1)
    else:
        masked_local = local[0] + '*' * (len(local) - 2) + local[-1]

    return f"{masked_local}@{domain}"


def mask_phone(phone):
    """手机号脱敏显示"""
    if not phone or len(phone) < 7:
        return phone

    return f"{phone[:3]}****{phone[-4:]}"


def mask_identifier(identifier: str) -> str:
    """对用户标识符（邮箱/手机号）进行脱敏"""
    if not identifier:
        return identifier
    return mask_email(identifier) if '@' in identifier else mask_phone(identifier)


def get_client_ip(request):
    """
    获取客户端IP地址。

    安全策略由 settings.TRUSTED_PROXY_COUNT 控制（默认 0）：
    - 0：忽略 X-Forwarded-For，仅返回 REMOTE_ADDR（无反向代理 / 代理已覆写 REMOTE_ADDR）
    - N>0：从 X-Forwarded-For 右起第 N 个 IP 为客户端真实 IP（右侧为受信代理所追加）
    """
    trusted_proxy_count = getattr(settings, 'TRUSTED_PROXY_COUNT', 0)

    if trusted_proxy_count > 0:
        xff = request.META.get('HTTP_X_FORWARDED_FOR')
        if xff:
            ips = [ip.strip() for ip in xff.split(',')]
            idx = len(ips) - trusted_proxy_count
            if 0 <= idx < len(ips):
                return ips[idx]

    return request.META.get('REMOTE_ADDR')


def get_user_agent(request):
    """获取用户代理信息"""
    return request.META.get('HTTP_USER_AGENT', '')


def parse_user_agent(user_agent):
    """解析用户代理信息"""
    # 简单的用户代理解析
    info = {
        'browser': 'Unknown',
        'os': 'Unknown',
        'device': 'Unknown'
    }

    if not user_agent:
        return info

    user_agent = user_agent.lower()

    # 浏览器检测
    if 'chrome' in user_agent:
        info['browser'] = 'Chrome'
    elif 'firefox' in user_agent:
        info['browser'] = 'Firefox'
    elif 'safari' in user_agent:
        info['browser'] = 'Safari'
    elif 'edge' in user_agent:
        info['browser'] = 'Edge'

    # 操作系统检测
    if 'windows' in user_agent:
        info['os'] = 'Windows'
    elif 'mac' in user_agent:
        info['os'] = 'macOS'
    elif 'linux' in user_agent:
        info['os'] = 'Linux'
    elif 'android' in user_agent:
        info['os'] = 'Android'
    elif 'ios' in user_agent:
        info['os'] = 'iOS'

    # 设备类型检测
    if 'mobile' in user_agent:
        info['device'] = 'Mobile'
    elif 'tablet' in user_agent:
        info['device'] = 'Tablet'
    else:
        info['device'] = 'Desktop'

    return info


# 注意: 验证码管理已迁移到 VerificationCodeManager
# 旧的验证码缓存方法已废弃，请使用 apps.users.auth.verification_manager.VerificationCodeManager


def _ensure_str(token):
    """确保JWT编码结果为字符串，兼容PyJWT不同版本"""
    return token.decode('utf-8') if isinstance(token, bytes) else token


def generate_jwt_token(user, expire_hours=24, token_type='access', session_key=None, remember_me=None):
    """
    生成JWT Token

    Args:
        user: 用户对象
        expire_hours: 过期时间（小时）
        token_type: Token类型，'access' 或 'refresh'
        session_key: 绑定的会话Key（用于会话失效）
        remember_me: 是否为“记住我”长期会话

    Returns:
        str: JWT Token字符串
    """
    payload = {
        'user_id': str(user.id),
        'token_type': token_type,  # 标识token类型
        'exp': timezone.now() + timedelta(hours=expire_hours),
        'iat': timezone.now(),
    }

    if session_key:
        payload['sid'] = session_key

    if remember_me is not None:
        payload['remember_me'] = bool(remember_me)

    return _ensure_str(jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm='HS256'))


def verify_jwt_token(token, *, secret_key=None):
    """验证JWT Token。

    Args:
        token: JWT 字符串。
        secret_key: 指定签名密钥（用于 Centrifugo 等需要密钥隔离的场景）；
                    不传则使用默认 JWT_SECRET_KEY。
    """
    try:
        if secret_key is None:
            secret_key = settings.JWT_SECRET_KEY
        payload = jwt.decode(token, secret_key, algorithms=['HS256'])
        return payload
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None


def generate_password_reset_token(user):
    """生成密码重置Token"""
    payload = {
        'user_id': str(user.id),
        'action': 'password_reset',
        'exp': timezone.now() + timedelta(hours=1),  # 1小时过期
        'iat': timezone.now(),
    }

    return _ensure_str(jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm='HS256'))


def verify_password_reset_token(token):
    """验证密码重置Token"""
    try:
        payload = jwt.decode(token, settings.JWT_SECRET_KEY, algorithms=['HS256'])

        if payload.get('action') != 'password_reset':
            return None

        return payload
    except jwt.ExpiredSignatureError:
        return None
    except jwt.InvalidTokenError:
        return None


def is_strong_password(password):
    """检查密码强度"""
    if len(password) < 8:
        return False

    # 含任意空白字符直接判不合格，与 validate_user_password 的禁空白口径一致。
    if any(c.isspace() for c in password):
        return False

    has_upper = any(c.isupper() for c in password)
    has_lower = any(c.islower() for c in password)
    has_digit = any(c.isdigit() for c in password)
    # ：与 validate_user_password / 前端 passwordHasSpecialChar 对齐
    has_special = any(not c.isalnum() and not c.isspace() for c in password)

    return sum([has_upper, has_lower, has_digit, has_special]) >= 3


def get_password_strength_score(password):
    """获取密码强度评分（0-100）"""
    if not password:
        return 0

    score = 0

    # 长度评分
    if len(password) >= 8:
        score += 25
    elif len(password) >= 6:
        score += 15
    elif len(password) >= 4:
        score += 10

    # 字符类型评分
    if any(c.isupper() for c in password):
        score += 15
    if any(c.islower() for c in password):
        score += 15
    if any(c.isdigit() for c in password):
        score += 15
    if any(not c.isalnum() and not c.isspace() for c in password):
        score += 20

    # 长度奖励
    if len(password) >= 12:
        score += 10

    return min(score, 100)


def format_datetime(dt, format_str='%Y-%m-%d %H:%M:%S'):
    """格式化日期时间"""
    if not dt:
        return ''
    return dt.strftime(format_str)


def time_ago(dt):
    """计算时间差（多久之前）"""
    if not dt:
        return ''

    now = timezone.now()
    diff = now - dt

    if diff.days > 0:
        return f"{diff.days}天前"
    elif diff.seconds > 3600:
        hours = diff.seconds // 3600
        return f"{hours}小时前"
    elif diff.seconds > 60:
        minutes = diff.seconds // 60
        return f"{minutes}分钟前"
    else:
        return "刚刚"


def check_login_rate_limit(username, ip_address=None):
    """
    检查登录频率限制（防暴力破解）。
    仅检查是否超限，不递增计数器；登录失败后应调用 record_rate_limit_hit("login", ...) 递增。
    """
    return check_rate_limit("login", username, ip_address, check_only=True)


def check_password_reset_rate_limit(username, ip_address=None):
    """检查密码重置频率限制"""
    return check_rate_limit("password_reset", username, ip_address)


def check_verification_code_rate_limit(username, ip_address=None):
    """检查验证码发送频率限制"""
    return check_rate_limit("verification_code", username, ip_address)


def _get_rate_limit_config(scope):
    defaults = {
        "login": {
            "per_identifier_hour": 10,    # 同一账号每小时最多 10 次失败
            "per_identifier_day": 30,     # 同一账号每天最多 30 次失败
            "per_ip_hour": 30,            # 同一 IP 每小时最多 30 次失败
            "per_ip_day": 100,            # 同一 IP 每天最多 100 次失败
            "per_pair_hour": 10,          # 同一 IP+账号 组合每小时最多 10 次
            "per_pair_day": 30,           # 同一 IP+账号 组合每天最多 30 次
        },
        "verification_code": {
            "per_identifier_hour": 10,
            "per_identifier_day": 50,
            "per_ip_hour": 30,
            "per_ip_day": 200,
            "per_pair_hour": 10,
            "per_pair_day": 50,
        },
        "password_reset": {
            "per_identifier_hour": 5,
            "per_identifier_day": 20,
            "per_ip_hour": 20,
            "per_ip_day": 100,
            "per_pair_hour": 5,
            "per_pair_day": 20,
        }
    }
    config = getattr(settings, "AUTH_RATE_LIMITS", {})
    merged = defaults.get(scope, {}).copy()
    merged.update(config.get(scope, {}) or {})
    return merged


def _format_rate_limit_message(scope, window_seconds):
    if scope == "login":
        base = "登录尝试过于频繁"
    elif scope == "verification_code":
        base = "验证码请求过于频繁"
    elif scope == "password_reset":
        base = "密码重置请求过于频繁"
    else:
        base = "请求过于频繁"

    if window_seconds >= 86400:
        return f"{base}，请明天再试"
    if window_seconds >= 3600:
        return f"{base}，请1小时后再试"
    return f"{base}，请稍后再试"


def _build_rate_limit_checks(scope, identifier=None, ip_address=None):
    """构建限流检查项列表（内部复用）"""
    config = _get_rate_limit_config(scope)
    checks = []

    def add_check(kind, key_suffix, limit, window_seconds):
        if limit is None or limit <= 0:
            return
        cache_key = f"rate_limit:{scope}:{kind}:{key_suffix}:{window_seconds}"
        checks.append((cache_key, limit, window_seconds))

    id_hash = hash_string(identifier) if identifier else None
    ip_hash = hash_string(ip_address) if ip_address else None

    if identifier:
        add_check("identifier", id_hash, config.get("per_identifier_hour"), 3600)
        add_check("identifier", id_hash, config.get("per_identifier_day"), 86400)
    if ip_address:
        add_check("ip", ip_hash, config.get("per_ip_hour"), 3600)
        add_check("ip", ip_hash, config.get("per_ip_day"), 86400)
    if identifier and ip_address:
        pair_key = hash_string(f"{identifier}|{ip_address}")
        add_check("pair", pair_key, config.get("per_pair_hour"), 3600)
        add_check("pair", pair_key, config.get("per_pair_day"), 86400)

    return checks


def check_rate_limit(scope, identifier=None, ip_address=None, check_only=False):
    """
    统一限流检查（账号/IP/账号+IP）

    Args:
        scope: 限流范围（login / verification_code / password_reset）
        identifier: 用户标识（邮箱/手机号/用户名）
        ip_address: 客户端 IP 地址
        check_only: 仅检查是否超限，不递增计数器。
                     适用于"登录"等场景——仅在失败时才调用 record_rate_limit_hit 递增。
    """
    checks = _build_rate_limit_checks(scope, identifier, ip_address)

    for cache_key, limit, window_seconds in checks:
        attempts = cache.get(cache_key, 0)
        if attempts >= limit:
            return False, _format_rate_limit_message(scope, window_seconds)

    if not check_only:
        _atomic_incr_rate_limit(checks)

    return True, ""


def record_rate_limit_hit(scope, identifier=None, ip_address=None):
    """
    仅递增限流计数器（不做检查）。
    用于 check_rate_limit(check_only=True) 之后，仅在操作失败时手动递增。
    """
    checks = _build_rate_limit_checks(scope, identifier, ip_address)
    _atomic_incr_rate_limit(checks, fail_close=(scope in ('login', 'password_reset')))


def _atomic_incr_rate_limit(checks, *, fail_close: bool = False):
    """原子递增限流计数器（CA-17: 使用 Redis INCR + EXPIRE 消除竞态窗口）。"""
    try:
        conn = get_redis_connection("default")
        pipe = conn.pipeline()
        for cache_key, _, window_seconds in checks:
            pipe.incr(cache_key)
            pipe.expire(cache_key, window_seconds)
        pipe.execute()
    except Exception:
        if fail_close:
            raise
        for cache_key, _, window_seconds in checks:
            if cache.add(cache_key, 0, window_seconds):
                pass
            try:
                cache.incr(cache_key)
            except ValueError:
                cache.set(cache_key, 1, window_seconds)


def check_simple_rate_limit(
    cache_key: str,
    max_count: int,
    window_seconds: int,
    *,
    fail_close: bool = False,
) -> bool:
    """简易滑动窗口限流：Redis INCR+EXPIRE 原子操作，cache 降级。

    返回 True = 允许通过，False = 超限。
    fail_close=True 时 Redis 不可用直接拒绝（安全敏感场景）。
    """
    try:
        conn = get_redis_connection("default")
        pipe = conn.pipeline()
        pipe.incr(cache_key)
        pipe.expire(cache_key, window_seconds)
        result = pipe.execute()
        return result[0] <= max_count
    except Exception:
        if fail_close:
            return False
        if cache.add(cache_key, 0, window_seconds):
            pass
        try:
            current = cache.incr(cache_key)
        except ValueError:
            cache.set(cache_key, 1, window_seconds)
            current = 1
        return current <= max_count


def is_suspicious_password_reset_activity(username, ip_address):
    """检测可疑的密码重置活动（原子计数，无竞态窗口）"""
    try:
        conn = get_redis_connection("default")
    except Exception:
        return True, "系统繁忙，请稍后再试"

    ip_key = f"password_reset_ip:{hash_string(ip_address)}"
    ip_count = conn.incr(ip_key)
    if ip_count == 1:
        conn.expire(ip_key, 3600)
    if ip_count > 20:
        return True, "检测到可疑活动，请稍后再试"

    user_key = f"password_reset_user:{hash_string(username)}"
    user_count = conn.incr(user_key)
    if user_count == 1:
        conn.expire(user_key, 24 * 3600)
    if user_count > 3:
        return True, "账号安全风险，请联系客服"

    return False, ""


def validate_password_reset_context(username, user_agent, ip_address):
    """验证密码重置的上下文信息"""
    # 检查User-Agent是否正常
    if not user_agent or len(user_agent) < 10:
        return False, "请求异常，请使用正常浏览器访问"

    # 检查是否为常见的恶意User-Agent
    malicious_patterns = [
        'curl', 'wget', 'python', 'bot', 'crawler', 'spider'
    ]
    user_agent_lower = user_agent.lower()
    for pattern in malicious_patterns:
        if pattern in user_agent_lower:
            return False, "检测到自动化请求，请使用浏览器访问"

    return True, ""
