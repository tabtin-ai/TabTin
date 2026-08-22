"""推送注册管理 + 分发编排（在线抑制 / 偏好 / 去重节流 / 多设备扇出）。

两个 P0 场景：
  - ``agent_done``      Agent 一轮 turn 结束（事件源：relay done）
  - ``interaction_requested``  Agent 等待用户输入/审批（事件源：PendingInteraction 创建）

推送是尽力而为的「叫醒」通道，不是数据完整性通道：任何一步失败都
只记日志降级，绝不阻断事件主链路。

产品范围（2026-07-06 收紧）：只有「打断用户、需要用户确认」的事件才推送系统通知
（审批 / 权限确认 / 选择 / 补充信息 → ``interaction_requested``）。``agent.stream.done``
覆盖任意一轮 turn 结束，包括纯聊天问答，不带「是否值得叫醒用户」的语义过滤，
当前 ``notify_agent_done`` 因此**暂停实际发送**（见函数内说明）。节流 / 在线抑制 /
偏好读取等基础设施保留，便于未来给 ``agent_done`` 补上更精确的门控（例如仅长任务 /
含工具调用 / 后台子 Agent 完成）后重新开启。
"""

from __future__ import annotations

import logging
from typing import Any

from django.utils import timezone

from .presence import has_mobile_foreground
from .providers import PushMessage, get_push_provider, is_push_enabled

logger = logging.getLogger(__name__)

SCENE_AGENT_DONE = "agent_done"
SCENE_INTERACTION = "interaction_requested"
SCENE_IM_MESSAGE = "im_message"

# 产品决策（2026-07-06）：暂停 agent_done 推送。``agent.stream.done`` 覆盖任意一轮
# turn 结束（含纯聊天问答），没有区分「真正完成了值得回来看的任务」和「随口聊了
# 一句」，会让用户每次闲聊都收到系统推送，消耗对通知的信任。当前只保留
# interaction_requested（打断用户、需要确认/输入的场景：审批/权限确认/选择/表单）。
# 节流 / 在线抑制 / 偏好等基础设施不删——待给 agent_done 补上更精确的门控
# （例如仅长任务 / 含工具调用 / 后台子 Agent 完成）后，把这个 flag 改回 True。
AGENT_DONE_PUSH_ENABLED = False

# 同一 thread 连续完成（如 Tracker 定时任务）的节流窗口
AGENT_DONE_THROTTLE_SECONDS = 60
# 同一交互只推一次的幂等窗口（交互本身 TTL 120s）
INTERACTION_DEDUP_SECONDS = 600

_PREFERENCE_KEYS = {
    SCENE_AGENT_DONE: "taskCompleted",
    SCENE_INTERACTION: "approval",
    SCENE_IM_MESSAGE: "messages",
}

_INTERACTION_TITLES = {
    "tool_approval": "在等你审批工具操作",
    "permission_request": "在等你确认权限",
    "browser_action_approval": "在等你审批浏览器操作",
    "ask_choice": "在等你做选择",
    "ask_form": "在等你补充信息",
}


# ── 注册管理 ──────────────────────────────────────────────────────────


def register_push_token(
    *,
    user_id: str,
    registration_id: str,
    platform: str,
    provider: str = "apns",
    environment: str = "production",
    device_fingerprint: str = "",
    app_version: str = "",
):
    """Upsert 一条推送注册。

    以 (provider, registration_id) 为幂等键：同一台设备换账号登录时，
    token 归属跟随最新登录用户（防止 A 的通知推到 B 已登出的手机上）。
    """
    from apps.services.notification.models import DevicePushRegistration

    registration, _created = DevicePushRegistration.objects.update_or_create(
        provider=provider,
        registration_id=registration_id,
        defaults={
            "user_id": str(user_id),
            "platform": platform,
            "device_fingerprint": device_fingerprint or "",
            "app_version": app_version or "",
            "environment": environment,
            "is_active": True,
            "last_seen_at": timezone.now(),
        },
    )
    if device_fingerprint:
        DevicePushRegistration.objects.filter(
            user_id=str(user_id),
            provider="apns",
            platform="ios",
            device_fingerprint=device_fingerprint,
            is_active=True,
        ).exclude(id=registration.id).update(is_active=False, last_seen_at=timezone.now())
    return registration


def revoke_push_token(*, user_id: str, registration_id: str, provider: str = "apns") -> bool:
    """登出反注册。只允许注销归属当前用户的注册。"""
    from apps.services.notification.models import DevicePushRegistration

    updated = DevicePushRegistration.objects.filter(
        provider=provider,
        registration_id=registration_id,
        user_id=str(user_id),
    ).update(is_active=False, last_seen_at=timezone.now())
    return updated > 0


# ── 场景入口（Celery task 调用） ──────────────────────────────────────


def notify_agent_done(session_id: str, done_payload: dict[str, Any] | None = None) -> bool:
    """Agent 一轮 turn 结束 → 推送「干完活」。

    产品决策（2026-07-06）：暂停发送，见 ``AGENT_DONE_PUSH_ENABLED`` 说明。
    """
    if not AGENT_DONE_PUSH_ENABLED:
        return False

    if not is_push_enabled():
        return False

    from apps.chat.conversation.models import ChatSession

    session = (
        ChatSession.objects
        .filter(id=session_id)
        .only(
            "id", "thread_id", "user", "organization_id", "workspace_id",
            "project_id", "title", "parent_id",
        )
        .first()
    )
    if session is None:
        return False
    # 子 Agent 的 done 不叫醒用户——父会话自己的 done 会来
    if session.parent_id:
        return False

    thread_id = session.thread_id or f"chat-session-{session.id}"
    if not _acquire_once(f"push:sent:done:{thread_id}", AGENT_DONE_THROTTLE_SECONDS):
        return False

    payload = done_payload or {}
    is_error = bool(payload.get("error"))
    session_title = (session.title or "").strip()
    if is_error:
        title = f"{session_title or 'Agent'} 执行出错"
        body = str(payload.get("error_message") or "任务执行遇到问题，点开查看详情")
    else:
        title = f"{session_title or 'Agent'} 完成了任务"
        body = str(payload.get("content") or "").strip() or "点开查看结果"

    return _dispatch(
        user_id=str(session.user_id),
        scene=SCENE_AGENT_DONE,
        title=title,
        body=body[:200],
        ext={
            "scene": SCENE_AGENT_DONE,
            "organization_id": str(session.organization_id or ""),
            "workspace_id": str(session.workspace_id or ""),
            # 旧移动端仍读取 space_id；当前值与 workspace_id 同义（历史 id-reuse）。
            "space_id": str(session.workspace_id or ""),
            "project_id": str(session.project_id or ""),
            "session_id": str(session.id),
            "thread_id": thread_id,
        },
    )


def notify_interaction_requested(interaction_id: str) -> bool:
    """PendingInteraction 创建 → 推送「要审批 / 要输入」。"""
    if not is_push_enabled():
        return False

    from apps.services.agent_engine.models import PendingInteraction

    interaction = PendingInteraction.objects.filter(id=interaction_id).first()
    if interaction is None or interaction.status != "pending":
        # 已被抢答/过期的交互不再叫人
        return False

    if not _acquire_once(f"push:sent:interaction:{interaction.id}", INTERACTION_DEDUP_SECONDS):
        return False

    kind_text = _INTERACTION_TITLES.get(interaction.kind, "在等你确认")
    interaction_payload = interaction.payload if isinstance(interaction.payload, dict) else {}
    body = _summarize_interaction(interaction_payload) or "任务已暂停，等待你的回应"
    message_id = str(
        interaction_payload.get("message_id")
        or interaction_payload.get("client_event_id")
        or ""
    ).strip()
    workspace_id = ""
    project_id = ""
    if interaction.session_id:
        from apps.chat.conversation.models import ChatSession

        session_scope = (
            ChatSession.objects
            .filter(id=interaction.session_id)
            .values("workspace_id", "project_id")
            .first()
        )
        if session_scope:
            workspace_id = str(session_scope.get("workspace_id") or "")
            project_id = str(session_scope.get("project_id") or "")

    return _dispatch(
        user_id=str(interaction.user_id),
        scene=SCENE_INTERACTION,
        title=f"Agent {kind_text}",
        body=body[:200],
        ext={
            "scene": SCENE_INTERACTION,
            "organization_id": str(interaction.organization_id or ""),
            "workspace_id": workspace_id,
            # 旧客户端兼容字段；当前值与 workspace_id 同义。
            "space_id": workspace_id,
            "project_id": project_id,
            "session_id": str(interaction.session_id or ""),
            "message_id": message_id,
            "thread_id": interaction.thread_id,
            "interaction_id": str(interaction.id),
            "kind": interaction.kind,
        },
    )


def notify_im_message(
    *,
    user_id: str,
    organization_id: str,
    conversation_id: str,
    message_id: str,
    sender_id: str = "",
    sender_name: str = "",
    preview: str = "",
    mention: bool = False,
) -> bool:
    """Django IM 新消息 → 移动端系统通知。

    接收人和会话目录由消息事务确认后传入。这里仅负责接收人偏好、移动端前台
    抑制、幂等和设备扇出，不参与 IM 消息存储。
    """
    if not is_push_enabled() or not user_id or not conversation_id or not message_id:
        return False
    if sender_id and str(sender_id) == str(user_id):
        return False
    if not _preference_enabled(user_id, SCENE_IM_MESSAGE, mention=mention):
        return False
    if not _acquire_once(
        f"push:sent:im:{user_id}:{message_id}",
        7 * 24 * 60 * 60,
    ):
        return False

    title = (sender_name or "新消息").strip()[:80]
    body = (preview or ("有人提到了你" if mention else "点开查看消息")).strip()[:200]
    return _dispatch(
        user_id=str(user_id),
        scene=SCENE_IM_MESSAGE,
        title=title,
        body=body,
        ext={
            "scene": SCENE_IM_MESSAGE,
            "organization_id": str(organization_id or ""),
            "conversation_id": str(conversation_id),
            "message_id": str(message_id),
            "sender_id": str(sender_id or ""),
            "mention": bool(mention),
        },
        preference_checked=True,
    )


# ── 内部 ─────────────────────────────────────────────────────────────


def _summarize_interaction(payload: dict[str, Any]) -> str:
    """尽力从审批 payload 里提炼工具名，失败就退回通用文案。"""
    approvals = payload.get("approvals")
    if isinstance(approvals, list) and approvals:
        names = [
            str(item.get("tool_name") or item.get("name") or "")
            for item in approvals
            if isinstance(item, dict)
        ]
        names = [n for n in names if n]
        if names:
            head = "、".join(names[:3])
            more = f" 等 {len(names)} 项" if len(names) > 3 else ""
            return f"待审批：{head}{more}"
    question = payload.get("question") or payload.get("prompt") or payload.get("title")
    if isinstance(question, str) and question.strip():
        return question.strip()
    return ""


def _acquire_once(key: str, ttl_seconds: int) -> bool:
    """Redis SETNX 语义的一次性闸门；cache 故障时放行（宁可重推别漏推）。"""
    try:
        from django.core.cache import cache
        return bool(cache.add(key, 1, timeout=ttl_seconds))
    except Exception as exc:
        logger.debug("[Push] dedup gate failed key=%s: %s", key, exc)
        return True


def _preference_enabled(user_id: str, scene: str, *, mention: bool = False) -> bool:
    """读取移动端推送偏好，缺失时默认开启。

    新契约使用 ``mobilePushPrefs.value``；审批/任务完成继续兼容旧分支曾写入的
    ``push_preferences`` 裸结构，避免升级后用户原选择失效。
    """
    pref_key = _PREFERENCE_KEYS.get(scene)
    if not pref_key:
        return True
    try:
        from apps.users.auth.models import UserProfile
        ui_settings = (
            UserProfile.objects
            .filter(user_id=user_id)
            .values_list("ui_settings", flat=True)
            .first()
        )
        if not isinstance(ui_settings, dict):
            return True
        mobile_envelope = ui_settings.get("mobilePushPrefs")
        if isinstance(mobile_envelope, dict):
            prefs = mobile_envelope.get("value")
            if isinstance(prefs, dict):
                if scene == SCENE_IM_MESSAGE:
                    if bool(prefs.get("messages", True)):
                        return True
                    return bool(mention and prefs.get("mentions", True))
                return bool(prefs.get(pref_key, True))

        legacy_prefs = ui_settings.get("push_preferences")
        if not isinstance(legacy_prefs, dict):
            return True
        legacy_key = {
            SCENE_AGENT_DONE: "agent_done",
            SCENE_INTERACTION: "approval",
        }.get(scene)
        return bool(legacy_prefs.get(legacy_key, True)) if legacy_key else True
    except Exception as exc:
        logger.debug("[Push] preference read failed user=%s: %s", user_id, exc)
        return True


def _dispatch(
    *,
    user_id: str,
    scene: str,
    title: str,
    body: str,
    ext: dict[str, Any],
    preference_checked: bool = False,
) -> bool:
    if not user_id:
        return False

    if has_mobile_foreground(user_id):
        logger.debug("[Push] suppressed (mobile foreground): user=%s scene=%s", user_id, scene)
        return False

    if not preference_checked and not _preference_enabled(user_id, scene):
        logger.debug("[Push] suppressed (preference off): user=%s scene=%s", user_id, scene)
        return False

    from apps.services.notification.models import DevicePushRegistration

    registrations = list(
        DevicePushRegistration.objects
        .filter(user_id=str(user_id), provider="apns", platform="ios", is_active=True)
        .values_list("registration_id", "environment")[:20]
    )
    if not registrations:
        return False

    registrations_by_environment: dict[str, list[str]] = {}
    for registration_id, environment in registrations:
        registrations_by_environment.setdefault(environment, []).append(registration_id)

    message = PushMessage(title=title, body=body, ext=ext)
    sent = False
    errors: list[str] = []
    for environment, registration_ids in registrations_by_environment.items():
        provider = get_push_provider(environment)
        result = provider.send(registration_ids, message)
        sent = result.ok or sent
        if result.error:
            errors.append(f"{environment}: {result.error}")
        if result.invalid_registration_ids:
            DevicePushRegistration.objects.filter(
                provider="apns",
                environment=environment,
                registration_id__in=result.invalid_registration_ids,
            ).update(is_active=False)

    if sent:
        logger.info(
            "[Push] sent: user=%s scene=%s devices=%d", user_id, scene, len(registrations),
        )
    else:
        logger.warning(
            "[Push] send failed: user=%s scene=%s error=%s", user_id, scene, "; ".join(errors),
        )
    return sent
