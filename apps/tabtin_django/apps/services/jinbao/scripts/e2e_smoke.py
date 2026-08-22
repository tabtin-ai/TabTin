"""进宝 Echo Bot 后端 E2E 真实链路 smoke 测试。

模拟一个真人在 TEAM organization 里给进宝发 DM 消息，
等待 sleep（ECHO_THINK_SECONDS + buffer），断言收到 🔁 前缀的回声。

这条 smoke 测试完整覆盖：
    用户调 send_message
    → MessageService 写库
    → on_commit dispatch message_created signal
    → jinbao signal handler enqueue Celery task
    → Celery worker 调 echo task
    → sleep ECHO_THINK_SECONDS
    → MessageService.send_message（以进宝身份）
    → DB 再次落库

跑通这条 = 后端 IM 真实通道 100% 通透。前端验收看 plan §6.2。

执行：

    cd apps/tabtin_django && source venv/bin/activate
    python manage.py shell < apps/services/jinbao/scripts/e2e_smoke.py

退出码：
    0 — 真实链路通
    1 — 找不到 fixture（dev 环境需要先有 TEAM organization + 真人成员）
    2 — 发了消息但没收到回声（很可能 Celery 没起 / signal 没注册）
    3 — 收到了消息但 content 不对
"""
from __future__ import annotations

import sys
import time

from django.contrib.auth import get_user_model

from apps.services.jinbao.constants import (
    ECHO_PREFIX,
    ECHO_THINK_SECONDS,
    JINBAO_USER_ID,
)
from apps.tabchat.constants import MessageType
from apps.tabchat.models import Conversation, ConversationMember, Message
from apps.tabchat.services.conversation_service import ConversationService
from apps.tabchat.services.message_service import MessageService
from apps.tabtinspace.models import Organization, OrganizationMember
from apps.services.common.db_router import postgres_app_db_alias

User = get_user_model()


def main() -> int:
    print('=' * 60)
    print('[jinbao E2E] 进宝 Echo Bot 真实链路验证')
    print('=' * 60)

    # 1) 找一个含进宝的 TEAM organization，并选一个真人 active 成员作为发送方
    candidate_wt = None
    candidate_human_id = None

    for wt in Organization.objects.using(postgres_app_db_alias()).filter(type='team'):
        member_ids = list(
            OrganizationMember.objects.using(postgres_app_db_alias())
            .filter(organization=wt)
            .values_list('user_id', flat=True)
        )
        if JINBAO_USER_ID not in member_ids:
            continue
        human_ids = [uid for uid in member_ids if uid != JINBAO_USER_ID]
        for uid in human_ids:
            try:
                u = User.objects.get(id=uid)
            except User.DoesNotExist:
                continue
            if not u.is_active:
                continue
            candidate_wt = wt
            candidate_human_id = uid
            break
        if candidate_wt:
            break

    if not candidate_wt:
        print('[FATAL] 没有找到含进宝 + 含真人 active 成员的 TEAM organization。')
        print('请先在 Electron 里登录一个用户、创建一个 TEAM organization、')
        print('然后跑 `python manage.py seed_jinbao` 让进宝加入，再重跑本脚本。')
        return 1

    print(f'organization_id   = {candidate_wt.id}')
    print(f'organization_name = {candidate_wt.name!r}')
    print(f'human_user_id = {candidate_human_id}')
    print(f'jinbao_id     = {JINBAO_USER_ID}')
    print()

    # 2) 创建/获取 DM
    print('[step 1/4] 创建/获取 DM ...')
    conv = ConversationService.create_dm(
        organization_id=str(candidate_wt.id),
        creator_id=str(candidate_human_id),
        other_user_id=JINBAO_USER_ID,
    )
    print(f'  conversation_id = {conv.id}')
    print(f'  conversation.type = {conv.type}')
    print(f'  conversation.dm_hash = {conv.dm_hash}')
    member_ids = list(
        ConversationMember.objects.filter(conversation_id=conv.id)
        .values_list('user_id', flat=True)
    )
    print(f'  members = {member_ids}')
    assert JINBAO_USER_ID in member_ids, '进宝必须是 DM 成员（否则后续 send_message 会权限失败）'
    print()

    # 3) 真人发消息
    content = 'hello, jinbao! 你好啊'
    print(f'[step 2/4] 真人 user 发消息: {content!r}')
    sent_msg = MessageService.send_message(
        conversation_id=str(conv.id),
        sender_id=str(candidate_human_id),
        content=content,
        message_type=MessageType.TEXT,
    )
    print(f'  原消息 id={sent_msg.id}')
    print(f'  原消息 content={sent_msg.content!r}')
    print(f'  原消息 sender_id={sent_msg.sender_id}')
    print()

    # 4) 等待回声（严格要求 id > sent_msg.id，避免拿到历史 echo）
    wait_total = ECHO_THINK_SECONDS + 2.0
    print(f'[step 3/4] 等待 {wait_total:.1f}s（延迟 {ECHO_THINK_SECONDS}s + buffer）...')
    echo_msg = None
    start = time.monotonic()
    deadline = start + wait_total
    poll_count = 0
    while time.monotonic() < deadline:
        poll_count += 1
        candidate = (
            Message.objects
            .filter(
                conversation_id=conv.id,
                sender_id=JINBAO_USER_ID,
                id__gt=sent_msg.id,
            )
            .order_by('-id')
            .first()
        )
        if candidate is not None:
            echo_msg = candidate
            elapsed = time.monotonic() - start
            print(f'  收到新回声！耗时 {elapsed:.2f}s, 共轮询 {poll_count} 次')
            break
        time.sleep(0.2)
    print()

    # 5) 断言
    print('[step 4/4] 断言验证')
    expected = f'{ECHO_PREFIX}{content}'
    if echo_msg is None:
        print('  ❌ FAIL: 未收到任何回声消息')
        print('  排查方向（按概率排序）：')
        print('    1. Celery worker 没起或没注册 jinbao.echo_message')
        print('       验证：python manage.py shell -c "from celery import current_app; '
              "print('jinbao.echo_message' in current_app.tasks)\"")
        print('    2. ENABLE_JINBAO_BOT 没启用（apps/tabtin_django/.env）')
        print('    3. message_created signal 没注册（看 worker 启动日志）')
        print('    4. 跨库事务 on_commit 没触发')
        return 2

    print(f'  echo message_id  = {echo_msg.id}')
    print(f'  echo content     = {echo_msg.content!r}')
    print(f'  echo sender_id   = {echo_msg.sender_id}')
    print(f'  expected content = {expected!r}')

    if echo_msg.sender_id != JINBAO_USER_ID:
        print(f'  ❌ FAIL: echo sender 不是进宝')
        return 3
    if echo_msg.id <= sent_msg.id:
        print(f'  ❌ FAIL: echo id ({echo_msg.id}) 必须 > sent id ({sent_msg.id})')
        return 3
    if echo_msg.created_at < sent_msg.created_at:
        print(f'  ❌ FAIL: echo 时间早于 sent 时间')
        return 3
    if echo_msg.content != expected:
        print(f'  ❌ FAIL: 内容不匹配')
        return 3

    fresh_conv = Conversation.objects.get(pk=conv.id)
    print(f'  conversation.last_message_at = {fresh_conv.last_message_at}')
    print(f'  conversation.last_message_preview = {fresh_conv.last_message_preview!r}')

    print()
    print('✅ 真实链路 E2E 跑通：用户发消息 → signal → Celery → 进宝回声 → DB 落库')
    print('   （前端实时推送需要在 Electron 里手动验收，看 plan §6.2）')
    print('=' * 60)
    return 0


# `manage.py shell <` 模式下脚本被 exec()，不会进 __main__；直接调用 main()。
# 非 0 退出码透传出去（让外层脚本能 trap 失败）。
_exit_code = main()
if _exit_code != 0:
    raise SystemExit(_exit_code)
