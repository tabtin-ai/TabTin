"""
CollabAdapter — 模块适配器抽象基类

每个创作模块（docs/table/design/slide/video）实现一个 adapter，
提供模块特有的数据序列化、diff 计算、快照构建和恢复逻辑。

统一的 VersionHistoryService 和 collab API 通过 adapter 与各模块交互，
不直接依赖各模块的内部实现。
"""
import json
import logging
import zlib
from abc import ABC, abstractmethod
from typing import Any, Optional

logger = logging.getLogger(__name__)


class CollabAdapter(ABC):
    """
    协作与版本管理模块适配器。

    子类实现约定:
    - serialize_snapshot / deserialize_snapshot: 数据 ↔ 压缩 blob 对称
    - compute_diff / apply_diff: diff ↔ apply 对称
    - build_snapshot: 构造 collab-live onFetch 所需的全量快照
    - persist_changes: 处理 collab-live onStore 传入的变更
    - restore: 将资源恢复到指定版本的数据状态
    """

    resource_type: str = ""

    # ── 版本历史：序列化 ─────────────────────────────

    @abstractmethod
    def serialize_snapshot(self, data: Any) -> bytes:
        """
        将资源当前数据序列化为压缩 blob（用于 VersionHistory.blob）。

        返回 zlib 压缩后的 bytes。
        """
        ...

    @abstractmethod
    def deserialize_snapshot(self, blob: bytes) -> Optional[Any]:
        """
        将压缩 blob 反序列化为资源数据。

        与 serialize_snapshot 对称。
        """
        ...

    # ── 版本历史：增量 diff ──────────────────────────

    @abstractmethod
    def compute_diff(self, base_data: Any, current_data: Any) -> Optional[bytes]:
        """
        计算 base_data → current_data 的增量 diff。

        返回 zlib 压缩后的 diff bytes；无变更时返回 None。
        """
        ...

    @abstractmethod
    def apply_diff(self, base_data: Any, diff_blob: bytes) -> Any:
        """
        将增量 diff 应用到 base_data，得到 current_data。

        与 compute_diff 对称。
        """
        ...

    # ── 版本历史：元数据 ─────────────────────────────

    def get_content_stats(self, data: Any) -> dict:
        """
        从数据中提取模块特有的统计信息（存入 VersionHistory.metadata）。

        如: {"page_count": 5, "shape_count": 120}
        默认返回空 dict，子类按需覆盖。
        """
        return {}

    def get_version_data(self, resource: Any) -> Any:
        """
        获取用于版本存储的纯数据。

        与 build_snapshot 不同：
        - build_snapshot: 返回带元数据包装的 dict，给 collab-live onFetch 用
        - get_version_data: 返回纯业务数据，用于 serialize_snapshot / restore

        子类必须覆盖此方法。默认回退到 build_snapshot（不推荐）。
        """
        return self.build_snapshot(resource)

    # ── 协作：快照与持久化 ────────────────────────────

    @abstractmethod
    def get_resource(self, resource_id: str) -> Optional[Any]:
        """
        获取资源对象（ORM 实例）。

        返回 None 表示资源不存在。
        """
        ...

    def get_resource_for_rollback(self, resource_id: str) -> Optional[Any]:
        """
        获取资源对象，包含已删除/归档的资源（AP-010）。

        rollback_agent_run 需要恢复 Agent 删除的资源，
        因此不能使用过滤 status/trashed/archived 的 get_resource()。
        子类应覆盖此方法放宽查询条件。默认回退到 get_resource()。
        """
        return self.get_resource(resource_id)

    @abstractmethod
    def check_permission(self, user, resource: Any, action: str = "edit") -> bool:
        """
        检查用户对资源的权限。

        action: "view" / "edit"
        """
        ...

    @abstractmethod
    def build_snapshot(self, resource: Any) -> dict:
        """
        构造全量快照数据（供 collab-live onFetch 使用）。

        返回 JSON-serializable 的 dict。
        """
        ...

    @abstractmethod
    def persist_changes(self, resource: Any, changes: dict, editor_info: dict) -> dict:
        """
        处理 collab-live onStore 传入的变更，写入数据库。

        参数:
            resource: 资源 ORM 实例
            changes: collab-live 传来的变更数据（格式由各模块定义）
            editor_info: {"editor_type": "user", "editor_id": "...", "editor_name": "..."}

        返回:
            {"version": int, ...} 操作结果
        """
        ...

    def prepare_restore(self, resource: Any, data: Any) -> Optional[Any]:
        """
        恢复前预处理钩子：在 DB 事务外执行 HTTP IO 等耗时操作（AP-011）。

        返回的 prepared 数据会传入 restore(resource, data, prepared=prepared)。
        默认返回 None（无需预处理）。子类按需覆盖。
        """
        return None

    @abstractmethod
    def restore(self, resource: Any, data: Any, *, prepared: Any = None, user=None) -> None:
        """
        将资源恢复到指定版本的数据状态。

        data 来自 deserialize_snapshot 或 rebuild_from_diffs。
        prepared 来自 prepare_restore()（可选，用于事务外预获取的数据）。
        user: 执行恢复操作的用户对象（可选），用于记录到 RecordHistory 等审计日志。
        """
        ...

    # ── 回滚预览（CC-1，Wave 0） ─────────────────────────

    def preview_restore(
        self,
        resource: Any,
        target_data: Any,
        *,
        prepared: Any = None,
        user=None,
    ) -> dict:
        """回滚到 target_data 的"如果回滚会发生什么"摘要。

        Charter §3.4 / W0-1 CC-1：Checkpoint 回滚预览 Modal 聚合所有模块的
        preview 输出，给用户"点回滚后会改多少行 / 多少字段"的可视化提示。

        子类按 Charter §3.4 给出的 dict 结构返回（数值缺失统一用 0/[] 表示无变化），
        默认实现返回空摘要（"无可预测的影响"），调用方可安全 .get() 访问。

        参数:
            resource: 资源 ORM 实例（与 restore 一致）。
            target_data: deserialize_snapshot/rebuild_from_diffs 出的目标快照数据。
            prepared: prepare_restore() 返回值（可选，事务外预获取的耗时数据）。
            user: 调用预览的用户对象（可选）。**与 restore() 签名对称**——
                未来子类可用其做权限相关的预览过滤（例如只统计该用户可见的
                行数变化）。默认实现忽略 user。

        返回结构（Charter §3.4 标准 schema）:
            {
                'records_to_restore': int,    # 字段值会被覆盖回旧值的行数
                'records_to_create': int,     # 当前已删，回滚后会重新出现的行数
                'records_to_delete': int,     # 当前存在但目标版本不存在，回滚后会消失的行数
                'fields_to_restore': list[str],  # 会被结构性恢复的字段标识
                'estimated_duration_ms': int, # 预估耗时（用于前端给"长操作"加 spinner）
            }

        实施备忘:
            - 默认实现返回全零的 schema，意味着"无可预测影响"——子类未 override
              时调用方拿到的就是这个空摘要。**调用方必须自行区分**：
                * "默认实现 = 模块尚未支持预览（unimplemented）" 与
                * "子类返回全零 = 真实计算结果显示无变化"
              是**两种语义**。建议方案：preview 聚合 API 应根据 ``adapter.preview_restore is CollabAdapter.preview_restore`` 判断
              是否为默认实现，并向前端透传 ``preview_status``
              （``unimplemented`` / ``ready``）让 UI 文案分支正确——避免用户
              看到"该回滚不会改任何数据"的误导。
            - 不要求 raise/abstractmethod，与 ``get_content_stats`` /
              ``prepare_restore`` 等"基类提供 sensible default"的现有方法
              保持同一形态。Charter §3.4 文字"抽象方法"应理解为"声明在抽象
              基类上的方法"，而非 ABC 的 abstractmethod。
            - 默认实现每次调用返回**新的字面量 dict**——不存在"单例默认 dict
              被子类污染"的经典坑。
            - 真实实现（TableAdapter.preview_restore 等）属 Wave 1 TD-3 范围。
        """
        return {
            'records_to_restore': 0,
            'records_to_create': 0,
            'records_to_delete': 0,
            'fields_to_restore': [],
            'estimated_duration_ms': 0,
        }

    # ── 工具方法（子类可复用）─────────────────────────

    @staticmethod
    def compress_json(data: Any) -> bytes:
        """JSON 序列化 + zlib 压缩。"""
        json_str = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
        return zlib.compress(json_str.encode("utf-8"), level=6)

    @staticmethod
    def decompress_json(blob: bytes) -> Optional[Any]:
        """zlib 解压 + JSON 反序列化。"""
        try:
            return json.loads(zlib.decompress(blob).decode("utf-8"))
        except Exception as e:
            logger.error("Failed to decompress blob: %s", e)
            return None
