import copy
import uuid
from dataclasses import dataclass
from typing import Any, Dict, Optional
from urllib.parse import urlparse

from django.db import models, transaction
from django.utils import timezone

from apps.schema_discovery.services import SchemaCache
from apps.schema_market.models import MarketTemplate, TemplateUsage

from .variable_renderer import VariableRenderer, VariableValidationError


@dataclass
class RenderedTemplateResult:
    template: MarketTemplate
    variables: Dict[str, Any]
    schema_json: Dict[str, Any]
    source_url: str
    generated_schema_id: Optional[str] = None


class TemplateService:
    """
    模板渲染与持久化服务。
    """

    def __init__(self, template: MarketTemplate):
        self.template = template
        self.variable_renderer = VariableRenderer(template.variables_schema)

    def render(self, payload: Dict[str, Any]) -> RenderedTemplateResult:
        """
        渲染模板（仅内存操作，不落库）。
        """
        variables = self.variable_renderer.validate(payload or {})
        source_url = self.variable_renderer.render_text(self.template.url_template, variables)

        base_schema = self._get_base_schema()
        schema_json = self.variable_renderer.render_data(base_schema, {
            **variables,
            'source_url': source_url,
            'template': {
                'slug': self.template.slug,
                'name': self.template.name,
            }
        })

        self._ensure_schema_metadata(schema_json)

        return RenderedTemplateResult(
            template=self.template,
            variables=variables,
            schema_json=schema_json,
            source_url=source_url,
        )

    @transaction.atomic
    def persist(self, rendered: RenderedTemplateResult, user) -> RenderedTemplateResult:
        """
        保存渲染结果到 Schema Discovery，并记录使用日志。
        """
        schema_cache = SchemaCache()

        schema = rendered.schema_json
        modules_used = self._infer_modules(schema)
        confidence = self._infer_confidence(schema)

        generated_schema = schema_cache.save_schema(
            thread_id=f'schema-market:{self.template.slug}:{uuid.uuid4()}',
            user_id=user.id if user else str(uuid.uuid4()),
            url=rendered.source_url,
            schema_json=schema,
            modules_used=modules_used,
            confidence=confidence,
            sample_data=self._extract_sample_data(schema),
            validation_stats=schema.get('quality_metrics')
        )

        TemplateUsage.objects.create(
            template=self.template,
            user=user,
            rendered_url=rendered.source_url,
            variables_filled=rendered.variables,
            rendered_schema=schema,
            generated_schema=generated_schema,
            status='success'
        )

        MarketTemplate.objects.filter(pk=self.template.pk).update(
            usage_count=models.F('usage_count') + 1,
            last_used_at=timezone.now()
        )

        rendered.generated_schema_id = str(generated_schema.id)
        return rendered

    # ------------------------------------------------------------------ #
    # private helpers
    # ------------------------------------------------------------------ #

    def _get_base_schema(self) -> Dict[str, Any]:
        """
        提取基础 Schema（优先使用 schema_source，如果可用）。
        """
        if self.template.schema_source:
            return copy.deepcopy(self.template.schema_source.schema_json)
        return copy.deepcopy(self.template.schema_json)

    def _ensure_schema_metadata(self, schema: Dict[str, Any]) -> None:
        """
        补全 metadata / site 等基础字段，确保 Schema 合规。
        """
        metadata = schema.setdefault('metadata', {})
        metadata.setdefault('name', self.template.name)
        metadata.setdefault('status', schema.get('_schema_status', 'executable'))
        metadata.setdefault('schema_id', metadata.get('schema_id') or str(uuid.uuid4()))
        metadata.setdefault('tags', self.template.tags)

        site = schema.setdefault('site', {})
        site.setdefault('name', self.template.name)
        site_base = site.get('base_url') or self.template.extra_metadata.get('base_url')
        if not site_base:
            parsed = urlparse(self.template.url_template)
            site_base = f'{parsed.scheme}://{parsed.netloc}' if parsed.scheme else self.template.url_template
        site['base_url'] = site_base

        schema.setdefault('_schema_status', schema.get('_schema_status', 'executable'))

    def _infer_modules(self, schema: Dict[str, Any]) -> list:
        if modules := self.template.extra_metadata.get('modules_used'):
            return modules

        modules = ['basic_schema']
        extraction = schema.get('extraction', {})

        pagination = extraction.get('pagination', {})
        if pagination.get('enabled'):
            modules.append('pagination_schema')

        detail_page = extraction.get('detail_page', {})
        if detail_page.get('enabled'):
            modules.append('detail_page_schema')

        if extraction.get('sub_pages'):
            modules.append('sub_page_schema')

        return modules

    @staticmethod
    def _infer_confidence(schema: Dict[str, Any]) -> float:
        extraction = schema.get('extraction', {})
        confidence = extraction.get('confidence')
        if confidence is not None:
            return float(confidence)
        metrics = schema.get('quality_metrics', {})
        if metrics.get('overall_confidence') is not None:
            return float(metrics['overall_confidence'])
        return 0.8

    @staticmethod
    def _extract_sample_data(schema: Dict[str, Any]) -> Optional[list]:
        extraction = schema.get('extraction', {})
        if extraction.get('sample_data'):
            return extraction['sample_data']
        return None


__all__ = [
    'TemplateService',
    'RenderedTemplateResult',
    'VariableValidationError',
]
