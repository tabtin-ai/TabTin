"""
TabSlide 协作服务

处理 Agent 推送幻灯片元素变更到 collab-live 的流程。
Y.js-first 架构：Agent 变更先注入 Y.Doc，由 Hocuspocus onStore
自动持久化到 DB，与用户编辑共享同一条链路。
"""

import logging

logger = logging.getLogger(__name__)


def is_yjs_first_enabled(product: str = "tabslide") -> bool:
    """[已迁移] 请使用 apps.services.common.config.is_yjs_first_enabled"""
    from apps.services.common.config import is_yjs_first_enabled as _impl
    return _impl(product)


class SlideCollabService:
    """TabSlide 协作服务"""

    @staticmethod
    def push_element_changes(
        project_id: str,
        changes: list[dict],
        agent_id: str = "",
        editor_type: str = "agent",
    ) -> dict:
        """
        推送元素级变更到 collab-live（Y.js-first 链路）。

        同步 HTTP 调用，成功才返回。变更将通过 Y.js CRDT 自动合并、
        广播给在线客户端，并由 Hocuspocus onStore 自动持久化。

        通过统一 apply-ops 发送，区分元素级操作（add/update/delete）。

        如果 collab-live 调用失败（Yjs 状态损坏、服务不可达等），降级返回
        错误信息而非抛出异常，允许调用方走 DB fallback 链路。

        Args:
            project_id: 幻灯片项目 ID
            changes: 元素级变更列表，每项需包含 page_id, element_id,
                     以及 type(add/update/delete), element(add), patch(update)
            agent_id: 编辑者标识（用于审计追踪）
            editor_type: "user" | "agent" | "system"，影响 persist 权限校验路径

        Returns:
            {"applied": int, "total": int} 或 {"error": str, "applied": 0, "total": N}
        """
        from apps.collab.apply_ops import CollabApplyOpsService
        from apps.services.common.platform_context import get_current_run_id

        if not changes:
            return {"applied": 0, "total": 0}

        ops = []
        skipped = 0
        for c in changes:
            op = c.get("type") or c.get("op")
            if not op:
                skipped += 1
                logger.warning(
                    "Skipping change with missing op/type: project=%s change=%r",
                    project_id, c,
                )
                continue
            page_id = c.get("page_id")
            element_id = c.get("element_id")
            if not page_id or not element_id:
                skipped += 1
                logger.warning(
                    "Skipping change with missing page_id/element_id: "
                    "project=%s page_id=%r element_id=%r op=%s",
                    project_id, page_id, element_id, op,
                )
                continue
            if op == "delete":
                ops.append({
                    "op": "map.delete",
                    "path": ["pages", page_id, "elementsMap"],
                    "key": element_id,
                })
                ops.append({
                    "op": "map.delete",
                    "path": ["pages", page_id, "elementOrderMap"],
                    "key": element_id,
                })
            else:
                element = c.get("element")
                if not isinstance(element, dict):
                    element = c.get("patch") if isinstance(c.get("patch"), dict) else {}
                ops.append({
                    "op": "map.patch",
                    "path": ["pages", page_id, "elementsMap", element_id],
                    "values": {**element, "id": element_id},
                })

        if not ops:
            return {
                "error": f"All {skipped} changes skipped: missing op/type field",
                "applied": 0,
                "total": len(changes),
            }

        current_run_id = get_current_run_id() or ""
        data = CollabApplyOpsService.apply_slide_ops(
            slide_id=project_id,
            op_id=current_run_id or f"slide:{project_id}:element_changes",
            ops=ops,
            timeout=8,
            editor_type=editor_type,
            editor_id=agent_id,
            editor_name=agent_id,
            agent_run_id=current_run_id,
            system_policy="trusted_internal" if editor_type == "system" else "",
        )
        if data.get("status") == "error" or "error" in data:
            return {
                "error": data.get("error") or data.get("message") or data.get("code"),
                "applied": 0,
                "total": len(changes),
            }

        logger.info(
            "Agent push slide element changes: project=%s applied=%s/%s agent=%s",
            project_id,
            (data.get("data") or {}).get("applied", 0) if isinstance(data.get("data"), dict) else 0,
            len(changes),
            agent_id,
        )
        return data

    @staticmethod
    def push_pages(
        project_id: str,
        pages: list[dict],
        page_order: list[str] | None = None,
        agent_id: str = "",
        editor_type: str = "agent",
    ) -> dict:
        """
        推送页面级变更到 collab-live（Y.js 链路）。

        用于 create_slides / add-page / delete-page / restore / import 等
        页面级操作后同步到 Y.js。

        Args:
            project_id: 幻灯片项目 ID
            pages: 页面数据列表，每个页面 {"page_id": str, "elements": [...], ...}
            page_order: 页面排序，如果为 None 则不修改排序
            agent_id: 编辑者标识
            editor_type: "user" | "agent" | "system"，影响 persist 权限校验路径
        """
        from apps.collab.apply_ops import CollabApplyOpsService
        from apps.services.common.platform_context import get_current_run_id

        ops = []
        for page in pages:
            page_id = page.get("page_id") or page.get("id")
            if not page_id:
                continue
            fields = {k: v for k, v in page.items() if k not in {"page_id", "id", "elements"}}
            ops.append({
                "op": "map.patch",
                "path": ["pages", page_id],
                "values": fields,
            })
            for element in page.get("elements") or []:
                if isinstance(element, dict) and element.get("id"):
                    ops.append({
                        "op": "map.patch",
                        "path": ["pages", page_id, "elementsMap", str(element["id"])],
                        "values": element,
                    })
        if page_order is not None:
            ops.append({
                "op": "order.set",
                "path": ["pageOrderMap"],
                "positions": {page_id: str(index).zfill(8) for index, page_id in enumerate(page_order)},
            })

        current_run_id = get_current_run_id() or ""
        result = CollabApplyOpsService.apply_slide_ops(
            slide_id=project_id,
            op_id=current_run_id or f"slide:{project_id}:pages",
            ops=ops,
            timeout=15,
            editor_type=editor_type,
            editor_id=agent_id,
            editor_name=agent_id,
            agent_run_id=current_run_id,
            system_policy="trusted_internal" if editor_type == "system" else "",
        )

        if "error" in result or result.get("status") == "error":
            logger.error(
                "push_pages Y.js sync failed: "
                "project=%s pages=%d agent=%s error=%s",
                project_id, len(pages), agent_id, result.get("error") or result.get("message") or result.get("code"),
            )
        else:
            logger.info(
                "Agent push slide pages: project=%s pages=%d agent=%s",
                project_id, len(pages), agent_id,
            )
        return result
