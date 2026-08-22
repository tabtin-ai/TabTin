"""
Space 级只读数据库连接模型

每个 Space 可创建一个只读 PostgreSQL 连接（自动创建 PG ROLE），
供外部 BI 工具（Metabase / Grafana）或 Agent 直接 SQL 查询。
"""
import uuid
import secrets

from django.conf import settings
from django.db import models


class DbReadOnlyConnection(models.Model):
    """只读数据库连接"""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, verbose_name='ID')

    # 关联 Space（通过 space_id UUID，不建外键约束）
    space_id = models.UUIDField(unique=True, verbose_name='Space ID')

    # 关联用户（创建者）
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name='db_connections',
        verbose_name='创建者',
    )

    # PostgreSQL 角色信息
    pg_role = models.CharField(max_length=80, verbose_name='PG 角色名')
    pg_password_encrypted = models.CharField(
        max_length=256,
        verbose_name='PG 密码（加密存储）',
        help_text='使用 Fernet 对称加密',
    )
    pg_schema = models.CharField(max_length=80, verbose_name='PG Schema')

    # 状态
    is_active = models.BooleanField(default=True, verbose_name='是否激活')

    created_at = models.DateTimeField(auto_now_add=True, verbose_name='创建时间')
    updated_at = models.DateTimeField(auto_now=True, verbose_name='更新时间')

    class Meta:
        db_table = 'tabdata_db_readonly_connection'
        verbose_name = '只读数据库连接'
        verbose_name_plural = '只读数据库连接'

    def __str__(self):
        return f'DbConn({self.pg_role}@{self.pg_schema})'

    # ── 密码加密/解密 ──

    @staticmethod
    def _get_fernet():
        from cryptography.fernet import Fernet
        key = getattr(settings, 'DB_CONNECTION_ENCRYPTION_KEY', None)
        if not key:
            # 回退：用 SECRET_KEY 的前 32 字节 base64
            import base64
            raw = settings.SECRET_KEY[:32].encode()
            key = base64.urlsafe_b64encode(raw.ljust(32, b'\0'))
        return Fernet(key if isinstance(key, bytes) else key.encode())

    def set_password(self, plain_password: str) -> None:
        f = self._get_fernet()
        self.pg_password_encrypted = f.encrypt(plain_password.encode()).decode()

    def get_password(self) -> str:
        f = self._get_fernet()
        return f.decrypt(self.pg_password_encrypted.encode()).decode()

    @staticmethod
    def generate_password() -> str:
        """生成安全的随机密码"""
        return secrets.token_urlsafe(24)

    @staticmethod
    def role_name_for_space(space_id: uuid.UUID) -> str:
        """生成 PG 角色名"""
        return f'ro_as_{space_id.hex[:16]}'

    def get_connection_string(self) -> str:
        """生成完整的 PostgreSQL 连接串"""
        from django.conf import settings as dj_settings
        pg_config = dj_settings.DATABASES.get('postgresql', {})
        host = pg_config.get('HOST', 'localhost')
        port = pg_config.get('PORT', '5432')
        db_name = pg_config.get('NAME', 'postgres')
        password = self.get_password()
        return f'postgresql://{self.pg_role}:{password}@{host}:{port}/{db_name}?options=-c%20search_path%3D{self.pg_schema}'

    def get_connection_params(self) -> dict:
        """返回结构化的连接参数"""
        from django.conf import settings as dj_settings
        pg_config = dj_settings.DATABASES.get('postgresql', {})
        return {
            'host': pg_config.get('HOST', 'localhost'),
            'port': int(pg_config.get('PORT', 5432)),
            'database': pg_config.get('NAME', 'postgres'),
            'username': self.pg_role,
            'password': self.get_password(),
            'schema': self.pg_schema,
        }
