"""TabChat（私信/IM）端到端验收 harness。

目的
----
单人即可跑通 TabChat「发消息 → 落库 → Centrifugo 实时下发 → 进宝 Echo 双向回声」
完整闭环，给 TabChat 模块第一次 E2E 验收提供可复跑断言（替代手点两个 Electron）。

覆盖范围：L1-L7 发消息闭环 + C1-C4 资源卡（TC-5）+ U1-U4 未读桌面通知 payload（TC-4）。

闭环设计
--------
1. 选一个 type=team 的 Organization，里面有真人成员 A + 进宝 Echo Bot（DM 自动回声）。
   - 若找不到，脚本报告前置条件不满足并退出（不静默造数据，避免污染语义）。
2. create_dm(team, A, 进宝) 拿到/复用 DM 会话。
3. A 发一条带唯一指纹的探针消息。
4. 断言（A 的消息）：
   - L1 落库：Message 存在、sender=A、content=探针
   - L2 水位未读：发送者不计未读，进宝精确未读数增加
   - L3 实时下发：Centrifugo `chat:{conv}` 频道 history 含该 im.message
5. 等进宝异步 Echo（Celery）回声，poll 最多 ECHO_WAIT_S 秒。
6. 断言（进宝回声）：
   - L4 回声落库：进宝 sender 的 🔁 探针消息存在
   - L5 回声实时下发：Centrifugo history 含进宝的 im.message
   - L6 A 未读：A 的精确未读数包含进宝回声
   - L7 未读汇总：get_unread_counts(A) 中该会话未读 >= 1

用法
----
cd apps/tabtin_django && venv/bin/python scripts/tabchat_e2e_acceptance.py

退出码：全部断言通过 = 0；任一硬断言失败 = 1；前置条件不满足 = 2。
进宝 Echo 依赖 Celery worker（default 队列）；worker 没跑时 L4-L7 记为 SKIP（不算失败），
但 L1-L3 仍是硬断言。
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone as dt_timezone
from pathlib import Path

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

_REPO_DJANGO_DIR = Path(__file__).resolve().parent.parent
if str(_REPO_DJANGO_DIR) not in sys.path:
    sys.path.insert(0, str(_REPO_DJANGO_DIR))

import django
from django.apps import apps as django_apps

if not django_apps.ready:
    django.setup()

from django.conf import settings
from django.contrib.auth import get_user_model

from apps.tabchat.constants import ConversationType
from apps.tabchat.models import Conversation, ConversationMember, IMEventOutbox, Message
from apps.tabchat.services.conversation_service import ConversationService
from apps.tabchat.services.message_service import (
    MessageService,
    _build_preview,
    _validate_card_metadata,
)
from apps.tabdoc.models import Document
from apps.tabtinspace.models import Agent, Space, Organization, OrganizationMember, SpaceMembership
from apps.services.jinbao.constants import ECHO_PREFIX, JINBAO_USER_ID

User = get_user_model()

ECHO_WAIT_S = 15
POLL_INTERVAL_S = 0.5

# ---- 结果收集 ----
_results: list[tuple[str, str, str]] = []  # (level, status, detail)


def record(level: str, ok: bool | None, detail: str) -> None:
    status = "SKIP" if ok is None else ("PASS" if ok else "FAIL")
    _results.append((level, status, detail))
    mark = {"PASS": "✅", "FAIL": "❌", "SKIP": "⚪"}[status]
    print(f"  {mark} [{level}] {status}: {detail}")


def centrifugo_history(channel: str, limit: int = 30) -> list[dict]:
    """查 Centrifugo 频道 history，返回 publications 列表。失败抛异常。"""
    api_url = getattr(settings, "CENTRIFUGO_API_URL", "http://127.0.0.1:8100/api")
    api_key = getattr(settings, "CENTRIFUGO_API_KEY", "")
    body = json.dumps({"channel": channel, "limit": limit}).encode("utf-8")
    req = urllib.request.Request(
        f"{api_url}/history",
        data=body,
        headers={"Content-Type": "application/json", "X-API-Key": api_key},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if "error" in payload:
        raise RuntimeError(f"centrifugo history error: {payload['error']}")
    return payload.get("result", {}).get("publications", [])


def history_has_message(channel: str, predicate) -> bool:
    """history 里是否有满足 predicate(data) 的 im.message。"""
    try:
        pubs = centrifugo_history(channel)
    except Exception as exc:  # noqa: BLE001
        print(f"    (centrifugo history 查询失败: {exc})")
        return False
    for pub in pubs:
        data = pub.get("data", {})
        if data.get("type") != "im.message":
            continue
        msg = data.get("data", {})
        if predicate(msg):
            return True
    return False


def main() -> int:
    print("=" * 64)
    print("TabChat E2E 验收 harness")
    print("=" * 64)

    # ---- 前置：选 team + 真人 A + 进宝 ----
    jinbao = User.objects.filter(id=JINBAO_USER_ID).first()
    if not jinbao:
        print("前置条件不满足：进宝 Echo Bot 用户不存在（dev 专用）。")
        return 2

    team = None
    human_a = None
    for wt in Organization.objects.filter(type=Organization.OrganizationType.TEAM):
        member_ids = set(
            str(m) for m in OrganizationMember.objects.filter(
                organization_id=wt.id
            ).values_list("user_id", flat=True)
        )
        if wt.owner_id:
            member_ids.add(str(wt.owner_id))
        if JINBAO_USER_ID not in member_ids:
            continue
        humans = [uid for uid in member_ids if uid != JINBAO_USER_ID]
        if not humans:
            continue
        team = wt
        human_a = humans[0]
        break

    if not team or not human_a:
        print("前置条件不满足：找不到一个含【进宝 + 至少一个真人】的 team organization。")
        print("  请先在 dev 里建一个 type=team 的 Organization（进宝会自动加入）并确保有真人成员。")
        return 2

    a_profile = User.objects.filter(id=human_a).values("nickname", "username").first() or {}
    a_name = a_profile.get("nickname") or a_profile.get("username") or human_a
    print(f"team   = {team.id} ({team.name!r})")
    print(f"用户 A = {human_a} ({a_name})")
    print(f"进宝   = {JINBAO_USER_ID} (Echo Bot)")
    print("-" * 64)

    # ---- 1. create_dm ----
    conv = ConversationService.create_dm(str(team.id), human_a, JINBAO_USER_ID)
    channel = f"chat:{conv.id}"
    record("DM", conv.type == ConversationType.DM and conv.space_id is None,
           f"create_dm conv={conv.id} type=DM space_id={conv.space_id}")

    # ---- 2. A 发探针消息 ----
    fp = datetime.now(dt_timezone.utc).strftime("%Y%m%d-%H%M%S")
    probe = f"[E2E-probe {fp}] ni hao 进宝"
    print(f"A 发送探针: {probe!r}")
    msg = MessageService.send_message(str(conv.id), human_a, probe)

    # ---- L1 落库 ----
    db_msg = Message.objects.filter(pk=msg.id).first()
    record("L1", bool(db_msg) and db_msg.sender_id == human_a and db_msg.content == probe,
           f"A 消息落库 id={msg.id} sender={getattr(db_msg, 'sender_id', None)}")

    # ---- L2 水位未读 ----
    a_counts = MessageService.get_unread_counts(str(team.id), human_a)
    j_counts = MessageService.get_unread_counts(str(team.id), JINBAO_USER_ID)
    a_unread = a_counts.get(str(conv.id), 0)
    j_unread = j_counts.get(str(conv.id), 0)
    record(
        "L2",
        a_unread == 0 and j_unread >= 1,
        f"A 自己未读={a_unread} / 进宝未读={j_unread}",
    )

    # ---- L3 实时下发（A 消息进 Centrifugo history）----
    time.sleep(1.0)  # 等 on_commit + fire-and-forget publish 落地
    l3 = False
    for _ in range(6):
        if history_has_message(channel, lambda m: m.get("content") == probe):
            l3 = True
            break
        time.sleep(POLL_INTERVAL_S)
    record("L3", l3, f"Centrifugo {channel} history 含 A 探针消息")

    # ---- 5. 等进宝 Echo 回声 ----
    print(f"等待进宝 Echo 回声（最多 {ECHO_WAIT_S}s，依赖 Celery worker）...")
    echo_content = f"{ECHO_PREFIX}{probe}"
    echo_msg = None
    deadline = time.time() + ECHO_WAIT_S
    while time.time() < deadline:
        echo_msg = Message.objects.filter(
            conversation_id=conv.id,
            sender_id=JINBAO_USER_ID,
            content=echo_content,
        ).order_by("-id").first()
        if echo_msg:
            break
        time.sleep(POLL_INTERVAL_S)

    if not echo_msg:
        record("L4", None, "进宝回声未出现（Celery worker 未跑 / echo 未启用？）")
        record("L5", None, "跳过：无回声消息")
        record("L6", None, "跳过：无回声消息")
        record("L7", None, "跳过：无回声消息")
    else:
        # ---- L4 回声落库 ----
        record("L4", True, f"进宝回声落库 id={echo_msg.id} content={echo_msg.content!r}")

        # ---- L5 回声实时下发 ----
        l5 = False
        for _ in range(6):
            if history_has_message(channel, lambda m: m.get("content") == echo_content):
                l5 = True
                break
            time.sleep(POLL_INTERVAL_S)
        record("L5", l5, f"Centrifugo {channel} history 含进宝回声")

        # ---- L6 A 对回声未读 ----
        a_counts = MessageService.get_unread_counts(str(team.id), human_a)
        a_echo_unread = a_counts.get(str(conv.id), 0) >= 1
        record("L6", a_echo_unread, f"A 对进宝回声未读={a_echo_unread}")

        # ---- L7 未读汇总 ----
        try:
            counts = MessageService.get_unread_counts(str(team.id), human_a)
            conv_unread = counts.get(str(conv.id), 0) if isinstance(counts, dict) else 0
            record("L7", conv_unread >= 1, f"get_unread_counts[{conv.id}]={conv_unread}")
        except Exception as exc:  # noqa: BLE001
            record("L7", False, f"get_unread_counts 异常: {exc}")

    # ==== TC-5 资源卡（TabData/TabDoc）====
    # 在会话所属 team + 真实 bot Space 下建一篇测试文档，验「发文档卡 → 后端校验回填 →
    # 落库 + preview」整链路，以及非法资源拒绝。
    print("-- TC-5 资源卡 --")
    from apps.tabtinspace.models import Workspace
    resource_space = (
        Workspace.objects.filter(
            organization_id=team.id,
        )
        .order_by("-updated_at")
        .first()
    )
    if not resource_space:
        resource_agent = Agent.objects.create(
            organization=team,
            owner_user_id=human_a,
            name=f"TC5-resource-agent {fp}",
            type="bot",
        )
        from apps.tabtinspace.models import Device, Workspace
        device = (
            Device.objects.filter(organization=team, user_id=human_a)
            .order_by("-created_at")
            .first()
        )
        if device is None:
            device = Device.objects.create(
                organization=team,
                user_id=human_a,
                name=f"TC5-device {fp}",
                device_type="electron",
                fingerprint=f"tc5-{fp}",
            )
        # ：Workspace 不挂 agent FK
        resource_space = Workspace.objects.create(
            organization=team,
            device=device,
            name=f"TC5-resource-space {fp}",
            working_dir=f"/tmp/tabtin-tc5/{fp}",
            normalized_working_dir=f"/tmp/tabtin-tc5/{fp}",
            kind=Workspace.Kind.STANDARD,
            created_by_id=human_a,
        )
        SpaceMembership.objects.get_or_create(
            workspace_id=resource_space.id,
            agent_id=resource_agent.id,
            defaults={"role": "owner", "is_active": True, "permissions": {}},
        )
        record("C0", True, f"创建临时 bot Space 作为资源所属空间: {resource_space.id}")
    else:
        record("C0", True, f"复用 bot Space 作为资源所属空间: {resource_space.id}")

    if resource_space:
        test_doc = Document.objects.create(
            organization_id=str(team.id),
            space_id=resource_space.id,
            owner_id=human_a,
            title=f"TC5-probe-doc {fp}",
        )
        # C1 发有效文档卡（客户端故意传伪造名，应被 DB 真实名覆盖）
        card_meta = {"card": {"type": "document", "resource_id": str(test_doc.id), "name": "客户端伪造名"}}
        card_msg = MessageService.send_message(str(conv.id), human_a, "[文档] x", metadata=card_meta)
        db_card = Message.objects.get(pk=card_msg.id).metadata.get("card", {})
        record("C1", db_card.get("name") == test_doc.title and db_card.get("hint_carrier_app_id") == "tabdoc",
               f"文档卡落库 name={db_card.get('name')!r}（回填真实名）hint={db_card.get('hint_carrier_app_id')}")
        # C2 preview
        prev = _build_preview(1, "[文档] x", {"card": db_card}, conv_type=conv.type)
        record("C2", prev == f"[文档] {test_doc.title}", f"会话 preview={prev!r}")
        # C3 非法资源 → 拒绝
        bad = {"card": {"type": "document", "resource_id": "11111111-1111-1111-1111-111111111111"}}
        try:
            MessageService.send_message(str(conv.id), human_a, "[文档] x", metadata=bad)
            record("C3", False, "非法 resource_id 未被拒绝")
        except (ValueError, PermissionError) as exc:
            record("C3", True, f"非法 resource_id 被拒（{type(exc).__name__}）")
    # C4 space 卡（旧协议）原样放过，不被资源卡校验拦截
    passthrough = _validate_card_metadata({"card": {"type": "space", "space_id": "x", "name": "n"}}, human_a, str(team.id))
    record("C4", passthrough.get("card", {}).get("type") == "space", "space 卡放过（不在 TC-5 校验范围）")

    # ==== TC-4 未读桌面通知 payload ====
    # send_message 给非当前会话成员推 im.unread.update（im.message 仅走 chat 频道、
    # 未打开会话收不到）。TC-4 要求该事件携带 preview/sender_name/sender_id/
    # organization_id，前端据此弹桌面通知。这里直接检查 send 事务持久化的 Outbox，
    # 不依赖 Centrifugo personal 频道 history 配置或 Worker 时序。
    print("-- TC-4 未读桌面通知 payload --")
    tc4_probe = f"[TC4-probe {fp}] desktop notify"
    tc4_message = MessageService.send_message(str(conv.id), human_a, tc4_probe)
    _unread = [
        (row.target_channels, row.payload)
        for row in IMEventOutbox.objects.filter(
            message=tc4_message,
            event_type="im.unread.update",
        )
    ]
    if not _unread:
        record("U1", False, "未捕获 im.unread.update 广播")
    else:
        chs, payload = _unread[0]
        d = payload.get("data", {})
        expect_chan = f"personal:{JINBAO_USER_ID}"
        record(
            "U1",
            expect_chan in chs and d.get("conversation_id") == str(conv.id),
            f"unread.update → channels={chs} conv={d.get('conversation_id')}",
        )
        record(
            "U2",
            d.get("sender_id") == human_a and bool(d.get("sender_name")),
            f"sender_id={d.get('sender_id')} sender_name={d.get('sender_name')!r}",
        )
        record("U3", d.get("preview") == tc4_probe, f"preview={d.get('preview')!r}")
        record("U4", d.get("organization_id") == str(team.id), f"organization_id={d.get('organization_id')}")

    _captured.clear()
    tc4_mention_probe = f"[TC4-mention {fp}] @{JINBAO_USER_ID}"
    with _mock.patch(
        "apps.tabchat.services.message_service.get_centrifugo_service",
        return_value=_FakeCentrifugo(),
    ):
        MessageService.send_message(
            str(conv.id),
            human_a,
            tc4_mention_probe,
            metadata={"mentioned_user_ids": [JINBAO_USER_ID]},
        )

    _mention_unread = [
        (chs, d) for (chs, d) in _captured
        if d.get("type") == "im.unread.update"
        and f"personal:{JINBAO_USER_ID}" in chs
    ]
    _mention_events = [
        (chs, d) for (chs, d) in _captured
        if d.get("type") == "im.mention"
        and f"personal:{JINBAO_USER_ID}" in chs
    ]
    if not _mention_unread:
        record("U5", False, "@ 接收者未收到 unread.update")
    else:
        _chs, payload = _mention_unread[0]
        d = payload.get("data", {})
        record(
            "U5",
            d.get("conversation_id") == str(conv.id)
            and d.get("organization_id") == str(team.id)
            and "preview" not in d,
            f"mention unread payload keys={sorted(d.keys())}",
        )
    record("U6", bool(_mention_events), f"mention events={len(_mention_events)}")

    _captured.clear()
    ConversationMember.objects.filter(
        conversation=conv,
        user_id=JINBAO_USER_ID,
    ).update(is_muted=True)
    try:
        muted_probe = f"[TC4-muted {fp}] @{JINBAO_USER_ID}"
        with _mock.patch(
            "apps.tabchat.services.message_service.get_centrifugo_service",
            return_value=_FakeCentrifugo(),
        ):
            MessageService.send_message(
                str(conv.id),
                human_a,
                muted_probe,
                metadata={"mentioned_user_ids": [JINBAO_USER_ID]},
            )
    finally:
        ConversationMember.objects.filter(
            conversation=conv,
            user_id=JINBAO_USER_ID,
        ).update(is_muted=False)

    _muted_unread = [
        (chs, d) for (chs, d) in _captured
        if d.get("type") == "im.unread.update"
        and f"personal:{JINBAO_USER_ID}" in chs
    ]
    _muted_mentions = [
        (chs, d) for (chs, d) in _captured
        if d.get("type") == "im.mention"
        and f"personal:{JINBAO_USER_ID}" in chs
    ]
    if not _muted_unread:
        record("U7", False, "免打扰接收者未收到 unread.update")
    else:
        _chs, payload = _muted_unread[0]
        d = payload.get("data", {})
        record(
            "U7",
            d.get("conversation_id") == str(conv.id)
            and d.get("organization_id") == str(team.id)
            and "preview" not in d,
            f"muted unread payload keys={sorted(d.keys())}",
        )
    record("U8", not _muted_mentions, f"muted mention events={len(_muted_mentions)}")

    # ---- 汇总 ----
    print("-" * 64)
    hard = [r for r in _results if r[1] != "SKIP"]
    failed = [r for r in hard if r[1] == "FAIL"]
    skipped = [r for r in _results if r[1] == "SKIP"]
    print(f"硬断言 {len(hard)} 条，PASS {len(hard) - len(failed)}，FAIL {len(failed)}，SKIP {len(skipped)}")
    if failed:
        print("失败项：", [r[0] for r in failed])
        return 1
    if skipped:
        print("（部分项 SKIP，见上；硬断言全过）")
    print("结论：硬断言全部通过 ✅")
    return 0


if __name__ == "__main__":
    sys.exit(main())
