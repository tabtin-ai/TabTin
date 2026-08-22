from django.test import SimpleTestCase


class OrganizationNotificationFormatterTests(SimpleTestCase):
    def test_received_invitation_uses_canonical_copy(self):
        from apps.services.notification.services.organization_notification_formatter import (
            format_organization_notification,
        )

        display = format_organization_notification(
            "invitation_received",
            organization_name="摹范科技",
            inviter_name="小周",
            role="editor",
        )

        self.assertEqual(display.title, "你收到来自「摹范科技」的邀请")
        self.assertEqual(display.body, "小周邀请你以“编辑者”身份加入该组织。")

    def test_remaining_scenarios_use_exact_canonical_copy(self):
        from apps.services.notification.services.organization_notification_formatter import (
            format_organization_notification,
        )

        cases = [
            (
                "invitation_accepted",
                {"invitee_name": "小明", "organization_name": "摹范科技", "role": "admin"},
                "小明已接受组织邀请",
                "对方已加入「摹范科技」，角色为“管理员”。",
            ),
            (
                "invitation_rejected",
                {"invitee_name": "小明", "organization_name": "摹范科技"},
                "小明已拒绝组织邀请",
                "对方没有加入「摹范科技」。",
            ),
            (
                "invitation_cancelled",
                {"organization_name": "摹范科技", "actor_name": "小周"},
                "加入「摹范科技」的邀请已取消",
                "该邀请已由小周取消，无需继续处理。",
            ),
            (
                "invitation_sync",
                {"organization_name": "摹范科技"},
                "加入「摹范科技」的邀请已处理",
                "该邀请已在其他入口完成处理，无需重复操作。",
            ),
            (
                "member_joined_by_invitation",
                {"member_name": "小明", "organization_name": "摹范科技", "role": "editor"},
                "小明已加入「摹范科技」",
                "该成员通过邀请加入，角色为“编辑者”。",
            ),
            (
                "member_added",
                {
                    "member_name": "小明",
                    "organization_name": "摹范科技",
                    "actor_name": "小周",
                    "role": "viewer",
                },
                "小明已加入「摹范科技」",
                "小周已将该成员添加为“查看者”。",
            ),
            (
                "member_removed",
                {"organization_name": "摹范科技"},
                "你已被移出「摹范科技」",
                "你将无法继续访问该组织及其组织资源。",
            ),
            (
                "role_changed",
                {"organization_name": "摹范科技", "old_role": "viewer", "new_role": "editor"},
                "你在「摹范科技」的角色已变更",
                "角色已由“查看者”调整为“编辑者”。",
            ),
            (
                "ownership_transferred",
                {
                    "organization_name": "摹范科技",
                    "old_owner_name": "老周",
                    "new_owner_name": "小周",
                },
                "「摹范科技」的所有权已转移",
                "组织所有者已由老周变更为小周。",
            ),
        ]

        for event_type, values, title, body in cases:
            with self.subTest(event_type=event_type):
                display = format_organization_notification(event_type, **values)
                self.assertEqual(display.title, title)
                self.assertEqual(display.body, body)

    def test_missing_uuid_like_names_and_unknown_roles_use_safe_fallbacks(self):
        from apps.services.notification.services.organization_notification_formatter import (
            format_organization_notification,
        )

        uuid_value = "123e4567-e89b-12d3-a456-426614174000"
        received = format_organization_notification(
            "invitation_received",
            organization_name=uuid_value,
            inviter_name=uuid_value[:8],
            role="custom-role",
        )
        added = format_organization_notification(
            "member_added",
            organization_name=None,
            member_name=f"用户{uuid_value[:8]}",
            actor_name="undefined",
            role="custom-role",
        )
        ownership = format_organization_notification(
            "ownership_transferred",
            organization_name="null",
            old_owner_name=uuid_value,
            new_owner_name=None,
        )

        self.assertEqual(received.title, "你收到来自「该组织」的邀请")
        self.assertEqual(received.body, "一位组织管理员邀请你以“成员”身份加入该组织。")
        self.assertEqual(added.title, "一位成员已加入「该组织」")
        self.assertEqual(added.body, "一位组织管理员已将该成员添加为“成员”。")
        self.assertEqual(ownership.title, "「该组织」的所有权已转移")
        self.assertEqual(ownership.body, "组织所有者已由原所有者变更为新所有者。")

        rendered = " ".join(
            [received.title, received.body, added.title, added.body, ownership.title, ownership.body]
        )
        self.assertNotIn(uuid_value, rendered)
        for forbidden in ("None", "null", "undefined", "custom-role"):
            self.assertNotIn(forbidden, rendered)
