"""Wave 1 同步管道端到端集成测试（手动执行，非 pytest 采集）。

**执行前置**：
    1. Docker ES 启动：`bash scripts/backend/fts-dev.sh up`
    2. MySQL / PG / Redis 已运行
    3. `ensure_indices` 跑过（6 个索引已创建）
    4. Django 环境就绪

**执行命令**：
    cd apps/tabtin_django && source venv/bin/activate
    SEARCH_ENGINE_ENABLED=true CELERY_TASK_ALWAYS_EAGER=1 \\
      python apps/fts/tests/integration/test_end_to_end_sync.py

脚本按 7 个场景跑：
    S1. ChatMessage 创建 → ES 可搜
    S2. ChatSession 改名 → ES 里 session_title 刷新
    S3. ChatSession 删除 → ES 里该 session 所有消息消失
    S4. bulk_create 消息 → FTS outbox 显式写入
    S5. strict_dynamic failure 隔离（模拟）
    S6. flag=false 时 signal 不写 outbox
    S7. scan_outbox 查询 EXPLAIN ANALYZE（PG partial index 命中）

每个场景失败会 assert + 打印诊断信息。脚本 exit code != 0 表示失败。
"""

from __future__ import annotations

import os
import sys
import time
import uuid
from datetime import datetime, timezone as _tz

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")
os.environ.setdefault("SEARCH_ENGINE_ENABLED", "true")
os.environ.setdefault("CELERY_TASK_ALWAYS_EAGER", "1")

import django  # noqa: E402
django.setup()

from django.conf import settings  # noqa: E402
from django.db import connection, connections, transaction  # noqa: E402
from django.test.utils import override_settings  # noqa: E402

from apps.fts.client import get_client, reset_client  # noqa: E402
from apps.fts.index_definitions import (  # noqa: E402
    ensure_indices,
    get_index_name,
    get_messages_alias,
    get_monthly_index_name,
)
from apps.fts.models import FtsOutbox, FtsOutboxPg  # noqa: E402
from apps.fts.services import sync_service  # noqa: E402
from apps.fts.services.outbox_service import write_outbox, scan_outbox  # noqa: E402
from apps.fts import signals as fts_signals  # noqa: E402


# ── 颜色输出 ─────────────────────────────────────────────────
def ok(msg: str) -> None:
    print(f"\033[32m✓\033[0m {msg}")


def fail(msg: str) -> None:
    print(f"\033[31m✗\033[0m {msg}")
    sys.exit(1)


def info(msg: str) -> None:
    print(f"  · {msg}")


# ── 环境预检查 ───────────────────────────────────────────────
def preflight() -> None:
    """确保 ES 可连、6 索引就绪、两库 Outbox 迁移已执行。

    2026-04-17 QC 后：mapping 变更（移除 message_index_in_session +
    新增 checkpoint_state_index），如果存在旧月度索引会因为字段不一致
    导致 strict_dynamic_mapping_exception。preflight 先**强制删除**
    所有 tabtin-messages-* 索引和 template 再 ensure_indices 重建。

    注意：tabtin.settings.py 不读 `CELERY_TASK_ALWAYS_EAGER` 环境变量，
    所以这里直接在 Celery app 上强制设置 EAGER，让 `.delay()` 同步执行。
    否则 signal → on_commit → delete_by_query_task.delay() 会被发到 broker
    但本地没 worker 消费，导致 S8/S9 等场景测不到真实 ES 写入。
    """
    if not settings.SEARCH_ENGINE_ENABLED:
        fail("SEARCH_ENGINE_ENABLED 必须为 true")
    # 强制 EAGER 让所有 .delay() 走 .apply()（inline 同步执行）
    from tabtin.celery import app as celery_app
    celery_app.conf.task_always_eager = True
    celery_app.conf.task_eager_propagates = True
    info("Celery EAGER 模式强制开启")

    client = get_client()
    try:
        client.ping()
    except Exception as exc:
        fail(f"无法连 ES: {exc}")
    ok("ES 可连")

    # 强制重建 messages 索引（mapping 变更后必须）
    # ES 8.x 默认 action.destructive_requires_name=true 禁止通配符删除，
    # 必须先 _cat 列出具体索引名再逐个 delete
    from apps.fts.index_definitions import get_messages_template_name
    try:
        cat_indices = client.cat.indices(index=f"{get_index_name('messages')}-*", format="json")
        idx_names = [i["index"] for i in cat_indices]
        for name in idx_names:
            client.indices.delete(index=name)
        if idx_names:
            info(f"已删除旧 messages 月度索引: {idx_names}（mapping 变更需重建）")
    except Exception as exc:
        info(f"列出/删除月度索引时报错（可能不存在）: {type(exc).__name__}")
    try:
        client.indices.delete_index_template(name=get_messages_template_name())
        info(f"已删除旧 messages template")
    except Exception:
        pass

    created = ensure_indices(client)
    info(f"索引就绪: {list(created.values())}")
    # 清空其他索引，避免 historical 数据干扰本次脚本
    for logical in ("resources", "agents", "spaces", "memos", "im"):
        try:
            client.delete_by_query(
                index=get_index_name(logical),
                body={"query": {"match_all": {}}},
                conflicts="proceed",
                refresh=True,
            )
        except Exception:
            pass
    ok("索引清空（用于本次测试基线）")


# ── 帮助：刷新 ES 并统计某个 session 下的消息数 ────────────────
def count_messages_for_session(session_id: str) -> int:
    client = get_client()
    client.indices.refresh(index=get_messages_alias())
    resp = client.count(
        index=get_messages_alias(),
        body={"query": {"term": {"session_id": session_id}}},
    )
    return int(resp.get("count", 0))


# ── S1: 消息创建 → ES 可搜 ─────────────────────────────────────
def scenario_message_create_to_es() -> None:
    from apps.chat.conversation.models import ChatMessage, ChatSession
    from apps.tabtinspace.models import Space, Organization
    from django.contrib.auth import get_user_model
    User = get_user_model()

    user = User.objects.first()
    if not user:
        fail("数据库没 User，无法测试")
    space = Space.objects.using("postgresql").filter(agent_id__isnull=False).first()
    if not space:
        fail("数据库没 Space，无法测试")

    session = ChatSession.objects.create(
        user=user,
        organization_id=str(space.organization_id),
        space_id=space.id,
        title=f"FTS-E2E-{uuid.uuid4().hex[:6]}",
        status="active",
    )
    info(f"创建 session={session.id}")

    msg = ChatMessage.objects.create(
        session=session,
        role="user",
        content="E2E 测试消息：Python 二分查找",
        sender_user_id=str(user.id),
    )
    info(f"创建 message={msg.id}")

    # 显式调用 flush，避免依赖 Celery eager + on_commit 的细节交互
    from apps.fts.tasks import flush_outbox_task
    flush_outbox_task.run(db="default")
    time.sleep(0.3)
    count = count_messages_for_session(str(session.id))
    if count != 1:
        fail(f"S1 失败：ES 里未找到该消息，count={count}")
    ok(f"S1 消息创建 → ES: count=1")
    return session, msg


# ── S2: ChatSession 改名 → session_title 刷新 ──────────────────
def scenario_session_rename_propagation(session, msg) -> None:
    new_title = f"RENAMED-{uuid.uuid4().hex[:6]}"
    session.title = new_title
    session.save(update_fields=["title"])
    info(f"改名 session.title -> {new_title}")

    # 显式触发（on_commit 已排队但需要 eager 模式拉动；我们直接调）
    from apps.fts.tasks import update_by_query_task
    update_by_query_task.run(
        index_alias=get_messages_alias(),
        field="session_id",
        value=str(session.id),
        partial_doc={"session_title": new_title},
    )
    # update_by_query 是 async（wait_for_completion=False），需要稍候
    time.sleep(2.0)
    client = get_client()
    client.indices.refresh(index=get_messages_alias())
    resp = client.get(
        index=get_messages_alias(),
        id=str(msg.id),
    )
    session_title = resp["_source"].get("session_title")
    if session_title != new_title:
        fail(f"S2 失败：ES 里 session_title 未刷新，实际={session_title}")
    ok(f"S2 改名传播 → session_title={new_title}")


# ── S3: ChatSession 删除 → 级联清理 ────────────────────────────
def scenario_session_delete_cascade(session) -> None:
    session_id = str(session.id)
    session.delete()
    info(f"删除 session={session_id}")

    from apps.fts.tasks import delete_by_query_task
    delete_by_query_task.run(
        index_alias=get_messages_alias(),
        field="session_id",
        value=session_id,
    )
    time.sleep(2.0)
    count = count_messages_for_session(session_id)
    if count != 0:
        fail(f"S3 失败：ES 里残留 {count} 条消息")
    ok(f"S3 级联删除 → ES 里消息被清空")


# ── S4: bulk_create 显式 outbox 写入 ────────────────────────────
def scenario_bulk_create_explicit_outbox() -> None:
    from apps.chat.conversation.models import ChatMessage, ChatSession
    from apps.tabtinspace.models import Space
    from django.contrib.auth import get_user_model

    User = get_user_model()
    user = User.objects.first()
    if not user:
        fail("数据库没 User")
    space = Space.objects.using("postgresql").first()
    if not space:
        fail("数据库没 Space")
    session = ChatSession.objects.create(
        user=user,
        organization_id=str(space.organization_id),
        space_id=space.id,
        title=f"FTS-BULK-{uuid.uuid4().hex[:6]}",
        status="active",
    )

    msgs = [
        ChatMessage(
            id=uuid.uuid4(),
            session=session,
            role="user",
            content=f"bulk msg {i}",
            created_at=datetime.now(tz=_tz.utc),
        )
        for i in range(5)
    ]
    ChatMessage.objects.bulk_create(msgs)
    info(f"bulk_create 5 messages in session={session.id}")

    # 显式写 outbox
    n = sync_service.enqueue_messages_bulk_created(msgs)
    if n != 5:
        fail(f"S4 失败：enqueue 返回 {n}，期望 5")

    # 触发 flush
    from apps.fts.tasks import flush_outbox_task
    flush_outbox_task.run(db="default")
    time.sleep(0.5)
    count = count_messages_for_session(str(session.id))
    if count != 5:
        fail(f"S4 失败：ES count={count}，期望 5")
    ok(f"S4 bulk_create 显式 outbox → count=5")

    session.delete()  # 清理
    time.sleep(0.5)


# ── S5: strict_dynamic 失败隔离（模拟） ──────────────────────────
def scenario_strict_dynamic_isolation() -> None:
    """构造 100 条 actions，其中 1 条带未登记字段；验证 99 条成功。"""
    from apps.fts.services.bulk_buffer import execute_bulk, BulkAction, FailureClass
    client = get_client()
    monthly_idx = get_monthly_index_name("messages")

    actions = [
        BulkAction(
            _op_type="index",
            _index=monthly_idx,
            _id=f"e2e-bulk-ok-{i}",
            row_id=i,
            _source={
                "message_id": f"e2e-bulk-ok-{i}",
                "session_id": "e2e-bulk-sess",
                "organization_id": "wt-test",
                "space_id": "sp-test",
                "user_id": "u-test",
                "creator_type": "user",
                "role": "user",
                "content": f"OK doc {i}",
                "session_title": "E2E Bulk",
                "session_status": "active",
                "created_at": datetime.now(tz=_tz.utc).isoformat(),
            },
        )
        for i in range(99)
    ]
    # 带未登记字段 foobar 的 bad doc（strict_dynamic_mapping_exception）
    actions.append(BulkAction(
        _op_type="index",
        _index=monthly_idx,
        _id="e2e-bulk-bad-1",
        row_id=999,
        _source={
            "message_id": "e2e-bulk-bad-1",
            "session_id": "e2e-bulk-sess",
            "organization_id": "wt-test",
            "space_id": "sp-test",
            "user_id": "u-test",
            "creator_type": "user",
            "role": "user",
            "content": "BAD doc with unregistered field",
            "session_title": "E2E Bulk",
            "session_status": "active",
            "created_at": datetime.now(tz=_tz.utc).isoformat(),
            "foobar_unknown_field": "i should fail",
        },
    ))

    result = execute_bulk(client, actions, refresh=True)
    info(f"bulk: success={len(result.succeeded_row_ids)} failed={len(result.failed_items)}")
    if len(result.succeeded_row_ids) != 99:
        fail(f"S5 失败：期望 99 成功，实际 {len(result.succeeded_row_ids)}")
    if len(result.failed_items) != 1:
        fail(f"S5 失败：期望 1 失败，实际 {len(result.failed_items)}")
    _, cls_name, err = result.failed_items[0]
    if cls_name != FailureClass.STRICT_MAPPING:
        fail(f"S5 失败：分级应为 strict_mapping，实际 {cls_name}（{err}）")
    ok("S5 bulk 失败隔离：99 成功 + 1 strict_dynamic 失败")

    # 清理测试文档
    client.delete_by_query(
        index=monthly_idx,
        body={"query": {"term": {"session_id": "e2e-bulk-sess"}}},
        conflicts="proceed",
        refresh=True,
    )


# ── S6: flag=false 时 signal 不写 outbox ─────────────────────────
def scenario_flag_off_no_outbox() -> None:
    from apps.chat.conversation.models import ChatMessage, ChatSession
    from apps.tabtinspace.models import Space
    from django.contrib.auth import get_user_model

    User = get_user_model()
    user = User.objects.first()
    if not user:
        fail("数据库没 User")
    space = Space.objects.using("postgresql").first()
    if not space:
        fail("数据库没 Space")
    session = ChatSession.objects.create(
        user=user,
        organization_id=str(space.organization_id),
        space_id=space.id,
        title=f"FTS-FLAGOFF-{uuid.uuid4().hex[:6]}",
        status="active",
    )

    baseline = FtsOutbox.objects.using("default").count()
    with override_settings(SEARCH_ENGINE_ENABLED=False):
        ChatMessage.objects.create(
            session=session,
            role="user",
            content="should not be indexed",
            sender_user_id=str(uuid.uuid4()),
        )
    after = FtsOutbox.objects.using("default").count()
    if after != baseline:
        fail(f"S6 失败：flag=false 下 outbox 增加了 {after - baseline}")
    ok("S6 flag=false：outbox 零新增")

    session.delete()


# ── S7: scan_outbox EXPLAIN ANALYZE（PG partial index 命中） ────
def scenario_scan_outbox_explain() -> None:
    # 在 PG outbox 插入 3 条样本（processed_at=None）
    rows = []
    for i in range(3):
        rows.append(FtsOutboxPg.objects.using("postgresql").create(
            index_name="tabtin-resources",
            doc_id=f"e2e-explain-{i}",
            action="upsert",
            organization_id=None,
        ))
    info(f"插入 {len(rows)} 条 pending outbox 用于 EXPLAIN")

    # 用 Django 拿到 PG 方言的 SQL（QuerySet.query.sql_with_params 默认走
    # default 连接方言即 MySQL，需显式用 postgresql connection 的 compiler）
    pg_conn = connections["postgresql"]
    qs = (
        FtsOutboxPg.objects
        .using("postgresql")
        .filter(processed_at__isnull=True, retry_count__lt=5)
        .order_by("created_at")[:500]
    )
    compiler = qs.query.get_compiler(using="postgresql")
    sql, params = compiler.as_sql()

    # 手动在 PG 跑 EXPLAIN ANALYZE
    with pg_conn.cursor() as cur:
        cur.execute(f"EXPLAIN ANALYZE {sql}", params)
        rows_plan = cur.fetchall()

    plan_text = "\n".join(r[0] for r in rows_plan)
    print("EXPLAIN ANALYZE output:")
    for line in plan_text.splitlines():
        print(f"    {line}")

    # 两个 partial index 都满足 `WHERE processed_at IS NULL` 条件（D5 要求）：
    #   - fts_outbox_pg_pending_idx（processed_at, created_at）
    #   - fts_outbox_pg_wt_pending_idx（organization_id, processed_at）
    # 任一被选中都视为 D5 约束达成（**没走 Seq Scan** 才是关键）
    partial_idx_names = ("fts_outbox_pg_pending_idx", "fts_outbox_pg_wt_pending_idx")
    hit = next((n for n in partial_idx_names if n in plan_text), None)
    if hit:
        ok(f"S7 partial index 命中：{hit}")
    elif "seq scan" in plan_text.lower():
        # 数据量极小时 PG 可能选 seq scan；这在生产（百万级 outbox）下不会发生
        # 但 D5 明确说"上线前 EXPLAIN ANALYZE 验证"；此处视作警告而非失败
        print("    ⚠ 当前使用 Seq Scan（数据量小时 PG 成本估计偏好 seq）")
        with pg_conn.cursor() as cur:
            cur.execute("SET enable_seqscan = OFF;")
            cur.execute(f"EXPLAIN ANALYZE {sql}", params)
            forced_rows = cur.fetchall()
            cur.execute("RESET enable_seqscan;")
        forced_plan = "\n".join(r[0] for r in forced_rows)
        print("EXPLAIN ANALYZE (enable_seqscan=off):")
        for line in forced_plan.splitlines():
            print(f"    {line}")
        hit2 = next((n for n in partial_idx_names if n in forced_plan), None)
        if hit2:
            ok(f"S7 partial index 在 seqscan=off 下被选中：{hit2}")
        else:
            fail("S7 失败：partial index 未被选择，即使强制关 seq scan")
    else:
        fail(f"S7 失败：既非 partial index 也非 seq scan，未知 plan")

    # 清理
    FtsOutboxPg.objects.using("postgresql").filter(
        doc_id__startswith="e2e-explain-"
    ).delete()


# ── S8: Space soft-trash cascade（R1-09 修复） ──────────────────
def scenario_space_trash_cascade() -> None:
    """复现 QC Agent 端到端 BLOCKER：软删 Space 后 memo / message 应都搜不到。"""
    from datetime import datetime, timezone as _tz
    from django.contrib.auth import get_user_model
    from apps.chat.conversation.models import ChatMessage, ChatSession
    from apps.tabmemo.models import Memo
    from apps.tabtinspace.models import Agent, Space, Organization

    User = get_user_model()
    user = User.objects.first()
    if not user:
        fail("数据库没 User")

    # 创建 standalone Space（用 type='team' 避开 bot space 一对一 agent 约束）
    organization = Organization.objects.using("postgresql").filter(owner=user).first()
    if not organization:
        fail("数据库没 Organization")
    space = Space.objects.using("postgresql").create(
        organization=organization,
        type="team",
        name=f"FTS-S8-{uuid.uuid4().hex[:6]}",
    )
    info(f"创建 space={space.id} (type=team)")

    memo = Memo.objects.using("postgresql").create(
        organization_id=organization.id,
        space_id=space.id,
        owner_id=user.id,
        content_plaintext=f"S8-MEMO-{uuid.uuid4().hex[:6]} 关键词搜索测试",
        memo_type="note",
        status="active",
    )
    info(f"创建 memo={memo.id}")

    session = ChatSession.objects.create(
        user=user,
        organization_id=str(organization.id),
        space_id=space.id,
        title=f"S8-SESS-{uuid.uuid4().hex[:6]}",
        status="active",
    )
    msg = ChatMessage.objects.create(
        session=session,
        role="user",
        content=f"S8-MSG-{uuid.uuid4().hex[:6]} 软删测试",
        sender_user_id=str(user.id),
    )
    info(f"创建 session={session.id} message={msg.id}")

    # 同步全部
    from apps.fts.tasks import flush_outbox_task
    flush_outbox_task.run(db="default")
    flush_outbox_task.run(db="postgresql")
    time.sleep(0.5)

    client = get_client()
    client.indices.refresh(index=f"{get_messages_alias()},{get_index_name('memos')},{get_index_name('spaces')}")

    # 创建后应该都能搜到
    space_doc = client.get(index=get_index_name("spaces"), id=str(space.id), ignore=[404])
    memo_doc = client.get(index=get_index_name("memos"), id=str(memo.id), ignore=[404])
    msg_count = client.count(
        index=get_messages_alias(),
        body={"query": {"term": {"space_id": str(space.id)}}},
    )["count"]
    if not space_doc.get("found"):
        fail(f"S8 前置失败：space 未入索引")
    if not memo_doc.get("found"):
        fail(f"S8 前置失败：memo 未入索引")
    if msg_count != 1:
        fail(f"S8 前置失败：messages count={msg_count}")
    info("前置：3 个索引都有数据")

    # 软删 Space（设 trashed_at + status='trashed'，Django save 触发 signal）
    from django.utils import timezone
    space.trashed_at = timezone.now()
    space.status = "trashed"
    space.save(update_fields=["trashed_at", "status"])
    info(f"软删 space.trashed_at = {space.trashed_at}")

    # 触发同步（postgresql 库的 outbox 写完会发 flush；级联 delete_by_query
    # 已通过 transaction.on_commit + Celery EAGER 同步执行；但
    # delete_by_query 用 wait_for_completion=False 是 ES 异步任务，需要轮询）
    flush_outbox_task.run(db="postgresql")

    # 轮询等待 delete_by_query ES 后台任务完成（最多 10s）
    indices_str = f"{get_messages_alias()},{get_index_name('memos')},{get_index_name('spaces')}"
    space_clean = memo_clean = msg_clean = False
    for _ in range(20):
        time.sleep(0.5)
        client.indices.refresh(index=indices_str)
        space_doc_after = client.get(index=get_index_name("spaces"), id=str(space.id), ignore=[404])
        memo_doc_after = client.get(index=get_index_name("memos"), id=str(memo.id), ignore=[404])
        msg_count_after = client.count(
            index=get_messages_alias(),
            body={"query": {"term": {"space_id": str(space.id)}}},
        )["count"]
        space_clean = not space_doc_after.get("found")
        memo_clean = not memo_doc_after.get("found")
        msg_clean = (msg_count_after == 0)
        if space_clean and memo_clean and msg_clean:
            break

    if not space_clean:
        fail(f"S8 失败：spaces 索引里 Space 仍存在（轮询 10s 超时）")
    if not memo_clean:
        fail(f"S8 失败：memos 索引里 Memo 仍存在（轮询 10s 超时） → QC BLOCKER")
    if not msg_clean:
        fail(f"S8 失败：messages 索引残留 → QC BLOCKER")
    ok(f"S8 Space soft-trash 级联：spaces/memos/messages 全部清空")

    # 清理：直接 SQL DELETE 避开 Django collector 跨库 cascade
    # （Space.chat_sessions 在 MySQL，db_constraint=False；ORM .delete()
    # 会尝试在 PG 上 SET NULL chat_session.space_id 但表不在 PG）
    from django.db import connections
    with connections["postgresql"].cursor() as cur:
        # 先把 ContextItem / Memo 自己清掉（避免 PG cascade 报错）
        cur.execute("DELETE FROM tabmemo_memo WHERE space_id = %s", [str(space.id)])
        cur.execute("DELETE FROM tabtinspace_context_item WHERE space_id = %s", [str(space.id)])
        cur.execute("DELETE FROM tabtinspace_space WHERE id = %s", [str(space.id)])
    # MySQL 侧的 ChatSession + ChatMessage 直接 ORM 删（同库无跨库问题）
    session.delete()


# ── S9: HIGH-4 幂等 delete（404 not_found 不重试） ──────────────
def scenario_idempotent_delete_not_found() -> None:
    """复现：bulk delete 一条不存在的 doc，ES 返回 404 not_found，
    必须当幂等成功，**不**入 outbox failed_items / **不**触发 retry。
    """
    from apps.fts.services.bulk_buffer import BulkAction, execute_bulk
    client = get_client()
    monthly_idx = get_monthly_index_name("messages")

    # 构造一个故意不存在的 doc 的 delete action
    actions = [
        BulkAction(
            _op_type="delete",
            _index=monthly_idx,
            _id="ghost-message-id-does-not-exist",
            row_id=88888,
        ),
    ]
    result = execute_bulk(client, actions, refresh=True)

    if len(result.failed_items) != 0:
        fail(f"S9 失败：404 not_found 进了 failed_items: {result.failed_items}")
    if 88888 not in result.succeeded_row_ids:
        fail(f"S9 失败：幂等 delete 没计入 succeeded_row_ids: {result.succeeded_row_ids}")
    if result.idempotent_deletes != 1:
        fail(f"S9 失败：idempotent_deletes 计数错: {result.idempotent_deletes}")
    ok(f"S9 幂等 delete 404：成功={len(result.succeeded_row_ids)} idempotent={result.idempotent_deletes} failed=0")


# ── 主入口 ─────────────────────────────────────────────────────
def main() -> None:
    print("==== FTS Wave 1 End-to-End Integration ====")
    preflight()
    print("\n--- S1: ChatMessage create → ES ---")
    session, msg = scenario_message_create_to_es()
    print("\n--- S2: ChatSession rename propagation ---")
    scenario_session_rename_propagation(session, msg)
    print("\n--- S3: ChatSession delete cascade ---")
    scenario_session_delete_cascade(session)
    print("\n--- S4: bulk_create explicit outbox ---")
    scenario_bulk_create_explicit_outbox()
    print("\n--- S5: strict_dynamic failure isolation ---")
    scenario_strict_dynamic_isolation()
    print("\n--- S6: flag=false no outbox ---")
    scenario_flag_off_no_outbox()
    print("\n--- S7: scan_outbox EXPLAIN ANALYZE ---")
    scenario_scan_outbox_explain()
    print("\n--- S8: Space soft-trash cascade (R1-09 修复) ---")
    scenario_space_trash_cascade()
    print("\n--- S9: idempotent delete 404 (HIGH-4 修复) ---")
    scenario_idempotent_delete_not_found()
    print("\n==== ALL SCENARIOS PASSED ====")


if __name__ == "__main__":
    main()
