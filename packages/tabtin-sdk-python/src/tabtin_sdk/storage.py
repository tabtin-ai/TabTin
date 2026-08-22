"""Storage client for TabTin SDK — file upload, download, list, delete."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from tabtin_sdk.http import HttpClient
from tabtin_sdk.types import ApiResponse, TabTinError


class StorageClient:
    """
    Handle file operations for a specific table.

    Usage::

        storage = client.table("任务").storage
        result = storage.upload("附件", "/path/to/doc.pdf")
        files = storage.list(record_id="rec_xxx")
        url_info = storage.get_download_url("file_id")
    """

    def __init__(self, http: HttpClient, table_id: str) -> None:
        self._http = http
        self._table_id = table_id

    @property
    def _base_path(self) -> str:
        return f"/api/tabdata/open/v1/tables/{self._table_id}/storage"

    # ── Upload ───────────────────────────────────────────

    def upload(
        self,
        field_id: str,
        file: Union[str, Path, bytes, "BinaryIO"],
        file_name: Optional[str] = None,
        *,
        record_id: Optional[str] = None,
        is_public: Optional[bool] = None,
    ) -> ApiResponse[Dict[str, Any]]:
        """
        Upload a single file via multipart form.

        Args:
            field_id: The attachment field ID or name.
            file: File path (str/Path), raw bytes, or file-like object.
            file_name: Override filename (required when *file* is bytes or a
                       file-like object without a ``name`` attribute).
            record_id: Optional record to attach the file to.

        Returns:
            ApiResponse whose ``data`` contains file_id, file_name,
            file_size, mime_type, access_url.
        """
        if isinstance(file, (str, Path)):
            path = Path(file)
            if file_name is None:
                file_name = path.name
            file_data = path.read_bytes()
        elif isinstance(file, bytes):
            file_data = file
            if file_name is None:
                raise ValueError("file_name is required when uploading bytes")
        else:
            # file-like object
            file_data = file.read()
            if file_name is None:
                file_name = getattr(file, "name", None)
                if file_name is None:
                    raise ValueError(
                        "file_name is required for file-like objects without .name"
                    )

        data: Dict[str, str] = {"field_id": field_id}
        if record_id:
            data["record_id"] = record_id
        if is_public is not None:
            data["is_public"] = str(is_public).lower()

        files = {"file": (file_name, file_data)}

        try:
            result = self._http.post_form(
                f"{self._base_path}/upload",
                data=data,
                files=files,
            )
            return ApiResponse(data=result)
        except TabTinError as e:
            return ApiResponse(error=e)

    # ── Presigned upload ─────────────────────────────────

    def get_presigned_upload_url(
        self,
        field_id: str,
        file_name: str,
        file_size: int,
        mime_type: str,
        *,
        record_id: Optional[str] = None,
    ) -> ApiResponse[Dict[str, Any]]:
        """
        Get a presigned URL for direct upload to cloud storage.

        Returns:
            ApiResponse whose ``data`` contains upload_url, object_key,
            upload_item_id, expires_in.
        """
        body: Dict[str, Any] = {
            "field_id": field_id,
            "file_name": file_name,
            "file_size": file_size,
            "mime_type": mime_type,
        }
        if record_id:
            body["record_id"] = record_id

        try:
            result = self._http.post(
                f"{self._base_path}/presigned-upload",
                json=body,
            )
            return ApiResponse(data=result)
        except TabTinError as e:
            return ApiResponse(error=e)

    def complete_presigned_upload(
        self, upload_item_id: str
    ) -> ApiResponse[Dict[str, Any]]:
        """Complete a presigned upload after the file has been uploaded to the URL."""
        try:
            result = self._http.post(
                f"{self._base_path}/presigned-upload/{upload_item_id}/complete",
                json={},
            )
            return ApiResponse(data=result)
        except TabTinError as e:
            return ApiResponse(error=e)

    # ── Download ─────────────────────────────────────────

    def get_download_url(self, file_id: str) -> ApiResponse[Dict[str, Any]]:
        """
        Get a presigned download URL for a file.

        Returns:
            ApiResponse whose ``data`` contains download_url, expires_in.
        """
        try:
            result = self._http.get(f"{self._base_path}/{file_id}/download")
            return ApiResponse(data=result)
        except TabTinError as e:
            return ApiResponse(error=e)

    # ── List / info ──────────────────────────────────────

    def list(
        self,
        *,
        field_id: Optional[str] = None,
        record_id: Optional[str] = None,
        page: int = 1,
        page_size: int = 20,
    ) -> ApiResponse[Dict[str, Any]]:
        """
        List files attached to this table.

        Returns:
            ApiResponse whose ``data`` contains files (list), total, page,
            page_size.
        """
        params: Dict[str, Any] = {
            "page": page,
            "page_size": page_size,
        }
        if field_id:
            params["field_id"] = field_id
        if record_id:
            params["record_id"] = record_id

        try:
            result = self._http.get(self._base_path, params=params)
            return ApiResponse(data=result)
        except TabTinError as e:
            return ApiResponse(error=e)

    def get_file_info(self, file_id: str) -> ApiResponse[Dict[str, Any]]:
        """Get file metadata."""
        try:
            result = self._http.get(f"{self._base_path}/{file_id}")
            return ApiResponse(data=result)
        except TabTinError as e:
            return ApiResponse(error=e)

    # ── Delete ───────────────────────────────────────────

    def delete(self, file_id: str) -> ApiResponse[Dict[str, Any]]:
        """Delete a file attachment.

        Returns:
            ApiResponse whose ``data`` contains file_id,
            deleted_references (list), count.
        """
        try:
            result = self._http.delete(f"{self._base_path}/{file_id}")
            if result is None:
                result = {"file_id": file_id, "deleted_references": [], "count": 0}
            return ApiResponse(data=result)
        except TabTinError as e:
            return ApiResponse(error=e)
