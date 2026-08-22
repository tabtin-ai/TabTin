"""#6144：导入侧 URL 字段类型推断（无 DB）。"""

from django.test import SimpleTestCase

from apps.tabdata.services.import_type_inference import infer_field_type


class ImportUrlInference6144Tests(SimpleTestCase):
    def test_infers_https_and_bare_domain_as_url(self):
        self.assertEqual(
            infer_field_type([
                ' https://www.36kr.com/p/1',
                'https://www.36kr.com/p/2',
                'www.36kr.com/p/3',
            ]),
            'url',
        )

    def test_header_hint_lowers_threshold_for_article_link(self):
        self.assertEqual(
            infer_field_type(
                ['https://www.36kr.com/p/1', 'https://www.36kr.com/p/2', '待补充'],
                header='文章链接',
            ),
            'url',
        )

    def test_plain_text_stays_text(self):
        self.assertEqual(
            infer_field_type(['随机文本1', '随机文本2', '随机文本3']),
            'text',
        )
