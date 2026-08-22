#  PR2：workspace 型 Space → Workspace 行一次性生成（终态迁移，无双写）。
#
# 关键决策：
# - **id 复用**：Workspace.id 直接沿用源 Space.id——Stage A 契约端点
#   （GET /workspaces）的 id 值无缝换语义、ChatSession.workspace 回填
#   （conversation 0060）零成本（workspace_id = space_id 同值拷贝）。
# - **入选口径**：type='workspace' 且 control_device 非空且
#   normalized_working_dir 非空。未绑定型默认 Space（device=None/dir=''）
#   本步仍跳过；**0107 / space_to_workspace.ensure_workspaces_from_all_personal_spaces
#   会用占位 device + /tabtin/migrated-spaces/<id> 补建同 id Workspace**，
#   禁止后续删壳丢 Membership / 软 space_id 资产。
# - **kind 一律 'standard'**（M-6：is_default 不转生 home——主场是全新的
#   每设备概念，只由供给路径出生，没有存量行被重解释）。
# - **(device, dir) 冲突消解**：新表唯一约束无归档/回收站条件（Workspace
#   终态无归档态），同 (device, normalized_working_dir) 的多行 Space
#   （活跃 + 归档/回收站并存）只迁一行——优先活跃行，组内取 created_at
#   最早（原始现场）。被丢弃行的会话在 0060 回填时 workspace 落 NULL
#   （多为归档现场的历史会话，可接受）。
# - **trust**：存量现场均为用户主动开目录创建 → trusted + user_confirmed
#   （W3 Trust UI 上线不对存量轰炸确认弹窗）；主场供给路径才写
#   system_provisioned。
# - **git_status 归位**：PR1 遗留 TODO——从 space.agent.agent_config
#   ['git_status'] 搬到 Workspace.git_status（现场状态归现场）。
#
# 产品未上线，dogfood 数据可有损；彩排失败按执行计划重置 dev-db-dumps。

from django.db import migrations
from django.utils import timezone


def forwards(apps, schema_editor):
    Space = apps.get_model('tabtinspace', 'Space')
    Workspace = apps.get_model('tabtinspace', 'Workspace')
    SpaceMembership = apps.get_model('tabtinspace', 'SpaceMembership')

    now = timezone.now()

    candidates = (
        Space.objects
        .filter(type='workspace')
        .exclude(control_device=None)
        .exclude(normalized_working_dir='')
        .select_related('agent', 'organization')
        .order_by('created_at')
    )

    # owner（created_by）解析：1:1 时代 bot Agent 的 owner → membership
    # owner（M4 后真人走 SpaceMembership.user）→ organization owner 兜底。
    owner_memberships = {}
    for sm in SpaceMembership.objects.filter(
        role='owner', is_active=True, user__isnull=False,
    ).values('space_id', 'user_id'):
        owner_memberships.setdefault(sm['space_id'], sm['user_id'])

    def _is_active(space) -> bool:
        return (
            not space.is_archived
            and space.trashed_at is None
            and space.status == 'active'
        )

    # (device, dir) 分组选优：活跃优先，组内 created_at 最早（candidates
    # 已按 created_at 升序，首个活跃行即胜者；无活跃行取首行）。
    winners = {}
    for space in candidates:
        key = (space.control_device_id, space.normalized_working_dir)
        cur = winners.get(key)
        if cur is None:
            winners[key] = space
        elif not _is_active(cur) and _is_active(space):
            winners[key] = space

    rows = []
    for space in winners.values():
        agent = space.agent
        created_by_id = (
            (agent.owner_user_id if agent else None)
            or owner_memberships.get(space.id)
            or space.organization.owner_id
        )
        git_status = {}
        approval_grant = 'always_ask'
        approval_memo = {'version': 1, 'entries': {}, 'generation': 0}
        if agent and isinstance(agent.agent_config, dict):
            raw = agent.agent_config.get('git_status')
            if isinstance(raw, dict) and raw:
                git_status = raw
            security = agent.agent_config.get('security')
            if isinstance(security, dict) and security.get('approval_grant') in {
                'always_ask', 'auto', 'full_access',
            }:
                approval_grant = security['approval_grant']
            raw_memo = agent.agent_config.get('approval_memo')
            if not isinstance(raw_memo, dict) and isinstance(security, dict):
                raw_memo = security.get('approval_memo')
            if isinstance(raw_memo, dict):
                approval_memo = {
                    'version': raw_memo.get('version', 1),
                    'entries': raw_memo.get('entries', {}),
                    'generation': raw_memo.get('generation', 0),
                }
        rows.append(Workspace(
            id=space.id,  # id 复用：API id 语义无缝 + 会话回填零成本
            organization_id=space.organization_id,
            device_id=space.control_device_id,
            name=space.name or '',
            working_dir=space.working_dir or space.normalized_working_dir,
            normalized_working_dir=space.normalized_working_dir,
            working_dir_type=space.working_dir_type or '',
            kind='standard',
            trust_status='trusted',
            trust_source='user_confirmed',
            trusted_at=now,
            git_status=git_status,
            approval_grant=approval_grant,
            approval_memo=approval_memo,
            created_by_id=created_by_id,
        ))

    if rows:
        Workspace.objects.bulk_create(rows, batch_size=500)


def backwards(apps, schema_editor):
    # 终态迁移不做语义回滚；开发期回退直接清空新表（源 Space 行未动）。
    Workspace = apps.get_model('tabtinspace', 'Workspace')
    Workspace.objects.all().delete()


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0096_workspace_table_3266'),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]
