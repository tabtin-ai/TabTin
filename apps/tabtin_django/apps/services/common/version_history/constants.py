"""
版本历史统一常量

所有模块共享同一套 TTL / 降采样 / 快照锚点策略参数。
"""
from datetime import timedelta

# TTL（秒）—— 按用户套餐分级
HISTORY_TTL_FREE = 7 * 24 * 3600       # 免费用户: 7 天
HISTORY_TTL_PRO = 30 * 24 * 3600       # Pro 用户: 30 天
HISTORY_TTL_TEAM = 90 * 24 * 3600      # Team 用户: 90 天

# timedelta 版本（便于直接加减）
TTL_TIERS = {
    "free": timedelta(seconds=HISTORY_TTL_FREE),
    "pro": timedelta(seconds=HISTORY_TTL_PRO),
    "team": timedelta(seconds=HISTORY_TTL_TEAM),
}

# OrganizationMembership.tier.tier_type → TTL 逻辑等级映射
# membership 表使用 basic/pro/enterprise/team 等值，需转换为 TTL_TIERS 的 key
MEMBERSHIP_TIER_MAP = {
    "free": "free",
    "basic": "pro",
    "pro": "pro",
    "enterprise": "team",
    "team": "team",
}

# 快照锚点策略
HISTORY_MIN_INTERVAL = 5                # 最小间隔 5 秒（过滤高频 autoSave）
HISTORY_SNAPSHOT_INTERVAL = 10          # 每 N 次增量 diff 后创建全量锚点
HISTORY_SNAPSHOT_MAX_AGE = 30 * 60      # 或每 30 分钟创建全量锚点
