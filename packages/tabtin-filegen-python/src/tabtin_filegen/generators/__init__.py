"""Built-in generators. Importing this package registers every file type.

To add a new file type: create a module here, implement a ``Generator``, and
register it below. The CLI and the Go proxy need no changes.
"""

from tabtin_filegen.generators.docx import DocxGenerator, DocxReader
from tabtin_filegen.generators.pdf import PdfGenerator, PdfReader
from tabtin_filegen.generators.pptx import PptxGenerator, PptxReader
from tabtin_filegen.generators.xlsx import XlsxGenerator, XlsxReader
from tabtin_filegen.registry import register, register_reader

register(XlsxGenerator())
register(DocxGenerator())
register(PptxGenerator())
register(PdfGenerator())

register_reader(XlsxReader())
register_reader(DocxReader())
register_reader(PptxReader())
register_reader(PdfReader())
