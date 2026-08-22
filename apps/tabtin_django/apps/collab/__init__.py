"""
Collab — 统一协作与版本管理基础设施

为 TabDoc / TabData / TabSlide / TabVideo 提供:
- VersionHistory: 通用版本历史（快照 + 增量 diff）
- ChangeLog: 通用变更记录（含 agent_run_id 关联）
- CollabAdapter: 模块适配器抽象基类
- VersionHistoryService: 统一版本策略（快照锚点、TTL、降采样、恢复）
- 统一 collab API（collab-auth / collab-snapshot / collab-persist / versions / restore）
"""
