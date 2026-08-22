import ast
from pathlib import Path

from django.apps import apps as django_apps
from django.test import SimpleTestCase

import apps.tabdata as tabdata_package
from apps.tabdata import models as tabdata_models


def _iter_split_model_names():
    package_dir = Path(tabdata_package.__file__).resolve().parent

    for path in sorted(package_dir.glob("models_*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in tree.body:
            if not isinstance(node, ast.ClassDef):
                continue
            if any(
                (isinstance(base, ast.Attribute) and base.attr == "Model")
                or (isinstance(base, ast.Name) and base.id == "Model")
                for base in node.bases
            ):
                yield node.name


class TabDataModelRegistryTests(SimpleTestCase):
    def test_split_models_are_registered_via_canonical_models_module(self):
        model_names = list(_iter_split_model_names())
        self.assertGreater(len(model_names), 0)

        for model_name in model_names:
            self.assertTrue(
                hasattr(tabdata_models, model_name),
                f"{model_name} should be re-exported from apps.tabdata.models",
            )
            self.assertIs(
                django_apps.get_model("tabdata", model_name),
                getattr(tabdata_models, model_name),
            )
