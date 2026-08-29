from typing import Any, Dict, List, Optional

from django.db.models import Q
from django.shortcuts import get_object_or_404
from ninja import Router
from ninja.errors import HttpError
from pydantic import BaseModel, Field

from apps.schema_market.models import MarketTemplate
from apps.schema_market.services import TemplateService, VariableValidationError
from apps.users.auth.api import jwt_auth

router = Router(tags=['Schema Market'])


class TemplateSummarySchema(BaseModel):
    slug: str
    name: str
    icon: str
    summary: str
    category: str
    tags: List[str]
    usage_count: int
    is_official: bool
    has_variables: bool
    preview_schema: Optional[dict]
    preview_data: Optional[dict]


class TemplateDetailSchema(TemplateSummarySchema):
    description: str
    variables_schema: Dict[str, Any]
    url_template: str
    refresh_config: Dict[str, Any]
    documentation_url: Optional[str]


class RenderTemplateIn(BaseModel):
    variables: Dict[str, Any] = Field(default_factory=dict)


class RenderTemplateOut(BaseModel):
    template_slug: str
    schema_id: Optional[str]
    schema_json: Dict[str, Any]
    source_url: str


def _to_summary_schema(template: MarketTemplate) -> TemplateSummarySchema:
    return TemplateSummarySchema(
        slug=template.slug,
        name=template.name,
        icon=template.icon,
        summary=template.summary,
        category=template.category,
        tags=template.tags,
        usage_count=template.usage_count,
        is_official=template.is_official,
        has_variables=bool(template.variables_schema),
        preview_schema=template.preview_schema or None,
        preview_data=template.preview_data or None,
    )


@router.get('/templates', response=List[TemplateSummarySchema])
def list_templates(request, category: Optional[str] = None, keyword: Optional[str] = None, official: Optional[bool] = None):
    qs = MarketTemplate.objects.filter(is_active=True)

    if category:
        qs = qs.filter(category=category)
    if keyword:
        qs = qs.filter(Q(name__icontains=keyword) | Q(summary__icontains=keyword) | Q(description__icontains=keyword))
    if official is not None:
        qs = qs.filter(is_official=official)

    return [_to_summary_schema(template) for template in qs]


@router.get('/templates/{slug}', response=TemplateDetailSchema)
def get_template_detail(request, slug: str):
    template = get_object_or_404(MarketTemplate, slug=slug, is_active=True)
    summary = _to_summary_schema(template)
    return TemplateDetailSchema(
        **summary.dict(),
        description=template.description,
        variables_schema=template.variables_schema,
        url_template=template.url_template,
        refresh_config=template.refresh_config,
        documentation_url=template.documentation_url
    )


@router.post('/templates/{slug}/preview', response=RenderTemplateOut, auth=jwt_auth)
def preview_template(request, slug: str, payload: RenderTemplateIn):
    template = get_object_or_404(MarketTemplate, slug=slug, is_active=True)
    service = TemplateService(template)
    try:
        rendered = service.render(payload.variables)
    except VariableValidationError as exc:
        raise HttpError(422, str(exc))

    return RenderTemplateOut(
        template_slug=template.slug,
        schema_id=None,
        schema_json=rendered.schema_json,
        source_url=rendered.source_url
    )


@router.post('/templates/{slug}/apply', response=RenderTemplateOut, auth=jwt_auth)
def apply_template(request, slug: str, payload: RenderTemplateIn):
    template = get_object_or_404(MarketTemplate, slug=slug, is_active=True)
    service = TemplateService(template)
    try:
        rendered = service.render(payload.variables)
        result = service.persist(rendered, request.auth)
    except VariableValidationError as exc:
        raise HttpError(422, str(exc))
    except Exception as exc:  # pragma: no cover
        raise HttpError(500, f'应用模板失败: {exc}') from exc

    return RenderTemplateOut(
        template_slug=template.slug,
        schema_id=result.generated_schema_id,
        schema_json=result.schema_json,
        source_url=result.source_url
    )
