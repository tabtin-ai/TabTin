import base64
import io
import zipfile
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from django.test import SimpleTestCase, override_settings
from PIL import Image

from apps.tabdata.services.export_service import (
    ExportService,
    _build_excel_images_from_file_field,
    _build_excel_image_from_file_field,
    _format_file_field_value,
)


class ExcelExportImageSourceTests(SimpleTestCase):
    @staticmethod
    def _tiny_png_bytes() -> bytes:
        return ExcelExportImageSourceTests._png_bytes(1, 1)

    @staticmethod
    def _png_bytes(width: int, height: int) -> bytes:
        buffer = io.BytesIO()
        Image.new('RGB', (width, height), 'red').save(buffer, format='PNG')
        return buffer.getvalue()

    @override_settings(
        ALIYUN_OSS_BUCKET_NAME='example-assets',
        ALIYUN_OSS_ENDPOINT='oss-cn-wuhan-lr.aliyuncs.com',
        ASSET_PUBLIC_DOMAIN='',
        ALIYUN_OSS_CDN_DOMAIN='',
    )
    @patch('apps.tabdata.services.export_service.get_oss_service')
    def test_trusted_oss_url_resolves_to_object_key(self, mock_get_oss_service):
        image_bytes = self._tiny_png_bytes()
        mock_get_oss_service.return_value.download_file.return_value = {
            'success': True,
            'data': {'content': image_bytes, 'content_type': 'image/png'},
        }

        image = _build_excel_image_from_file_field(
            [
                {
                    'name': 'legacy.png',
                    'url': 'https://example-assets.oss-cn-wuhan-lr.aliyuncs.com/tabdata/export/legacy.png?Expires=1',
                    'size': len(image_bytes),
                    'mime_type': 'image/png',
                }
            ],
            {},
        )

        self.assertIsNotNone(image)
        mock_get_oss_service.return_value.download_file.assert_called_once_with(
            'tabdata/export/legacy.png'
        )

    @patch('apps.tabdata.services.export_service.get_oss_service')
    def test_object_key_aliases_download_from_oss(self, mock_get_oss_service):
        image_bytes = self._tiny_png_bytes()
        mock_get_oss_service.return_value.download_file.return_value = {
            'success': True,
            'data': {'content': image_bytes, 'content_type': 'image/png'},
        }

        for key_name in ('key', 'file_key', 'object_key', 'oss_key'):
            with self.subTest(key_name=key_name):
                mock_get_oss_service.return_value.download_file.reset_mock()
                image = _build_excel_image_from_file_field(
                    [
                        {
                            'name': f'{key_name}.png',
                            key_name: f'tabdata/export/{key_name}.png',
                            'size': len(image_bytes),
                            'mime_type': 'image/png',
                        }
                    ],
                    {},
                )

                self.assertIsNotNone(image)
                mock_get_oss_service.return_value.download_file.assert_called_once_with(
                    f'tabdata/export/{key_name}.png'
                )

    @patch('apps.tabdata.services.export_service.get_oss_service')
    def test_data_url_does_not_use_oss(self, mock_get_oss_service):
        image_bytes = self._tiny_png_bytes()
        image = _build_excel_image_from_file_field(
            [
                {
                    'name': 'inline.png',
                    'url': 'data:image/png;base64,' + base64.b64encode(image_bytes).decode('ascii'),
                    'size': len(image_bytes),
                    'mime_type': 'image/png',
                }
            ],
            {},
        )

        self.assertIsNotNone(image)
        mock_get_oss_service.assert_not_called()

    @patch('apps.tabdata.services.export_service.get_oss_service')
    def test_multiple_data_url_images_are_all_collected(self, mock_get_oss_service):
        image_bytes = self._tiny_png_bytes()
        image_value = [
            {
                'name': f'inline-{index}.png',
                'url': 'data:image/png;base64,' + base64.b64encode(image_bytes).decode('ascii'),
                'size': len(image_bytes),
                'mime_type': 'image/png',
            }
            for index in range(4)
        ]

        images = _build_excel_images_from_file_field(image_value, {})

        self.assertEqual(len(images), 4)
        mock_get_oss_service.assert_not_called()

    def test_embedded_image_keeps_original_pixels_with_larger_display_size(self):
        import openpyxl

        image_bytes = self._png_bytes(640, 480)
        image = _build_excel_image_from_file_field(
            [
                {
                    'name': 'large.png',
                    'url': 'data:image/png;base64,' + base64.b64encode(image_bytes).decode('ascii'),
                    'size': len(image_bytes),
                    'mime_type': 'image/png',
                }
            ],
            {},
        )

        self.assertIsNotNone(image)
        self.assertEqual(image.width, 240)
        self.assertEqual(image.height, 180)

        workbook = openpyxl.Workbook()
        worksheet = workbook.active
        worksheet.add_image(image, 'A1')
        output = io.BytesIO()
        workbook.save(output)

        with zipfile.ZipFile(io.BytesIO(output.getvalue())) as archive:
            media_names = [name for name in archive.namelist() if name.startswith('xl/media/')]
            self.assertEqual(len(media_names), 1)
            with Image.open(io.BytesIO(archive.read(media_names[0]))) as embedded:
                self.assertEqual(embedded.size, (640, 480))
            drawing_names = [name for name in archive.namelist() if name.startswith('xl/drawings/drawing')]
            self.assertEqual(len(drawing_names), 1)
            drawing_xml = archive.read(drawing_names[0]).decode('utf-8')
            self.assertIn('cx="2286000"', drawing_xml)
            self.assertIn('cy="1714500"', drawing_xml)

    def test_image_names_can_be_hidden_from_excel_cell_text(self):
        image_value = [
            {
                'name': 'photo.png',
                'url': 'data:image/png;base64,' + base64.b64encode(self._tiny_png_bytes()).decode('ascii'),
                'size': 64,
                'mime_type': 'image/png',
            },
            {
                'name': 'notes.pdf',
                'url': 'https://assets.example.test/notes.pdf',
                'size': 1024,
                'mime_type': 'application/pdf',
            },
        ]

        self.assertEqual(_format_file_field_value(image_value), 'photo.png, notes.pdf')
        formatted = _format_file_field_value(
            image_value,
            hide_image_names=True,
        )

        self.assertEqual(formatted, 'notes.pdf')

    def test_csv_cell_preserves_image_and_non_image_attachment_names(self):
        value = [
            {
                'name': 'photo.png',
                'url': 'data:image/png;base64,' + base64.b64encode(self._tiny_png_bytes()).decode('ascii'),
                'size': 64,
                'mime_type': 'image/png',
            },
            {
                'name': 'notes.pdf',
                'url': 'https://assets.example.test/notes.pdf',
                'size': 1024,
                'mime_type': 'application/pdf',
            },
        ]

        self.assertEqual(
            ExportService._format_csv_cell(value, 'attachment'),
            'photo.png, notes.pdf',
        )

    @patch('apps.tabdata.services.export_service.Table')
    @patch('apps.tabdata.services.export_service.read_data')
    def test_excel_export_keeps_attachment_names_above_image_preview(
        self,
        mock_read_data,
        mock_table_model,
    ):
        import openpyxl

        field = SimpleNamespace(
            id=uuid4(),
            name='附件',
            field_type='attachment',
            config={},
        )
        record = SimpleNamespace(id=uuid4())
        image_bytes = self._png_bytes(640, 480)
        mock_read_data.return_value = {
            str(field.id): [
                {
                    'name': 'photo.png',
                    'url': 'data:image/png;base64,' + base64.b64encode(image_bytes).decode('ascii'),
                    'size': len(image_bytes),
                    'mime_type': 'image/png',
                },
                {
                    'name': 'notes.pdf',
                    'url': 'https://assets.example.test/notes.pdf',
                    'size': 1024,
                    'mime_type': 'application/pdf',
                },
            ],
        }
        mock_table_model.objects.using.return_value.get.return_value = SimpleNamespace(id=uuid4())

        service = ExportService(user=SimpleNamespace(id=uuid4()))
        with (
            patch.object(service, 'check_table_permission', return_value=True),
            patch.object(service, '_get_export_fields', return_value=[field]),
            patch.object(service, '_get_records_queryset', return_value=SimpleNamespace()),
            patch.object(service, '_iter_records_with_export_data', return_value=[record]),
        ):
            result = service.export_to_excel(table_id=uuid4(), include_headers=True)

        workbook = openpyxl.load_workbook(io.BytesIO(result))
        worksheet = workbook.active
        self.assertEqual(worksheet['A2'].value, 'photo.png, notes.pdf')
        self.assertEqual(worksheet['A2'].alignment.vertical, 'top')
        self.assertEqual(len(worksheet._images), 1)
        self.assertGreater(worksheet.row_dimensions[2].height, 140)
        with zipfile.ZipFile(io.BytesIO(result)) as archive:
            drawing_name = next(
                name for name in archive.namelist()
                if name.startswith('xl/drawings/drawing')
            )
            drawing_xml = archive.read(drawing_name).decode('utf-8')
            self.assertIn('<rowOff>190500</rowOff>', drawing_xml)

    @patch('apps.tabdata.services.export_service.get_oss_service')
    def test_untrusted_external_url_is_not_downloaded(self, mock_get_oss_service):
        image = _build_excel_image_from_file_field(
            [
                {
                    'name': 'external.png',
                    'url': 'https://example.invalid/external.png',
                    'size': 1024,
                    'mime_type': 'image/png',
                }
            ],
            {},
        )

        self.assertIsNone(image)
        mock_get_oss_service.assert_not_called()
