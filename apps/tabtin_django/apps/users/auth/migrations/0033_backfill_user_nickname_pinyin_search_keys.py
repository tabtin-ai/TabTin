from django.db import migrations


def backfill_pinyin_search_keys(apps, schema_editor):
    from apps.users.auth.pinyin_search import build_pinyin_search_keys

    User = apps.get_model("users_auth", "User")
    batch = []
    users = User.objects.exclude(nickname__isnull=True).exclude(nickname="")
    for user in users.iterator(chunk_size=1000):
        user.nickname_pinyin, user.nickname_pinyin_initials = build_pinyin_search_keys(
            user.nickname
        )
        batch.append(user)
        if len(batch) >= 1000:
            User.objects.bulk_update(
                batch, ["nickname_pinyin", "nickname_pinyin_initials"]
            )
            batch.clear()
    if batch:
        User.objects.bulk_update(
            batch, ["nickname_pinyin", "nickname_pinyin_initials"]
        )


def clear_pinyin_search_keys(apps, schema_editor):
    User = apps.get_model("users_auth", "User")
    User.objects.update(nickname_pinyin="", nickname_pinyin_initials="")


class Migration(migrations.Migration):
    dependencies = [("users_auth", "0032_user_nickname_pinyin_search_keys")]

    operations = [
        migrations.RunPython(backfill_pinyin_search_keys, clear_pinyin_search_keys),
    ]
