"""FTS App 配置（Wave 1：已挂 signals）。

执行规则：
    1. ready() 中**无条件** 注册 signal handler（见 `apps.fts.signals`），
       与 `SEARCH_ENGINE_ENABLED` 解耦；flag 切换后立刻开始/停止写 outbox。
    2. handler 内部按 `SEARCH_ENGINE_ENABLED` gate：
           if not is_engine_enabled():
               return
    3. handler 用 `transaction.on_commit(...)` 包装 Celery 入队，
       避免事务未提交就发起索引（PRD 4.3.A）。
    4. Outbox 写入在 signal 的同一事务内（ORM create，不 on_commit），
       保证一致性（PRD 4.3.B Outbox Pattern）。
"""

from django.apps import AppConfig


class FtsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.fts"
    label = "fts"
    verbose_name = "TabTin Full-Text Search"

    def ready(self) -> None:
        # Wave 1：挂载 6 类业务模型的 post_save / post_delete / pre_save
        from apps.fts.signals import register_signals
        register_signals()
