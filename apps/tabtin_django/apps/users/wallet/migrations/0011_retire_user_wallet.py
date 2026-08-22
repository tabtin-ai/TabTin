"""
W4-2/W4-4: UserWallet 物理退役迁移

步骤：
1. 数据迁移：将 WalletTransaction.wallet (UserWallet FK) 关联转移到 workteam_wallet
2. 删除 wallet FK 字段和两个 CheckConstraint
3. workteam_wallet 改为必填
4. 删除 UserWallet 模型（表）
"""

from django.db import migrations, models
import django.db.models.deletion


def migrate_wallet_transactions(apps, schema_editor):
    """将所有挂在 UserWallet 上的流水迁移到对应 personal workteam 的 WorkteamWallet"""
    WalletTransaction = apps.get_model('wallet', 'WalletTransaction')
    WorkteamWallet = apps.get_model('wallet', 'WorkteamWallet')
    UserWallet = apps.get_model('wallet', 'UserWallet')

    orphan_txs = WalletTransaction.objects.filter(
        wallet__isnull=False,
        workteam_wallet__isnull=True,
    ).select_related('wallet')

    if not orphan_txs.exists():
        return

    Workteam = None
    try:
        Workteam = apps.get_model('tabtinspace', 'Workteam')
    except LookupError:
        pass

    migrated = 0
    for tx in orphan_txs.iterator(chunk_size=500):
        user_id = tx.wallet.user_id
        ws_wallet = None

        if Workteam is not None:
            personal_wt = Workteam.objects.filter(
                owner_id=user_id, type='personal'
            ).values_list('id', flat=True).first()
            if personal_wt:
                ws_wallet = WorkteamWallet.objects.filter(
                    workteam_id=str(personal_wt)
                ).first()
                if ws_wallet is None:
                    ws_wallet = WorkteamWallet.objects.create(
                        workteam_id=str(personal_wt),
                        credits=tx.wallet.credits,
                        credits_precise=tx.wallet.credits_precise,
                        credits_frozen=tx.wallet.credits_frozen,
                        credits_frozen_precise=tx.wallet.credits_frozen_precise,
                    )

        if ws_wallet is None:
            ws_wallet, _ = WorkteamWallet.objects.get_or_create(
                workteam_id=f"personal_{user_id}",
                defaults={
                    'credits': tx.wallet.credits,
                    'credits_precise': tx.wallet.credits_precise,
                    'credits_frozen': tx.wallet.credits_frozen,
                    'credits_frozen_precise': tx.wallet.credits_frozen_precise,
                },
            )

        tx.workteam_wallet = ws_wallet
        tx.save(update_fields=['workteam_wallet'])
        migrated += 1

    if migrated:
        print(f"  Migrated {migrated} WalletTransaction(s) from UserWallet → WorkteamWallet")


class Migration(migrations.Migration):

    dependencies = [
        ('wallet', '0010_wallettransaction_reference_key_unique_constraint'),
    ]

    operations = [
        migrations.RunPython(
            migrate_wallet_transactions,
            migrations.RunPython.noop,
            elidable=True,
        ),

        migrations.RemoveConstraint(
            model_name='wallettransaction',
            name='tx_must_have_owner',
        ),
        migrations.RemoveConstraint(
            model_name='wallettransaction',
            name='tx_owner_mutually_exclusive',
        ),

        migrations.RemoveField(
            model_name='wallettransaction',
            name='wallet',
        ),

        migrations.AlterField(
            model_name='wallettransaction',
            name='workteam_wallet',
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.CASCADE,
                related_name='transactions',
                to='wallet.workteamwallet',
                verbose_name='工作团队钱包',
            ),
        ),

        migrations.DeleteModel(
            name='UserWallet',
        ),
    ]
