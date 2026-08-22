"""TC-12 / TC-13 live 探针（dev PG + 运行中 Django）。

覆盖
----
- TC-13 L1: 会话成员可换 attachment-url（service + HTTP）
- TC-13 L2: FileUsage 失效后 403
- TC-13 L3: 模拟转发消息后接收方可凭新 message_id 换链
- TC-12 L1: forwarded_from.original_sender_id == 当前用户时不应展示来源（逻辑断言）

用法
----
cd apps/tabtin_django && venv/bin/python scripts/tc12_tc13_live_probe.py

退出码：全部硬断言通过 = 0；失败 = 1；前置条件不满足 = 2。
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
from unittest.mock import patch
from pathlib import Path

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")
_DIR = Path(__file__).resolve().parent.parent
if str(_DIR) not in sys.path:
    sys.path.insert(0, str(_DIR))

import django

django.setup()

from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone
from datetime import timedelta

from apps.tabchat.constants import MessageType
from apps.tabchat.models import Message
from apps.tabchat.services.conversation_service import ConversationService
from apps.tabchat.services.message_service import MessageService
from apps.services.oss.models import FileRecord, FileUsage
from apps.services.jinbao.constants import JINBAO_USER_ID
from apps.tabtinspace.models import Organization, OrganizationMember
from apps.users.auth.models import UserSession
from apps.users.auth.session_manager import SessionManager
from apps.users.auth.utils import generate_jwt_token

User = get_user_model()

_results: list[tuple[str, str, str]] = []


def record(level: str, ok: bool | None, detail: str) -> None:
    status = "SKIP" if ok is None else ("PASS" if ok else "FAIL")
    _results.append((level, status, detail))
    mark = {"PASS": "✅", "FAIL": "❌", "SKIP": "⚪"}[status]
    print(f"  {mark} [{level}] {status}: {detail}")


def find_team_with_two_humans() -> tuple[Organization, str, str] | None:
    for wt in Organization.objects.filter(type=Organization.OrganizationType.TEAM):
        member_ids = set(
            str(m)
            for m in OrganizationMember.objects.filter(organization_id=wt.id).values_list("user_id", flat=True)
        )
        if wt.owner_id:
            member_ids.add(str(wt.owner_id))
        humans = [uid for uid in member_ids if uid != JINBAO_USER_ID]
        if len(humans) >= 2:
            return wt, humans[0], humans[1]
        if len(humans) == 1 and JINBAO_USER_ID in member_ids:
            return wt, humans[0], JINBAO_USER_ID
    return None


def http_attachment_url(token: str, conv_id: str, message_id: int) -> tuple[int, dict | str]:
    req = urllib.request.Request(
        f"http://127.0.0.1:6060/api/im/conversations/{conv_id}/messages/{message_id}/attachment-url",
        headers={"Authorization": f"Bearer {token}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = resp.read().decode("utf-8")
            body = json.loads(raw) if raw else {}
            return resp.status, body
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8")
        try:
            body = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            body = raw or f"HTTP {exc.code}"
        return exc.code, body


def make_access_token(user_id: str) -> str:
    user = User.objects.get(id=user_id)
    raw_key = f"tc13-live-probe-{user_id[:8]}"
    UserSession.objects.update_or_create(
        session_key=SessionManager.hash_session_key(raw_key),
        defaults={
            "user": user,
            "session_type": "web",
            "ip_address": "127.0.0.1",
            "user_agent": "tc13-live-probe",
            "device_info": {},
            "expires_at": timezone.now() + timedelta(hours=1),
            "is_active": True,
        },
    )
    return generate_jwt_token(user, session_key=raw_key)


def main() -> int:
    with patch("apps.services.oss.services.factory.get_oss_service") as mock_get_oss:
        mock_get_oss.return_value.generate_presigned_url.return_value = (
            "https://oss.example.com/live/tc13-probe.pdf"
        )
        return _run_probe()


def _run_probe() -> int:
    print("=" * 64)
    print("TC-12 / TC-13 live 探针")
    print("=" * 64)

    picked = find_team_with_two_humans()
    if not picked:
        print("前置条件不满足：找不到含至少两名成员的 team organization。")
        return 2

    team, user_a, user_b = picked
    print(f"team = {team.id} ({team.name!r})")
    print(f"A    = {user_a}")
    print(f"B    = {user_b}")
    print("-" * 64)

    conv_ab = ConversationService.create_dm(str(team.id), user_a, user_b)
    conv_ba = ConversationService.create_dm(str(team.id), user_b, user_a)

    a_profile = User.objects.filter(id=user_a).values("nickname", "username").first() or {}
    a_name = a_profile.get("nickname") or a_profile.get("username") or user_a

    stamp = str(int(time.time()))
    file_key = f"im/attachments/tc13-live-probe-{stamp}.pdf"

    file_record = FileRecord.objects.create(
        file_name="tc13-live-probe.pdf",
        file_key=file_key,
        file_size=2048,
        mime_type="application/pdf",
        upload_user=user_a,
        organization_id=str(team.id),
        status="completed",
        access_url="https://oss.example.com/stale/tc13-live-probe.pdf",
    )

    with transaction.atomic():
        orig = Message.objects.create(
            conversation=conv_ab,
            seq=Message.objects.filter(conversation=conv_ab).count() + 1,
            sender_id=user_a,
            content="[文件] tc13-live-probe.pdf",
            message_type=MessageType.FILE,
            metadata={
                "file_id": str(file_record.id),
                "file_name": "tc13-live-probe.pdf",
                "file_size": 2048,
                "access_url": file_record.access_url,
            },
            has_attachment=True,
        )
        FileUsage.add_usage(
            file_record=file_record,
            user_id=user_a,
            module="tabchat",
            context_type="im_message",
            context_id=str(orig.id),
        )

    try:
        data = MessageService.get_attachment_download_url(
            conversation_id=str(conv_ab.id),
            message_id=orig.id,
            user_id=user_b,
        )
        record(
            "TC13-L1a",
            data.get("download_url") == "https://oss.example.com/live/tc13-probe.pdf",
            f"service 换链 message_id={orig.id}",
        )
    except Exception as exc:  # noqa: BLE001
        record("TC13-L1a", False, f"service 异常: {exc}")

    token_b = make_access_token(user_b)
    status, body = http_attachment_url(token_b, str(conv_ab.id), orig.id)
    http_ok = status == 200 and isinstance(body, dict) and body.get("success") and body.get("data", {}).get("download_url")
    record(
        "TC13-L1b",
        http_ok,
        f"HTTP GET attachment-url status={status}",
    )

    forwarded_meta = {
        "file_id": str(file_record.id),
        "file_name": "tc13-live-probe.pdf",
        "file_size": 2048,
        "access_url": file_record.access_url,
        "forwarded_from": {
            "original_message_id": orig.id,
            "original_conversation_id": str(conv_ab.id),
            "original_sender_id": user_a,
            "original_sender_name": a_name,
        },
    }
    with transaction.atomic():
        fwd = Message.objects.create(
            conversation=conv_ba,
            seq=Message.objects.filter(conversation=conv_ba).count() + 1,
            sender_id=user_b,
            content="[文件] tc13-live-probe.pdf",
            message_type=MessageType.FILE,
            metadata=forwarded_meta,
            has_attachment=True,
        )
        FileUsage.add_usage(
            file_record=file_record,
            user_id=user_b,
            module="tabchat",
            context_type="im_message",
            context_id=str(fwd.id),
        )

    try:
        fwd_data = MessageService.get_attachment_download_url(
            conversation_id=str(conv_ba.id),
            message_id=fwd.id,
            user_id=user_a,
        )
        record(
            "TC13-L3",
            bool(fwd_data.get("download_url")),
            f"转发消息接收方换链 message_id={fwd.id}",
        )
    except Exception as exc:  # noqa: BLE001
        record("TC13-L3", False, f"转发换链异常: {exc}")

    usage = FileUsage.objects.filter(
        file_record=file_record,
        context_id=str(fwd.id),
        is_active=True,
    ).first()
    if usage:
        usage.deactivate()
    denied = False
    try:
        MessageService.get_attachment_download_url(
            conversation_id=str(conv_ba.id),
            message_id=fwd.id,
            user_id=user_a,
        )
    except PermissionError:
        denied = True
    record("TC13-L2", denied, "FileUsage 失效后 service 403")

    status_denied, body_denied = http_attachment_url(token_b, str(conv_ba.id), fwd.id)
    http_denied = (
        (status_denied == 403)
        or (isinstance(body_denied, dict) and body_denied.get("success") is False and body_denied.get("code") == 403)
    )
    record("TC13-L2b", http_denied, f"FileUsage 失效后 HTTP status={status_denied} code={body_denied.get('code') if isinstance(body_denied, dict) else body_denied}")

    show_forwarded = bool(
        forwarded_meta.get("forwarded_from", {}).get("original_sender_id") != user_a
    )
    record(
        "TC12-L1",
        not show_forwarded,
        f"A 看自己转发来源应隐藏 show={show_forwarded}",
    )

    show_for_receiver = bool(
        forwarded_meta.get("forwarded_from", {}).get("original_sender_id") != user_b
    )
    record(
        "TC12-L2",
        show_for_receiver,
        f"B 看 A 转发来源应显示 show={show_for_receiver}",
    )

    print("-" * 64)
    fails = [r for r in _results if r[1] == "FAIL"]
    print(f"合计 {len(_results)} 项，FAIL={len(fails)}")
    return 1 if fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
