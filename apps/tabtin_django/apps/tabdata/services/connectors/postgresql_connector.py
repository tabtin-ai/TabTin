"""
PostgreSQL 外部数据库连接器

通过 psycopg2 连接外部 PostgreSQL 数据库，支持表发现、列发现和数据查询。

修复：
- DATA-26: 引入 SimpleConnectionPool，避免每次操作新建/销毁物理连接
"""
import logging
from contextlib import contextmanager

from .base import BaseConnector, ExternalTable, ExternalColumn

logger = logging.getLogger(__name__)

_POOL_MIN_CONN = 1
_POOL_MAX_CONN = 4


class PostgreSQLConnector(BaseConnector):
    """PostgreSQL 外部数据库连接器"""

    def __init__(self, config: dict):
        """
        Args:
            config: 连接配置，包含以下键：
                - host: 主机地址
                - port: 端口（默认 5432）
                - database: 数据库名
                - username: 用户名
                - password: 密码
                - ssl_mode: SSL 模式（默认 'prefer'）
                - schema: 目标 Schema（默认 'public'）
        """
        self.config = config
        self._pool = None

    def _connect_kwargs(self) -> dict:
        return dict(
            host=self.config['host'],
            port=self.config.get('port', 5432),
            dbname=self.config['database'],
            user=self.config['username'],
            password=self.config['password'],
            sslmode=self.config.get('ssl_mode', 'prefer'),
            connect_timeout=10,
            options='-c statement_timeout=30000',
        )

    def _get_pool(self):
        """DATA-26: 惰性初始化连接池，复用物理连接。"""
        if self._pool is None:
            from psycopg2.pool import SimpleConnectionPool
            self._pool = SimpleConnectionPool(
                _POOL_MIN_CONN, _POOL_MAX_CONN, **self._connect_kwargs(),
            )
        return self._pool

    @contextmanager
    def _conn(self):
        """连接上下文管理器，正常归还连接池；异常时丢弃坏连接。"""
        pool = self._get_pool()
        conn = pool.getconn()
        exc_occurred = False
        try:
            yield conn
        except Exception:
            exc_occurred = True
            raise
        finally:
            try:
                if exc_occurred:
                    pool.putconn(conn, close=True)
                else:
                    conn.rollback()
                    pool.putconn(conn)
            except Exception:
                try:
                    conn.close()
                except Exception:
                    pass

    def test_connection(self) -> tuple[bool, str]:
        import psycopg2
        try:
            conn = psycopg2.connect(**self._connect_kwargs())
            try:
                with conn.cursor() as cur:
                    cur.execute('SELECT 1')
            finally:
                conn.close()
            return True, '连接成功'
        except Exception as e:
            logger.warning('PostgreSQL connector test failed: %s', e)
            return False, str(e)

    def discover_tables(self) -> list[ExternalTable]:
        target_schema = self.config.get('schema', 'public')
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT t.table_schema, t.table_name,
                           (SELECT reltuples::bigint FROM pg_class
                            WHERE relname = t.table_name AND relnamespace = (
                                SELECT oid FROM pg_namespace WHERE nspname = t.table_schema
                            )) as approx_rows
                    FROM information_schema.tables t
                    WHERE t.table_schema = %s
                      AND t.table_type = 'BASE TABLE'
                    ORDER BY t.table_name
                """, [target_schema])
                rows = cur.fetchall()

        tables = []
        for schema, name, row_count in rows:
            tables.append(ExternalTable(
                schema=schema,
                name=name,
                columns=[],  # 按需通过 discover_columns 填充
                row_count=max(0, row_count) if row_count else None,
            ))
        return tables

    def discover_columns(self, schema: str, table: str) -> list[ExternalColumn]:
        with self._conn() as conn:
            with conn.cursor() as cur:
                # 获取列信息
                cur.execute("""
                    SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
                           c.udt_name
                    FROM information_schema.columns c
                    WHERE c.table_schema = %s AND c.table_name = %s
                    ORDER BY c.ordinal_position
                """, [schema, table])
                cols = cur.fetchall()

                # 获取主键列
                cur.execute("""
                    SELECT kcu.column_name
                    FROM information_schema.table_constraints tc
                    JOIN information_schema.key_column_usage kcu
                        ON tc.constraint_name = kcu.constraint_name
                        AND tc.table_schema = kcu.table_schema
                    WHERE tc.constraint_type = 'PRIMARY KEY'
                      AND tc.table_schema = %s AND tc.table_name = %s
                """, [schema, table])
                pk_cols = {r[0] for r in cur.fetchall()}

        return [
            ExternalColumn(
                name=col_name,
                data_type=udt_name or data_type,
                is_nullable=is_nullable == 'YES',
                is_primary_key=col_name in pk_cols,
                default_value=col_default,
            )
            for col_name, data_type, is_nullable, col_default, udt_name in cols
        ]

    def query(self, schema: str, table: str, columns: list[str] = None,
              filters: list = None, sorts: list = None,
              limit: int = 100, offset: int = 0) -> tuple[list[dict], int]:
        from psycopg2 import sql as psql
        import psycopg2.extras

        # 构建列列表
        if columns:
            col_sql = psql.SQL(', ').join(psql.Identifier(c) for c in columns)
        else:
            col_sql = psql.SQL('*')

        table_ref = psql.SQL('{}.{}').format(
            psql.Identifier(schema),
            psql.Identifier(table),
        )

        # 计数查询
        count_query = psql.SQL('SELECT COUNT(*) FROM {}').format(table_ref)

        # 数据查询
        data_query = psql.SQL('SELECT {} FROM {} LIMIT %s OFFSET %s').format(
            col_sql, table_ref,
        )

        with self._conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(count_query)
                total = cur.fetchone()['count']

                cur.execute(data_query, [limit, offset])
                rows = cur.fetchall()

        return [dict(r) for r in rows], total

    def close(self):
        """DATA-26: 释放连接池中所有物理连接。"""
        if self._pool is not None:
            try:
                self._pool.closeall()
            except Exception as exc:
                logger.debug("关闭 PostgreSQL 连接池异常: %s", exc)
            finally:
                self._pool = None
