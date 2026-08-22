from django.conf import settings
from django.test import SimpleTestCase

from apps.services.email.services.tencent_email import TencentEmailService


class EmailBrandingTests(SimpleTestCase):
    def test_company_name_defaults_to_tabtin(self):
        self.assertEqual(settings.COMPANY_NAME, 'TabTin')

    def test_verification_template_uses_tabtin_not_legacy_legal_name(self):
        service = TencentEmailService(
            {
                'host': 'smtp.exmail.qq.com',
                'port': 465,
                'username': 'noreply@example.com',
                'password': 'secret',
                'use_ssl': True,
                'from_email': 'noreply@example.com',
                'company_name': settings.COMPANY_NAME,
            }
        )
        html = service._render_verification_template('123456')
        self.assertIn('TabTin', html)
        self.assertIn('123456', html)
        self.assertNotIn('Example Company', html)
