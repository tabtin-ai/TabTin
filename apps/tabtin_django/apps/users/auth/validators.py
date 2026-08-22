"""
数据验证器
"""

import re
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.contrib.auth.password_validation import validate_password
from django.contrib.auth import get_user_model
from django.utils.translation import gettext_lazy as _

User = get_user_model()


PHONE_REGEX = r'^\+?[1-9]\d{6,14}$'


def validate_phone_number(phone):
    """验证手机号格式（E.164 简化版：可选+前缀，1-9开头，总长7-15位）"""
    if not phone:
        return

    if not re.match(PHONE_REGEX, phone):
        raise ValidationError(_('请输入有效的手机号码'))


def is_phone_number(value):
    """判断字符串是否为手机号格式"""
    return bool(re.match(PHONE_REGEX, value))


def validate_username(username):
    """验证用户名格式"""
    if not username:
        return

    # 用户名规则：3-20位，只能包含字母、数字、下划线
    if len(username) < 3 or len(username) > 20:
        raise ValidationError('用户名长度必须在3-20位之间')

    pattern = r'^[a-zA-Z0-9_]+$'
    if not re.match(pattern, username):
        raise ValidationError('用户名只能包含字母、数字和下划线')

    # 检查是否以数字开头
    if username[0].isdigit():
        raise ValidationError('用户名不能以数字开头')

    # 检查保留用户名
    reserved_usernames = [
        'admin', 'root', 'api', 'www', 'mail', 'ftp', 'test',
        'user', 'guest', 'public', 'system', 'support', 'help'
    ]
    if username.lower() in reserved_usernames:
        raise ValidationError('该用户名为系统保留，请选择其他用户名')


def validate_nickname(nickname):
    """验证昵称格式"""
    if not nickname:
        return

    if len(nickname) > 50:
        raise ValidationError('昵称长度不能超过50个字符')

    # 检查是否包含特殊字符
    forbidden_chars = ['<', '>', '"', "'", '&', '\n', '\r', '\t']
    for char in forbidden_chars:
        if char in nickname:
            raise ValidationError('昵称不能包含特殊字符')


# ：禁止把中文散文（如 Agent 报错）粘进密码；与前端 passwordContainsCjk 对齐。
_PASSWORD_CJK_RE = re.compile(r'[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]')


def _password_has_special_char(password: str) -> bool:
    """特殊字符：非字母/非数字/非空白（，对齐前端 passwordHasSpecialChar）。"""
    return any(not c.isalnum() and not c.isspace() for c in password)


def validate_user_password(password, user=None):
    """验证密码强度"""
    if not password:
        raise ValidationError('密码不能为空')

    # 禁止任何空白字符（空格 / Tab / 换行等）：设密 / 改密 / 重置一律不允许。
    # 用 isspace() 覆盖全部空白，与前端共享校验口径一致；登录的 check_password
    # 精确匹配不走此校验，故存量带空白密码的用户仍可正常登录。
    if any(c.isspace() for c in password):
        raise ValidationError('密码不能包含空格')

    # ：CJK 汉字不允许出现在新密码里，避免剪贴板报错文案被当成密码。
    if _PASSWORD_CJK_RE.search(password):
        raise ValidationError('密码不能包含中日韩文字，请勿粘贴其他内容')

    # 使用Django内置密码验证
    try:
        validate_password(password, user)
    except ValidationError as e:
        raise ValidationError(e.messages)

    # 额外的密码规则
    if len(password) < 8:
        raise ValidationError('密码长度至少8位')

    if len(password) > 128:
        raise ValidationError('密码长度不能超过128位')

    # 检查密码复杂度
    has_upper = any(c.isupper() for c in password)
    has_lower = any(c.islower() for c in password)
    has_digit = any(c.isdigit() for c in password)
    has_special = _password_has_special_char(password)

    complexity_count = sum([has_upper, has_lower, has_digit, has_special])
    if complexity_count < 3:
        raise ValidationError('密码必须包含大写字母、小写字母、数字、特殊字符中的至少3种')


def validate_unique_email(email, user_id=None):
    """验证邮箱唯一性"""
    if not email:
        return

    # 验证邮箱格式
    try:
        validate_email(email)
    except ValidationError:
        raise ValidationError('邮箱格式不正确')

    # 检查邮箱是否已存在
    queryset = User.objects.filter(email=email)
    if user_id:
        queryset = queryset.exclude(id=user_id)

    if queryset.exists():
        raise ValidationError('该邮箱已被注册')


def validate_unique_phone(phone, user_id=None):
    """验证手机号唯一性（含 +86 / 11 位等价格式）"""
    if not phone:
        return

    # 验证手机号格式
    validate_phone_number(phone)

    from .phone import phone_alias_exists

    if phone_alias_exists(phone, exclude_user_id=user_id):
        raise ValidationError('该手机号已被注册')


def validate_unique_username(username, user_id=None):
    """验证用户名唯一性"""
    if not username:
        return

    # 验证用户名格式
    validate_username(username)

    # 检查用户名是否已存在
    queryset = User.objects.filter(username=username)
    if user_id:
        queryset = queryset.exclude(id=user_id)

    if queryset.exists():
        raise ValidationError('该用户名已被使用')


def validate_verification_code(code):
    """验证验证码格式"""
    if not code:
        raise ValidationError('验证码不能为空')

    if not code.isdigit():
        raise ValidationError('验证码只能包含数字')

    if len(code) != 6:
        raise ValidationError('验证码必须是6位数字')


def validate_bio(bio):
    """验证个人简介"""
    if not bio:
        return

    if len(bio) > 500:
        raise ValidationError('个人简介不能超过500个字符')

    # 检查是否包含敏感词（简单示例）
    sensitive_words = ['广告', '推广', '加微信', 'QQ群']
    for word in sensitive_words:
        if word in bio:
            raise ValidationError(f'个人简介不能包含敏感词：{word}')
