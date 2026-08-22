"""normalize_filter_value：rating 数值归一"""

from types import SimpleNamespace

from django.test import SimpleTestCase

from apps.tabdata.services.view_filter_service import normalize_filter_value


def _field(field_type: str):
    return SimpleNamespace(field_type=field_type)


class NormalizeFilterValueRatingTests(SimpleTestCase):
    def test_rating_string_becomes_int(self):
        self.assertEqual(normalize_filter_value(_field('rating'), '3'), 3)
        self.assertIsInstance(normalize_filter_value(_field('rating'), '3'), int)

    def test_rating_float_becomes_int(self):
        self.assertEqual(normalize_filter_value(_field('rating'), 3.0), 3)

    def test_rating_int_passthrough(self):
        self.assertEqual(normalize_filter_value(_field('rating'), 3), 3)

    def test_number_string_still_float(self):
        self.assertEqual(normalize_filter_value(_field('number'), '3.5'), 3.5)

    def test_rating_invalid_string_passthrough(self):
        self.assertEqual(normalize_filter_value(_field('rating'), 'abc'), 'abc')
