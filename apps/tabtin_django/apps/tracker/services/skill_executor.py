"""Tracker 执行路径（预绑定 Skill 或纯 Agent 模式）。

Wave 2：从 ``skill_executor_v2`` 收敛而来——

- 删除 ``_run_skill_script``：脚本执行能力已移除（NotImplementedError）。
- 保留 ``run_skill_based`` / ``_run_skill_agent`` / ``_resolve_skill``。
- charter §6.7 / §7.2：Run 关联 ChatSession。``_run_skill_agent`` 在首次 attempt
  创建 ChatSession 并回填 ``TrackerRun.chat_session_id``；同 Run 的重试/重派复用
  该 session，避免外键被顶掉后产生漏进主列表的孤儿对话。

注意：表格 Skill 字段（TabData AI 字段）已彻底下架。原 ``_run_skill_field_batch``
分支随之删除——现在所有 Tracker 都走 Agent 对话路径；``skill_key`` 非空时
额外注入预绑定 Skill 方法论，空值时由 Agent 自助选择可用 Skill。
"""

from __future__ import annotations

import logging

from django.utils import timezone  # noqa: F401  # used by _run_skill_agent

from apps.services.common.agent_protocol.constants import CHAT_METADATA_ORIGIN_TRACKER
from apps.tracker.models import Tracker, TrackerRun
from apps.tracker.services.tracker_notification import TrackerNotificationService
from apps.tracker.constants import (
    TRANSIENT_RETRY_CONTEXT_KEY,
    build_tracker_run_session_title,
    is_tracker_run_session_title,
)
from apps.tracker.services.tracker_executor import (
    _fail_tracker_run,
    _is_device_dispatchable,
    _resolve_tracker_binding_device,
    _release_tracker_run_runtime_claim,
    _update_tracker_stats,
    maybe_schedule_transient_retry,
    suspend_tracker_run_waiting_device,
)

logger = logging.getLogger(__name__)


def _resolve_tracker_run_index(tracker_run: TrackerRun, tracker: Tracker) -> int:
    """与 list API 同口径：同 Tracker 按 created_at 升序的位次。"""
    created_at = getattr(tracker_run, "created_at", None)
    filters: dict = {"tracker_id": tracker.id}
    if created_at is not None:
        filters["created_at__lte"] = created_at
    return max(TrackerRun.objects.filter(**filters).count(), 1)


def _resolve_or_create_tracker_chat_session(tracker_run: TrackerRun, tracker: Tracker, creator):
    """为本次 TrackerRun 解析可复用的 ChatSession；没有则新建。

    ：同一 Run 的掉线重派 / 瞬态重试必须复用首次 attempt 创建的 **active**
    session，并保持 ``TrackerRun.chat_session`` 指向它——列表分桶与归档都依赖该 FK。
    会话已物理删除（FK SET_NULL / 行缺失）或已软归档时走新建：不把用户归档过的
    对话拨回 active；旧 archived 行保持归档态，更新 FK 后不再进主列表。

    标题落库为「自动化任务 "name" 的第 N 次记录」，并标 title_generation_status=done，
    避免被 generate_session_title / backfill 改成「未命名」或 LLM 另起的标题。
    """
    from django.db import transaction

    from apps.chat.conversation.models import ChatSession, ChatContext

    space_id = str(tracker.workspace_id) if tracker.workspace_id else None
    context_data = {
        "current_space_id": space_id,
        "current_app_type": "tabtracker",
        "skill_key": tracker.skill_key,
    }
    run_index = _resolve_tracker_run_index(tracker_run, tracker)
    desired_title = build_tracker_run_session_title(tracker.name, run_index)

    existing_id = getattr(tracker_run, "chat_session_id", None)
    if existing_id:
        session = ChatSession.objects.filter(id=existing_id).first()
        if session is not None and getattr(session, "status", "active") == "active":
            updates: dict = {}
            # 空标题 / 系统生成的 Tracker 标题（含过时序号）→ 拨到产品可见名。
            # 用户手改的其它标题不动。
            current_title = (getattr(session, "title", None) or "").strip()
            should_refresh_title = not current_title or (
                is_tracker_run_session_title(current_title)
                and current_title != desired_title
            )
            if should_refresh_title:
                updates["title"] = desired_title
                updates["title_generation_status"] = "done"
            if updates:
                ChatSession.objects.filter(id=session.id).update(**updates)
                for key, value in updates.items():
                    setattr(session, key, value)
            ChatContext.objects.get_or_create(
                session=session,
                defaults={
                    "current_space_id": space_id or "",
                    "context_data": context_data,
                },
            )
            logger.info(
                "[Tracker] reusing chat_session %s for run %s",
                session.id,
                tracker_run.id,
            )
            return session

    # create + 回填同事务：避免 session 已建但 FK 未写入时产生漏进主列表的孤儿。
    with transaction.atomic():
        session = ChatSession.objects.create(
            user=creator,
            organization_id=str(tracker.organization_id),
            agent_id=tracker.agent_id,
            workspace_id=tracker.workspace_id,
            title=desired_title,
            title_generation_status="done",
        )
        TrackerRun.objects.filter(id=tracker_run.id).update(chat_session_id=session.id)
        tracker_run.chat_session_id = session.id
        ChatContext.objects.create(
            session=session,
            current_space_id=space_id or "",
            context_data=context_data,
        )
    return session


def run_skill_based(tracker_run: TrackerRun):
    """Tracker 执行入口（charter §6.7）：触发 Agent 对话完成任务。

    两种模式（2026-06 纯 Agent 模式）：
    - **绑定 Skill**（skill_key 非空）：解析该 Skill 的 SKILL.md，把方法论拼进 prompt
      作为 Agent 上下文（保持 charter v1.8 §6.4 单 Skill 语义）。
    - **纯 Agent**（skill_key 为空）：不预绑 Skill，指令(skill_params.instructions)
      作为任务直接派给 Agent；Agent runtime 每轮自动注入可用 Skill 清单 +
      skills_search/skills_read 工具，由 Agent 自助挑选合适 Skill。
    """
    tracker = tracker_run.tracker
    skill_key = tracker.skill_key
    notifier = TrackerNotificationService(tracker_run)

    logger.info(
        "[Tracker] run: tracker=%s skill=%s run=%s",
        tracker.id, skill_key or "<pure-agent>", tracker_run.id,
    )

    notifier.notify_progress(tracker_run)

    skill_data = None
    if skill_key:
        try:
            skill_data = _resolve_skill(skill_key, str(tracker.organization_id))
        except Exception as exc:
            # Wave 6 (charter §4.4):传 raw exc 文本给 _fail_tracker_run,翻译在那一层做。
            # 这里组合成人话 prefix 而非堆栈式 "Skill 解析失败: xxx" — 翻译规则会识别
            # 包含 "skill 解析失败" 关键词后输出标准模板。
            _fail_tracker_run(tracker_run, f"Skill 解析失败: {skill_key} — {exc}", notifier)
            return

        if not skill_data:
            _fail_tracker_run(tracker_run, f"Skill 未找到: {skill_key}", notifier)
            return

    _run_skill_agent(tracker_run, skill_data, notifier)


def _resolve_skill(skill_key: str, organization_id: str) -> dict | None:
    """查找 Skill 信息（Wave 1 起统一通过 ``SkillPackageLoader`` 跨 4 来源解析）。

    SkillPackageLoader 已经支持 canonical key（user:<slug> / platform:<id> /
    app:<id>）和裸 id 双输入，云端 user skill 通过 ``_load_from_user_db`` 直接
    查 ``Skill`` 表。
    """
    try:
        from apps.skills.services.package_loader import SkillPackageLoader
        package = SkillPackageLoader.load(skill_key, organization_id=organization_id)
        if package:
            return {
                "skill_key": skill_key,
                "name": package.name or skill_key,
                "has_main": package.has_main,
                "doc_content": package.doc_content or "",
                "script_content": package.script_content or "",
                "source": package.source or "platform",
            }
    except Exception:
        logger.debug(
            "[Tracker] SkillPackageLoader.load failed for %s",
            skill_key, exc_info=True,
        )

    return None


def _run_skill_agent(tracker_run: TrackerRun, skill_data: dict | None, notifier):
    """charter §6.7：Agent 在 react 循环中完成任务。

    ``skill_data`` 为 None 时即「纯 Agent 模式」——不预绑 Skill，靠指令驱动，
    Agent 自助找 Skill（见 run_skill_based）。

    首次 attempt 创建 ChatSession 并回填 ``TrackerRun.chat_session_id``；同 Run
    重试/重派复用该 session（ / charter §7.2）。
    """
    tracker = tracker_run.tracker
    doc_content = (skill_data or {}).get("doc_content", "")
    progress_label = (skill_data or {}).get("name") or tracker.name

    # 任务主体优先取指令(skill_params.instructions——表单的「给 Agent 的详细提示」)，
    # 回落到 description（存量 Tracker），再回落到 name。纯 Agent 模式下指令即任务。
    instructions = ""
    if isinstance(tracker.skill_params, dict):
        instructions = (tracker.skill_params.get("instructions") or "").strip()
    description = (tracker.description or "").strip()
    task_text = instructions or description or tracker.name

    # ：纯 Agent 模式若从未填写指令（创建时 skill_params 为空/instructions null），
    # 只会把任务名当 prompt，现场表现为秒败且文案含糊。缺指令时清晰失败，引导去编辑。
    if not tracker.skill_key and not instructions and not description:
        _fail_tracker_run(
            tracker_run,
            "未填写执行指令，无法执行。请编辑任务补上「执行指令」后再试。",
            notifier,
        )
        return

    # TS-27：执行期间 RemoteAgentDispatcher.send_message_sync 同步阻塞、中途不回写进度，
    # 设非 0 占位百分比会让前端进度条永远卡在假数字。设 0：前端 RunItem 守卫
    # (progress_pct > 0 && status === 'running') 此时只显示 spinner + 文案，不显示假百分比。
    tracker_run.progress_pct = 0
    tracker_run.progress_message = f"Agent 执行 {progress_label}…"
    tracker_run.save(update_fields=["progress_pct", "progress_message"])
    notifier.notify_progress(tracker_run)

    prompt_parts = [f"## 任务\n{task_text}"]
    if doc_content:
        prompt_parts.append(f"## Skill 方法论\n{doc_content}")
    if doc_content:
        prompt_parts.append("请根据以上任务和方法论，独立完成并汇报结果。")
    else:
        prompt_parts.append(
            "请独立完成以上任务并汇报结果。如有合适的 Skill 可用，"
            "可自行搜索并调用（skills_search / skills_read）。"
        )
    combined_prompt = "\n\n".join(prompt_parts)

    try:
        # 用 created_by_id 先判空；再安全取 FK。直接 `if not tracker.created_by`
        # 在用户已删、FK 悬空时会抛 RelatedObjectDoesNotExist，被外层吞成「执行没能跑完」。
        creator = None
        if tracker.created_by_id:
            try:
                creator = tracker.created_by
            except Exception:
                logger.warning(
                    "[Tracker] created_by FK broken for tracker %s created_by_id=%s",
                    tracker.id,
                    tracker.created_by_id,
                    exc_info=True,
                )
                creator = None
        if not creator:
            _fail_tracker_run(
                tracker_run,
                f"Tracker '{tracker.name}' 的创建者不存在，无法发起 Agent 执行",
                notifier,
            )
            return

        # 离线韧性 M1：设备闸门**前置到 ChatSession 解析/创建之前**。
        # ：挂起保留已有 chat_session 引用，重投时复用同一条对话，不再清空 FK。
        # - 无绑定设备（TS-18 场景 A）→ 维持现状清晰秒败（没有设备可等）；
        # - 有绑定但 DB 离线 / WS 不可达 → running→waiting_device 挂起，
        #   由本机 agent-host 对账后续跑。
        workspace = tracker.workspace
        if workspace is None or tracker.agent_id is None:
            _fail_tracker_run(
                tracker_run,
                "Tracker 缺少预授权的 Agent × Workspace 绑定",
                notifier,
            )
            return
        control_device = workspace.device
        if control_device is None:
            agent_name = (
                getattr(getattr(tracker, "agent", None), "name", None) or tracker.name
            )
            _fail_tracker_run(
                tracker_run,
                f"执行 Agent『{agent_name}』未绑定可用设备，无法运行无人值守任务",
                notifier,
            )
            return
        if not _is_device_dispatchable(control_device):
            suspend_tracker_run_waiting_device(
                tracker_run, control_device, notifier,
            )
            return

        from apps.services.remote_agent import RemoteAgentDispatcher

        session = _resolve_or_create_tracker_chat_session(
            tracker_run, tracker, creator,
        )
        app_context = {
            "current_space_id": str(tracker.workspace_id) if tracker.workspace_id else None,
            "current_app_type": "tabtracker",
            "_origin_source": CHAT_METADATA_ORIGIN_TRACKER,
            "_tracker_tracker_id": str(tracker.id),
            "_tracker_tracker_run_id": str(tracker_run.id),
            "skill_key": tracker.skill_key,
            # ：气泡只展示用户指令；## 任务 / Skill 方法论 / 引导语留在
            # combined_prompt 给 Agent。forward_runner 优先用 display_message 落库。
            "display_message": task_text,
            # 自动化＝长任务：显式覆盖 forward 的对话默认 600s 超时。
            # forward_runner.DEFAULT_TIMEOUT_SECONDS 注释明确「scheduler 等长任务由调用方
            # 在 app_context 显式覆盖」，但此前漏传 → 抓数据/建文档类任务被按对话标准 10 分钟
            # 砍断（实测 GitHub Trending run 跑到 600s 被 forward 强切、结果全丢）。
            # 上限受 forward_runner.MAX_TIMEOUT_SECONDS(7200s) 钳制。
            "runtime_timeout_seconds": 1800,
        }
        # charter v1.8 §7.1：skill_params 透传给 Agent runtime（如有）。
        if tracker.skill_params:
            app_context["skill_params"] = tracker.skill_params

        # TS-7（charter v1.8 §7.1）：把 Tracker 选定的执行 Agent 显式透传给调度层。
        # device_resolver._extract_explicit_agent_id 只认 ``_execution_agent_id``；
        # 不传时 resolve_dispatch_target 会回落到 Space 默认绑定 Agent——这会让
        # 用户在创建 Tracker 时选择的「谁来执行」失效（权限/审计/归属全部错位）。
        # agent_id 为空时保持原回落语义，不塞空值以免下游解析异常。
        if tracker.agent_id:
            app_context["_execution_agent_id"] = str(tracker.agent_id)

        # TS-7 / TS-18 / ：执行模型须经 catalog 校验。preferred 不在列表
        # （已删 / 不可见 / stale BYOK）时回落组织默认与系统默认链，禁止盲信透传。
        preferred_model_id = None
        if tracker.agent_id:
            try:
                preferred_model_id = tracker.agent.preferred_model_id
            except Exception:
                logger.debug("[Tracker] resolve agent preferred_model_id failed", exc_info=True)

        from apps.services.agent_execution.model_resolver import resolve_execution_model_id

        org_id = (
            getattr(session, "organization_id", None)
            or getattr(workspace, "organization_id", None)
        )
        execution_model_id = resolve_execution_model_id(
            preferred_model_id=preferred_model_id,
            organization_id=str(org_id) if org_id else None,
            user_id=str(creator.id) if creator is not None else None,
            session=session,
        )
        # 仅当 catalog / 默认链都解析不出任何可聊模型时才清晰失败（运维/配置问题），
        # 绝不引导用户去「给 Agent 手选模型」——那不是产品预期路径。
        if not execution_model_id:
            _fail_tracker_run(
                tracker_run,
                "系统默认模型解析失败，当前没有可路由的聊天模型。请检查模型路由配置后再试。",
                notifier,
            )
            return

        # TS-18（v1 决策 C）「无设备闸门」已随离线韧性 M1 前移到 ChatSession 创建
        # 之前（见本函数开头）。闸门通过后 forward 瞬间掉线的 race（场景 C 残留）
        # 概率低，维持现状按 dispatcher 的 device_unreachable 路径秒败——这正是
        # WS 断开 30s 宽限覆盖的窗口。

        tracker_run.refresh_from_db(fields=["status"])
        if tracker_run.status == "cancelled":
            logger.info(
                "[Tracker] Skill agent run cancelled before dispatch: %s",
                tracker_run.id,
            )
            notifier.notify_progress(tracker_run)
            return

        result = RemoteAgentDispatcher.send_message_sync(
            session_id=str(session.id),
            user=creator,
            message=combined_prompt,
            client_type="server",
            execution_profile="task",
            app_context=app_context,
            model_id=str(execution_model_id) if execution_model_id else None,
            # 无人值守闸门：Tracker 是后台定时 / 手动「立即执行」任务，没有人在 Chat 里
            # 点工具审批。execution_profile="task" 自带的 server_auto 全自动授权只在云端
            # lightweight 引擎生效，**设备 forward 路径完全用不上**（forward_runner 不透传
            # execution_profile）——设备端 runtime 的 judge 只认 effectiveMode='yolo' 才
            # 全放行（security-policy/build-policy.ts 三方 AND：requested=='yolo' &&
            # agent.allow_yolo_mode && !isGroupSpace）。不传 yolo 时 judge 对写文件 / 跑终端 /
            # MCP 判 ask → 发 approval_requested → 无人点 → interactive 档等 30 分钟超时 →
            # runtime 不发 message_stop → assistant 不落库、界面空（实测设备 run 全程 0
            # assistant）。这里显式请求 yolo 档。
            #
            # 产品决策（自动化默认最高权限）：与 interaction_mode='scheduled' 配对，
            # 设备端 build-policy 对无人值守(scheduled)会话的 yolo 请求**绕过 per-Agent
            # allow_yolo_mode 闸门**直接生效（含 Agent 显式 allow_yolo_mode=false 的
            # 绝对提权，见 security-policy/build-policy.ts 的 `unattended` 维度 + host 的
            # buildJudgePolicy 闭包）。red line（hardline / 敏感外发）即便 yolo 也仍被
            # judge step1 拒、group Space 仍强制互斥降级——安全边界不破。
            agent_mode="yolo",
            # 无人值守交互档：yolo 只解决「judge 判工具要不要审批」；LLM 主动调
            # ask_user / ask_form 是另一条路（ask-tools 默认等 30
            # 分钟），yolo 拦不住。传 scheduled 让设备 host：(1) 把
            # LocalPermissionHandler.runtimeMode 设 scheduled（judge-ask 0 秒 fail-fast，
            # 兜住 yolo 闸门没开的情况）；(2) 让本 session 的 waitForUserInput 立即
            # reject → ask-tools 走 catch 返回 timeout error、Agent 继续（不再静默挂死
            # 等满 30 分钟、最终 cancelled）。与 agent_mode=yolo 互补。
            interaction_mode="scheduled",
        )

        tracker_run.refresh_from_db(fields=["status"])
        if tracker_run.status == "cancelled":
            logger.info("[Tracker] Skill agent run cancelled during execution: %s", tracker_run.id)
            notifier.notify_progress(tracker_run)
            return
        if tracker_run.status not in ("pending", "running"):
            logger.info(
                "[Tracker] Skill agent run already finalized during execution: %s status=%s",
                tracker_run.id,
                tracker_run.status,
            )
            notifier.notify_progress(tracker_run)
            return

        reply = ((result or {}).get("reply") or "").strip()
        # W13 修复：`error_category` 是 dispatcher 真实字段（非 `error`）。
        error_category = (result or {}).get("error_category")
        if error_category == "cancelled":
            tracker_run.refresh_from_db(fields=["status"])
            logger.info(
                "[Tracker] Skill agent run cancelled by runtime: %s status=%s",
                tracker_run.id,
                tracker_run.status,
            )
            notifier.notify_progress(tracker_run)
            return

        is_empty = len(reply) < 10
        ctx = tracker_run.context or {}

        if error_category:
            err_msg = (result or {}).get("error_message") or error_category
            ctx["agent_result"] = {
                "response": "",
                "error_category": str(error_category),
                "error_message": str(err_msg)[:500],
            }
            tracker_run.context = ctx
            # 设备离线 / 中途掉线：挂起 waiting_device，等上线重派（不直接判死）。
            if str(error_category) in (
                "device_offline",
                "device_unreachable",
                "device_dropped",
            ):
                TrackerRun.objects.filter(id=tracker_run.id).update(context=ctx)
                device = _resolve_tracker_binding_device(tracker)
                if device is not None:
                    if suspend_tracker_run_waiting_device(tracker_run, device, notifier):
                        # ：保留 chat_session_id，重派时复用同一条对话。
                        return

            # 瞬态失败（429 / timeout 等）：延迟自动重试，不落终态。
            TrackerRun.objects.filter(id=tracker_run.id).update(context=ctx)
            tracker_run.refresh_from_db()
            if maybe_schedule_transient_retry(
                tracker_run,
                error=str(err_msg),
                error_category=str(error_category),
                notifier=notifier,
            ):
                return

            tracker_run.status = "failed"
            # Wave 6 (charter §4.4 / 6.1):error_summary / progress_message
            # 都必须人话化,不许甩 "Agent 返回错误: <堆栈/错误码>"。
            from apps.tracker.utils import humanize_failure_message, translate_skill_error
            payload = translate_skill_error(
                str(err_msg),
                skill_key=tracker.skill_key,
                error_category=str(error_category),
            )
            ctx["recovery_actions"] = payload.get("recovery_action_items", [])
            humanized = humanize_failure_message(
                str(err_msg),
                skill_key=tracker.skill_key,
                error_category=str(error_category),
            )
            retry_attempt = int(ctx.get(TRANSIENT_RETRY_CONTEXT_KEY) or 0)
            if retry_attempt > 0:
                humanized = f"{humanized}（已自动重试 {retry_attempt} 次）"
            tracker_run.error_summary = humanized
            tracker_run.progress_pct = 100
            tracker_run.progress_message = humanized
            tracker_run.context = ctx
        elif is_empty:
            ctx["agent_result"] = {"response": reply[:5000]}
            tracker_run.context = ctx
            tracker_run.status = "failed"
            # Wave 6:走翻译器统一兜底文案(命中 "agent 未返回有效结果" 关键词)。
            from apps.tracker.utils import humanize_failure_message
            humanized = humanize_failure_message(
                "Agent 未返回有效结果",
                skill_key=tracker.skill_key,
            )
            tracker_run.error_summary = humanized
            tracker_run.progress_pct = 100
            tracker_run.progress_message = humanized
        else:
            ctx["agent_result"] = {"response": reply[:5000]}
            tracker_run.context = ctx
            tracker_run.status = "completed"
            tracker_run.progress_pct = 100
            tracker_run.progress_message = reply[:200]
            tracker_run.error_summary = ""

        tracker_run.finished_at = timezone.now()
        tracker_run.duration = (tracker_run.finished_at - (tracker_run.started_at or tracker_run.finished_at)).total_seconds()
        updated = TrackerRun.objects.filter(
            id=tracker_run.id,
            status__in=("pending", "running"),
        ).update(
            status=tracker_run.status,
            context=tracker_run.context,
            progress_pct=tracker_run.progress_pct,
            progress_message=tracker_run.progress_message,
            error_summary=tracker_run.error_summary,
            finished_at=tracker_run.finished_at,
            duration=tracker_run.duration,
        )
        if updated == 0:
            tracker_run.refresh_from_db(fields=["status"])
            logger.info(
                "[Tracker] Skill agent terminal write skipped because run already finalized: %s status=%s",
                tracker_run.id,
                tracker_run.status,
            )
            notifier.notify_progress(tracker_run)
            return
    except Exception as exc:
        # Wave 6 (charter §4.4):exc 内容含堆栈风险——_fail_tracker_run 会过 humanize_failure_message
        # 翻译为人话(命中 timeout/connection/permission 等关键词时定向翻译,否则 fallback)。
        _fail_tracker_run(tracker_run, f"execution failed: {exc}", notifier)
        return

    _update_tracker_stats(tracker.id, success=(tracker_run.status == "completed"))
    _release_tracker_run_runtime_claim(tracker_run, reason="skill_agent_terminal")

    notifier.notify_progress(tracker_run)
    if tracker_run.status == "completed":
        notifier.notify_run_completed(tracker_run)
        try:
            from apps.tracker.services.tracker_trigger_service import trigger_by_tracker_completed
            trigger_by_tracker_completed(str(tracker.id), str(tracker_run.id), trigger_context=tracker_run.trigger_context)
        except Exception:
            logger.debug("[Tracker] tracker_completed cascade failed", exc_info=True)
    else:
        notifier.notify_run_failed(tracker_run)


def prepare_tracker_run_for_host(tracker_run: TrackerRun, device) -> dict:
    """本机认领 Run：建会话、写 running，返回本机开 Agent 所需字段。不经云执行队列。"""
    from django.core.exceptions import ValidationError

    from apps.services.common.agent_protocol.constants import CHAT_METADATA_ORIGIN_TRACKER
    from apps.tracker.services.tracker_executor import _stamp_current_attempt_started_at

    tracker = tracker_run.tracker
    notifier = TrackerNotificationService(tracker_run)
    skill_key = tracker.skill_key
    skill_data = None
    if skill_key:
        try:
            skill_data = _resolve_skill(skill_key, str(tracker.organization_id))
        except Exception as exc:
            _fail_tracker_run(tracker_run, f"Skill 解析失败: {skill_key} — {exc}", notifier)
            raise ValidationError(f"Skill 解析失败: {skill_key}") from exc
        if not skill_data:
            _fail_tracker_run(tracker_run, f"Skill 未找到: {skill_key}", notifier)
            raise ValidationError(f"Skill 未找到: {skill_key}")

    instructions = ""
    if isinstance(tracker.skill_params, dict):
        instructions = (tracker.skill_params.get("instructions") or "").strip()
    description = (tracker.description or "").strip()
    task_text = instructions or description or tracker.name
    if not tracker.skill_key and not instructions and not description:
        _fail_tracker_run(
            tracker_run,
            "未填写执行指令，无法执行。请编辑任务补上「执行指令」后再试。",
            notifier,
        )
        raise ValidationError("未填写执行指令")

    creator = None
    if tracker.created_by_id:
        try:
            creator = tracker.created_by
        except Exception:
            creator = None
    if not creator:
        _fail_tracker_run(
            tracker_run,
            f"Tracker '{tracker.name}' 的创建者不存在，无法发起 Agent 执行",
            notifier,
        )
        raise ValidationError("Tracker 创建者不存在")

    workspace = tracker.workspace
    if workspace is None or tracker.agent_id is None:
        _fail_tracker_run(
            tracker_run,
            "Tracker 缺少预授权的 Agent × Workspace 绑定",
            notifier,
        )
        raise ValidationError("Tracker 缺少 Agent × Workspace 绑定")
    if workspace.device_id != device.id:
        raise PermissionError("Tracker 未绑定到当前设备")

    doc_content = (skill_data or {}).get("doc_content", "")
    prompt_parts = [f"## 任务\n{task_text}"]
    if doc_content:
        prompt_parts.append(f"## Skill 方法论\n{doc_content}")
        prompt_parts.append("请根据以上任务和方法论，独立完成并汇报结果。")
    else:
        prompt_parts.append(
            "请独立完成以上任务并汇报结果。如有合适的 Skill 可用，"
            "可自行搜索并调用（skills_search / skills_read）。"
        )
    combined_prompt = "\n\n".join(prompt_parts)

    claimed = TrackerRun.objects.filter(
        id=tracker_run.id,
        status__in=("pending", "waiting_device"),
    ).update(
        status="running",
        progress_pct=0,
        progress_message=f"Agent 执行 {(skill_data or {}).get('name') or tracker.name}…",
    )
    if not claimed:
        tracker_run.refresh_from_db(fields=["status"])
        if tracker_run.status == "running" and tracker_run.chat_session_id:
            session_id = str(tracker_run.chat_session_id)
        else:
            raise ValidationError(f"Run 当前状态为 {tracker_run.status}，无法认领")
    else:
        tracker_run.status = "running"
        _stamp_current_attempt_started_at(tracker_run)
        session = _resolve_or_create_tracker_chat_session(tracker_run, tracker, creator)
        session_id = str(session.id)

    from apps.services.agent_execution.model_resolver import resolve_execution_model_id

    preferred_model_id = None
    if tracker.agent_id:
        try:
            preferred_model_id = tracker.agent.preferred_model_id
        except Exception:
            preferred_model_id = None
    execution_model_id = resolve_execution_model_id(
        preferred_model_id=preferred_model_id,
        organization_id=str(tracker.organization_id),
        user_id=str(creator.id),
        session=None,
    )
    if not execution_model_id:
        _fail_tracker_run(
            tracker_run,
            "系统默认模型解析失败，当前没有可路由的聊天模型。请检查模型路由配置后再试。",
            notifier,
        )
        raise ValidationError("系统默认模型解析失败")

    task_id = f"host-tracker-{tracker_run.id}"
    ctx = dict(tracker_run.context or {})
    ctx["runtime_task_id"] = task_id
    ctx["_runtime_task_id"] = task_id
    TrackerRun.objects.filter(id=tracker_run.id).update(context=ctx)
    notifier.notify_progress(tracker_run)

    return {
        "prepared": True,
        "run_id": str(tracker_run.id),
        "tracker_id": str(tracker.id),
        "session_id": session_id,
        "agent_id": str(tracker.agent_id),
        "workspace_id": str(tracker.workspace_id),
        "prompt": combined_prompt,
        "display_message": task_text,
        "model_id": str(execution_model_id),
        "task_id": task_id,
        "skill_key": tracker.skill_key,
        "skill_params": tracker.skill_params or {},
        "app_context": {
            "current_space_id": str(tracker.workspace_id) if tracker.workspace_id else None,
            "current_app_type": "tabtracker",
            "_origin_source": CHAT_METADATA_ORIGIN_TRACKER,
            "_tracker_tracker_id": str(tracker.id),
            "_tracker_tracker_run_id": str(tracker_run.id),
            "skill_key": tracker.skill_key,
            "display_message": task_text,
            "runtime_timeout_seconds": 1800,
            **({"skill_params": tracker.skill_params} if tracker.skill_params else {}),
            "_execution_agent_id": str(tracker.agent_id),
        },
    }
