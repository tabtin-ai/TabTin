"""非核心路由延迟注册。

由 DeferredRouterMiddleware 在首次 HTTP 请求到达时触发。
Celery worker / manage.py 命令不加载此模块，避免不必要的重量级 import。

时序保证：
  Middleware.__call__  →  register_deferred_routers()  →  URL resolver 加载 urls.py
  因此所有 add_router 调用发生在 api.urls 被 urlpatterns 捕获之前。
"""

import logging
import os
import time

from django.conf import settings

from .api_instance import api, _safe_add_router

logger = logging.getLogger(__name__)

_registered = False


def register_deferred_routers():
    global _registered
    if _registered:
        return

    t0 = time.monotonic()

    _register_orchestration_routers()
    _register_tab_app_routers()
    _register_service_routers()
    _register_social_and_misc_routers()
    _register_admin_routers()

    _registered = True

    elapsed_ms = (time.monotonic() - t0) * 1000
    logger.info(
        "Deferred routers registered: %d routers in %.0fms",
        len(api._routers), elapsed_ms,
    )


# ── Orchestration & AI ──────────────────────────────────────

def _register_orchestration_routers():
    # ── L2: orchestration 编排层运行时路由已下线，本地 Runtime 接管 ──
    # Agent invoke/review/answer、runs、subagents 执行、debug 等编排运行时路由全部摘除。
    # 保留的是纯数据 CRUD（不涉及编排运行时）：

    from apps.services.agent_engine.api.subagent_template_api import router as subagent_template_router
    _safe_add_router("/orchestration", subagent_template_router, tags=["SubAgent Templates"])

    from apps.services.agent_engine.api.subtask_run_api import router as subtask_run_router
    _safe_add_router("/services/agent-engine", subtask_run_router, tags=["SubtaskRun Notifications"])

    # NOTE: W7「Agent 产物在 Space 内的打开」resource_open 埋点 router 注册
    # 故意放在 _register_service_routers 段（与 /services/sms/ 等服务路由并列），
    # 不放这里——本段 _orchestration 是 Agent 编排路由聚合点，user 行为埋点
    # 不属于 Agent 编排范畴。详见该段实际 add_router 调用点的注释。

    from apps.capabilities.api import router as capabilities_router
    _safe_add_router("/capabilities", capabilities_router, tags=["Capabilities"])

    # ── H2-A FR-10：AdminDash Agent Debug 路由（trace 查询 / 事件时间线 / Prompt 审计）──
    # M5-L2 摘除编排运行时路由时一并被带走（Recon-1 调研确认是"架构连带"非
    # "合规主动决策"，agent transcript `5840381d-af8b-41f2-a183-c0322d604eeb`），
    # 重新挂载让 AdminDash 4xx 不再，运维/Bugbot 能在 admindash `/agent-debug` 看到
    # 本地 Runtime 完整 trace。
    #
    # 路由前缀拼接：在 `/orchestration` 之下，路由内部声明 `debug/traces` /
    # `user/traces` / `health` 等，最终 URL 形如：
    #   - GET  /orchestration/debug/traces
    #   - GET  /orchestration/debug/traces/{trace_id}/events
    #   - POST /orchestration/debug/threads/{thread_id}/debug-mode
    #   - GET  /orchestration/health
    # 与 `apps/admindash/src/api/agent-debug.ts` 的 BASE_PATH 完全对齐。
    from apps.services.agent_engine.api.agentdash_api import router as agentdash_router
    _safe_add_router("/orchestration", agentdash_router, tags=["Agent Debug"])


# ── Tab Apps ─────────────────────────────────────────────────

def _register_tab_app_routers():
    from apps.tabdata.api import router as tabdata_router
    _safe_add_router("/tabdata", tabdata_router, tags=["TabData"])

    from apps.tabdata.api_share import router as tabdata_share_router
    _safe_add_router("/tabdata", tabdata_share_router, tags=["TabData Share"])

    from apps.tabdoc.api import router as tabdoc_router
    _safe_add_router("/tabdoc", tabdoc_router, tags=["TabDoc"])

    from apps.tabdoc.api_share import router as tabdoc_share_router
    _safe_add_router("/tabdoc", tabdoc_share_router, tags=["TabDoc Share"])

    # Wave 1-C：Plan 模式工具链（plan_create / plan_update_todos）。
    # 历史曾有 plan_exit 第三件，已在 PlanProposalCard 重构后移除——
    # 「执行」由用户点击卡片触发 plan-execute IPC，不再走 LLM 工具。
    from apps.tabdoc.api_plan import router as plan_router
    _safe_add_router("/plan", plan_router, tags=["TabDoc Plan"])

    from apps.tabslide.api import router as slide_router
    _safe_add_router("/tabslide", slide_router, tags=["TabSlide"])

    # 单根契约（docs/single-root-space-prd.md §2.7）：tabcode REST 路由已下架，
    # CodeProject 表废弃，前端不再调 /api/tabcode/*。app 自身保留作为废弃壳，
    # migrations 历史不破坏。
    from apps.tabmemo.api import router as tabmemo_router
    _safe_add_router("/tabmemo", tabmemo_router, tags=["TabMemo"])

    from apps.agent_memory.api import router as agent_memory_router
    _safe_add_router("/agent-memory", agent_memory_router, tags=["AgentMemory"])

    from apps.user_portrait.api import router as user_portrait_router
    _safe_add_router("/user-portrait", user_portrait_router, tags=["UserPortrait"])

    from apps.tabsite.api import router as tabsite_router
    _safe_add_router("/tabsite", tabsite_router, tags=["TabSite"])

    from apps.tabdata.api_open_space import router as space_open_router
    _safe_add_router("/open/v1", space_open_router, tags=["Open API"])

    # ：Organization 级 Open API 平行入口（org-only tables / home / db-info）
    from apps.tabdata.api_open_org import router as org_open_router
    _safe_add_router("/open/v1", org_open_router, tags=["Open API"])

    from apps.collab.api import router as collab_router
    _safe_add_router("/collab/v1", collab_router, tags=["Collab"])

    # @create_app: 新增 App 路由由 `python manage.py create_app` 脚手架自动插入到此注释之前，锚点请勿删除


# ── Services ─────────────────────────────────────────────────

def _register_service_routers():
    from apps.services.sms.api import router as sms_router
    _safe_add_router("/services/sms", sms_router)

    from apps.services.email.api import router as email_router
    _safe_add_router("/services/email", email_router)

    from apps.services.oss.api import router as oss_router
    _safe_add_router("/services/oss", oss_router)

    # File Pipeline W3：临时通道 OSS presign（与持久通道同 prefix 但物理代码分离，
    # endpoint 名字 `temp-parse-presign` 与 `presign-upload` 字面区分；不写
    # FileRecord / FileUsage / 不计费——产品决策 D 红线）。
    from apps.services.oss.temp_parse_api import router as oss_temp_parse_router
    _safe_add_router("/services/oss", oss_temp_parse_router, tags=["OSS Temp Parse Channel"])

    from apps.services.llm.api import router as llm_router
    _safe_add_router("/services/llm", llm_router)

    from apps.services.llm.proxy_api import router as llm_proxy_router
    _safe_add_router("/llm", llm_proxy_router, tags=["LLM Proxy"])

    from apps.services.search.api import router as search_router
    _safe_add_router("/search", search_router, tags=["Search"])

    from apps.services.billing.api import router as billing_router
    _safe_add_router("/services/billing", billing_router)

    from apps.services.payment.api import router as payment_router
    _safe_add_router("/services/payment", payment_router)

    from apps.services.speech.api import router as speech_router
    _safe_add_router("/services/speech", speech_router, tags=["Speech Services"])

    from apps.services.music.api import router as music_router
    _safe_add_router("/services/music", music_router, tags=["Music Services"])

    from apps.services.notification.api import router as notification_router
    _safe_add_router("/notifications", notification_router, tags=["Notifications"])

    from apps.services.media_generation.api import router as media_router
    _safe_add_router("/services/media", media_router, tags=["Media Generation"])

    from apps.credential_vault.api import router as credential_vault_router
    _safe_add_router("/credential-vault", credential_vault_router, tags=["Credential Vault"])

    from apps.login_relay.api import router as login_relay_router
    _safe_add_router("/login-relay", login_relay_router, tags=["Login Relay"])

    # 飞书多维表 OAuth + 列表 + 一次性导入（与 Channel Gateway 飞书 Bot 分离）
    from apps.integrations_feishu.api import router as integrations_feishu_router
    _safe_add_router("/integrations/feishu", integrations_feishu_router, tags=["Feishu Bitable"])
    from apps.integrations_github.api import router as integrations_github_router
    _safe_add_router("/integrations/github", integrations_github_router, tags=["GitHub OAuth"])

    # ── Browser Environment ──
    # env 元数据 + Space 绑定全部回到 Electron 主进程本地 JSON 存储，后端 API
    # 与表已下线；当年挂在 /api/browser-env 与 /api/spaces/{id}/env-binding 的
    # 路由全部摘除。前端调用旧 API 应得到 404，不应再触发任何 BrowserEnv 相关错误。

    # v3.1（2026-04-19）：app_connect 已删除（Connect 模型作废，见 PRD-v3.1-方向锚）
    from apps.channel_gateway.api import router as channel_gateway_router
    _safe_add_router("/channel", channel_gateway_router, tags=["Channel Gateway"])

    # Tracker 主入口：波次 4 Stage 2.1 一刀切，唯一 HTTP 前缀 /api/tracker/*。
    # 旧 /agenda/* 与 /goal/* 兼容期 alias 已删除（产品未上线，无客户端依赖）。
    # 2026-05-28 收编：ScheduledJob 子系统（/api/scheduler/*）整体下线；事件目录
    # 归位到 /api/registry/events（见下方 registry router），dry-run 仍在 /api/tracker。
    from apps.tracker.api import router as tracker_router
    _safe_add_router("/tracker", tracker_router, tags=["TabTracker"])

    # App 事件目录（charter §6.3）：平台级 App registry 暴露的 events 元数据查询，
    # 无鉴权（事件本体是公开 schema 声明）。2026-05-28 从 ``/api/scheduler/events``
    # 归位到 ``/api/registry/events``，与 ``services.common.app_registry`` 配对。
    from apps.services.common.api.registry_events import router as registry_events_router
    _safe_add_router("/registry", registry_events_router, tags=["Events Registry"])

    from apps.services.docparse.api import router as docparse_router
    _safe_add_router("/services/docparse", docparse_router, tags=["DocParse"])

    # File Pipeline W3：临时通道同步解析 endpoint（不写 ParsedDocument / 不入
    # RAG / 不计费；完成后主动 delete OSS object——产品决策 D 红线）。
    from apps.services.docparse.temp_parse_api import router as docparse_temp_parse_router
    _safe_add_router("/services/docparse", docparse_temp_parse_router, tags=["DocParse Temp Channel"])

    from apps.services.common.docs_api import router as docs_router
    _safe_add_router("", docs_router)

    from apps.services.common.entity_api import router as entity_router
    _safe_add_router("/entities", entity_router, tags=["Entities"])

    from apps.services.package_registry.api import router as package_registry_router
    _safe_add_router("/services/package-registry", package_registry_router, tags=["Package Registry"])

    # 「Agent 产物在 Space 内的打开」专题 W7：埋点上报通路。
    # Electron main 进程把 ResourceRouter 派发事件按 5s/100 条 batch 上报到
    # `/services/telemetry/resource-open/batch`，bulk_create 落 PG
    # `agent_engine_resource_open_event` —— PRD §6 三个成功标准的数据基础。
    # 详见 RFC §8 + 总控 §2 W7。
    from apps.services.agent_engine.api.telemetry_resource_open_api import (
        router as telemetry_resource_open_router,
    )
    _safe_add_router(
        "/services/telemetry", telemetry_resource_open_router,
        tags=["Resource Open Telemetry"],
    )


# ── Social & Misc ────────────────────────────────────────────

def _register_social_and_misc_routers():
    from apps.tins.api import router as tins_router
    _safe_add_router("/tins", tins_router, tags=["Tins"])

    from apps.rag.api import router as rag_router
    _safe_add_router("/rag", rag_router)

    from apps.skills.api import router as skills_router
    _safe_add_router("/skills", skills_router, tags=["Skills"])

    # Centrifugo Connect/Subscribe proxy 是实时通知基础设施（personal 通知、
    # space 在场感等），与 TabChat IM 业务路由一并注册——只要客户端/部署侧启了
    # Centrifugo 就必须注册 proxy，否则 connect proxy 404 → 客户端 code:100 刷屏。
    from apps.tabchat.centrifugo_proxy import router as centrifugo_proxy_router
    _safe_add_router("/im/centrifugo", centrifugo_proxy_router, tags=["TabChat Centrifugo Proxy"])

    # 资源访问申请正典（非 IM 消息主链路）；表仍由 tabchat app 建立。
    from apps.services.common.resource_access.api import router as resource_access_router
    _safe_add_router(
        "/resource-access-requests",
        resource_access_router,
        tags=["Resource Access"],
    )

    from apps.tabchat.api import router as tabchat_router
    _safe_add_router("/im", tabchat_router, tags=["TabChat"])

    from apps.tabchat.agent_mentions_api import router as agent_mentions_router
    _safe_add_router("/agent-mentions", agent_mentions_router, tags=["Agent Mentions"])

    from apps.updater.api import router as updater_router
    _safe_add_router("/updates", updater_router, tags=["Updates"])

    # 移动端版本门禁（iOS/Android）：匿名公开接口，客户端冷启动查询是否强制/推荐更新。
    from apps.updater.mobile_gate_api import router as mobile_gate_router
    _safe_add_router("/client", mobile_gate_router, tags=["Client Version Gate"])

    from apps.client_errors.api import router as client_errors_router
    _safe_add_router("/client-errors", client_errors_router, tags=["Client Errors"])

    from apps.diagnostics.api import router as diagnostics_router
    _safe_add_router("/diagnostics", diagnostics_router, tags=["Client Diagnostics"])

    # 通用埋点采集（官网 beacon / 客户端上报），匿名 + IP 限流。
    from apps.analytics.api import router as analytics_router
    _safe_add_router("/analytics", analytics_router, tags=["Analytics"])

    from apps.platform_config.api import router as platform_config_router
    _safe_add_router("/platform-config", platform_config_router, tags=["Platform Config"])


# ── Admin API（保留原有条件判断）────────────────────────────

def _register_admin_routers():
    from django.conf import settings as django_settings

    if not (django_settings.DEBUG or os.getenv('TABTIN_ENABLE_ADMIN_API', '0') == '1'):
        return

    from apps.users.auth.admin_api import router as auth_admin_router
    _safe_add_router("/auth/admin", auth_admin_router, tags=["Admin User Management"])
    from apps.tabtinspace.content_admin_api import router as content_admin_router
    _safe_add_router("/auth/admin", content_admin_router, tags=["Admin Content Operations"])
    from apps.tabdata.admin_api import router as tabdata_admin_router
    _safe_add_router("/auth/admin", tabdata_admin_router, tags=["Admin Table Management"])
    # W3.4 / D2: Schema Integrity V2 + C1 字段回收站
    from apps.tabdata.api_admin_integrity import router as tabdata_integrity_router
    _safe_add_router(
        "/auth/admin", tabdata_integrity_router,
        tags=["Admin Schema Integrity"],
    )
    from apps.tabdoc.admin_api import router as tabdoc_admin_router
    _safe_add_router("/auth/admin", tabdoc_admin_router, tags=["Admin Doc Management"])
    from apps.tabslide.admin_api import router as tabslide_admin_router
    _safe_add_router("/auth/admin", tabslide_admin_router, tags=["Admin Slide Management"])
    from apps.tabtinspace.admin_api import router as tabtinspace_admin_router
    _safe_add_router("/auth/admin", tabtinspace_admin_router, tags=["Admin Space Project Management"])
    from apps.services.oss.admin_api import router as oss_admin_router
    _safe_add_router("/auth/admin", oss_admin_router, tags=["Admin Asset Management"])
    from apps.chat.conversation.admin_api import router as chat_admin_router
    _safe_add_router("/auth/admin", chat_admin_router, tags=["Admin Chat Config"])
    from apps.maintenance.admin_api import router as maintenance_admin_router
    _safe_add_router("/auth/admin", maintenance_admin_router, tags=["Admin Celery Management"])
    from apps.maintenance.admin_ops_api import router as admin_ops_router
    _safe_add_router("/admin", admin_ops_router, tags=["Admin Ops Governance"])
    from apps.updater.admin_api import router as updater_admin_router
    _safe_add_router("/auth/admin", updater_admin_router, tags=["Admin Desktop Updates"])
    from apps.updater.mobile_admin_api import router as mobile_version_admin_router
    _safe_add_router("/auth/admin", mobile_version_admin_router, tags=["Admin Mobile Version Gate"])
    from apps.services.media_generation.admin_api import router as media_admin_router
    _safe_add_router("/auth/admin", media_admin_router, tags=["Admin Media Generation"])
    from apps.services.speech.admin_api import router as speech_admin_router
    _safe_add_router("/auth/admin", speech_admin_router, tags=["Admin Speech TTS"])
    from apps.services.search.admin_api import router as search_admin_router
    _safe_add_router("/auth/admin", search_admin_router, tags=["Admin Search"])
    from apps.client_errors.admin_api import router as client_errors_admin_router
    _safe_add_router("/auth/admin", client_errors_admin_router, tags=["Admin Client Errors"])
    from apps.services.llm.views.admin_api import router as llm_admin_router
    _safe_add_router("/auth/admin", llm_admin_router, tags=["Admin LLM"])
    from apps.tabtinspace.admin_app_platform_api import router as app_platform_admin_router
    _safe_add_router("/auth/admin", app_platform_admin_router, tags=["Admin App Platform"])
    from apps.skills.admin_api import router as skills_admin_router
    _safe_add_router("/auth/admin", skills_admin_router, tags=["Admin Skills Review"])
    from apps.platform_config.admin_api import router as platform_config_admin_router
    _safe_add_router("/auth/admin", platform_config_admin_router, tags=["Admin Platform Config"])
    from apps.analytics.admin_api import router as analytics_admin_router
    _safe_add_router("/auth/admin", analytics_admin_router, tags=["Admin Analytics"])
