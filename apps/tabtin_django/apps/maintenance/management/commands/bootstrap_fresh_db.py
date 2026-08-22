"""一键初始化 fresh 库的基线种子数据（单库架构 / 整机 compose / CI / 新 dev）。

把散落在各 app 的「每个 fresh 库都要、无密钥、幂等」的 seed 聚合成一条**显式**命令：
新接手单库架构的人 / 部署只需在 `safe_migrate` 之后跑一次，不用记多条命令、也能
一眼看清这次初始化导入了什么。

设计原则：
  - **只收基线**：代码定义的默认值、无密钥、幂等、每个 fresh 库都需要。
  - **不碰真密钥**：LLM / OSS 的 api_key 走 env / AdminDash（本命令只建占位骨架）。
  - **显式、幂等**：与 migrate 同一档心智，由操作者 / 编排者主动跑一次，**不在 boot 自动跑**
    （compose 提供默认关闭的 RUN_BOOTSTRAP 开关供 dev 选择性 opt-in）。
  - **透明**：开头打印将导入的清单，逐项报结果 + 末尾汇总。

用法：
    python manage.py bootstrap_fresh_db            # 跑基线 seed（幂等）
    python manage.py bootstrap_fresh_db --dry-run  # 只打印计划，不写库

provider / 业务专属的 seed（媒体生成 / ZenMux / fal / 进宝 bot 等）**不在**本命令内，
按需手动跑（见下方 OPTIONAL_SEEDS / setup.md §12）。
"""
from __future__ import annotations

from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError

# 基线：每个 fresh 库都要、无密钥、幂等。(command, kwargs, 说明)
BASELINE_SEEDS = [
    ("seed_membership_tiers", {}, "会员等级（配额上限）"),
    ("seed_scene_bindings", {}, "LLM 场景绑定脚手架（chat 基线 Kimi 2.6；无真 key）"),
    ("seed_meter_pricing", {}, "计费计量项定价"),
]

# provider / 业务专属：本命令**不跑**，按需手动。仅列于此供透明 / --help 参考。
OPTIONAL_SEEDS = [
    ("seed_media_models", "媒体生成 provider/model（需 --api-key 或占位）"),
    ("seed_zenmux_long_context_tiers", "ZenMux 长上下文档位"),
    ("seed_fal_replicate", "fal / replicate 媒体模型"),
    ("init_token_limits", "回填已有模型 token 上限（需 --apply）"),
    ("seed_jinbao", "进宝 Echo Bot（业务专属）"),
]


class Command(BaseCommand):
    help = "一键初始化 fresh 库的基线种子数据（幂等、无密钥、显式）。"

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="只打印将导入的清单，不写库",
        )

    def handle(self, *args, **options):
        dry_run = bool(options.get("dry_run"))

        self.stdout.write(self.style.MIGRATE_HEADING("=== bootstrap_fresh_db：基线初始化 ==="))
        self.stdout.write("本次将导入以下基线（幂等、无密钥）：")
        for cmd, _kw, desc in BASELINE_SEEDS:
            self.stdout.write(f"  • {cmd:<26}{desc}")
        self.stdout.write("")
        self.stdout.write("以下 provider / 业务专属 seed 本命令不跑，按需手动：")
        for cmd, desc in OPTIONAL_SEEDS:
            self.stdout.write(f"  - {cmd:<34}{desc}")
        self.stdout.write("")

        if dry_run:
            self.stdout.write(self.style.WARNING("[dry-run] 仅打印计划，未写库。"))
            return

        passed: list[str] = []
        failed: list[tuple[str, Exception]] = []
        for cmd, kwargs, desc in BASELINE_SEEDS:
            self.stdout.write(self.style.MIGRATE_HEADING(f"▶ {cmd} — {desc}"))
            try:
                call_command(cmd, **kwargs)
                passed.append(cmd)
            except Exception as exc:  # noqa: BLE001 —— 聚合命令要逐个暴露失败
                failed.append((cmd, exc))
                self.stderr.write(self.style.ERROR(f"✗ {cmd} 失败：{exc}"))

        self.stdout.write(self.style.MIGRATE_HEADING("─" * 60))
        self.stdout.write(
            f"完成：成功 {len(passed)} / 失败 {len(failed)}（共 {len(BASELINE_SEEDS)} 项基线）"
        )
        if failed:
            raise CommandError(f"{len(failed)} 个基线 seed 失败，见上方 ✗。")
        self.stdout.write(
            self.style.SUCCESS(
                "✓ 基线初始化完成。真密钥（LLM/OSS api_key）请走 env / AdminDash，不在本命令内。"
            )
        )
