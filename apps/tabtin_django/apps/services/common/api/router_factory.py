"""Django Ninja router defaults for TabTin APIs."""

from __future__ import annotations

from typing import Any, Callable

from ninja import Router
from ninja.constants import NOT_SET


DEFAULT_ERROR_RESPONSE_SCHEMAS = {
    400: dict,
    401: dict,
    403: dict,
    404: dict,
    409: dict,
    422: dict,
    500: dict,
}


class TabTinRouter(Router):
    """Router that keeps common error responses in the OpenAPI contract."""

    @staticmethod
    def _with_default_error_responses(response: Any) -> Any:
        if response is NOT_SET:
            response = {200: Any}
        if isinstance(response, dict):
            return {
                **response,
                **{code: schema for code, schema in DEFAULT_ERROR_RESPONSE_SCHEMAS.items() if code not in response},
            }
        return response

    def api_operation(
        self,
        methods: list[str],
        path: str,
        *,
        response: Any = NOT_SET,
        **kwargs: Any,
    ) -> Callable:
        return super().api_operation(
            methods,
            path,
            response=self._with_default_error_responses(response),
            **kwargs,
        )

    def add_api_operation(
        self,
        path: str,
        methods: list[str],
        view_func: Callable,
        *,
        response: Any = NOT_SET,
        **kwargs: Any,
    ) -> None:
        return super().add_api_operation(
            path,
            methods,
            view_func,
            response=self._with_default_error_responses(response),
            **kwargs,
        )
