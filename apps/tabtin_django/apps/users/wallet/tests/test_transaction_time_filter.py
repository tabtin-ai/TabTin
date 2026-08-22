from django.test import SimpleTestCase

from apps.users.wallet.services.base_wallet_service import validate_wallet_transaction_time_param


class TransactionTimeFilterValidationTests(SimpleTestCase):
    def test_accepts_empty(self):
        validate_wallet_transaction_time_param(None)
        validate_wallet_transaction_time_param('')
        validate_wallet_transaction_time_param('   ')

    def test_accepts_calendar_and_iso(self):
        validate_wallet_transaction_time_param('2026-03-20')
        validate_wallet_transaction_time_param('2026-03-20T16:00:00Z')
        validate_wallet_transaction_time_param('2026-03-20 16:00:00')

    def test_rejects_garbage(self):
        with self.assertRaises(ValueError):
            validate_wallet_transaction_time_param('not-a-date')
