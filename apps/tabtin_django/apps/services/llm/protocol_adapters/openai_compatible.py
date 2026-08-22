from __future__ import annotations
import hashlib, json
from abc import ABC, abstractmethod
from contextlib import contextmanager
from urllib.parse import urlsplit, urlunsplit
from .contracts import *
from .errors import ProtocolContractError
from .sse import iter_sse_data
from .types import ProtocolType, StreamEventKind

class ProtocolAdapter(ABC):
    protocol_type: ProtocolType
    @abstractmethod
    def build_request(self, request, context): ...
    @abstractmethod
    def open_stream(self, request, transport, observer): ...
    @abstractmethod
    def parse_stream(self, response, context): ...
    @abstractmethod
    def normalize_usage(self, raw_usage, context): ...
    @abstractmethod
    def normalize_error(self, failure, context): ...

def _shape(value):
    if isinstance(value, dict): return {k: _shape(v) for k, v in sorted(value.items())}
    if isinstance(value, (list, tuple)): return [_shape(v) for v in value]
    return type(value).__name__

class OpenAICompatibleProtocolAdapter(ProtocolAdapter):
    protocol_type = ProtocolType.OPENAI_COMPATIBLE
    def build_request(self, request, context):
        if context.protocol_type is not self.protocol_type: raise ProtocolContractError("protocol-context-mismatch")
        split = urlsplit(context.endpoint)
        if split.scheme != "https" or not split.hostname or split.username or split.password or split.query or split.fragment: raise ProtocolContractError("unsafe-endpoint")
        base_path = split.path.rstrip("/")
        path = base_path if base_path.endswith("/chat/completions") else base_path + "/chat/completions"
        url = urlunsplit(("https", split.netloc.lower(), path, "", ""))
        body = {"model": request.model, "messages": thaw(request.messages), "stream": request.stream, **thaw(request.fields)}
        safe = {"protocol": self.protocol_type.value, "method": "POST", "origin": split.hostname.lower(), "path": path, "body_shape": _shape(body), "stream": request.stream, "header_names": ["accept", "authorization", "content-type"]}
        fingerprint = "sha256:" + hashlib.sha256(json.dumps(safe, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        return PreparedProtocolRequest(self.protocol_type, "POST", url, {"content-type":"application/json","accept":"text/event-stream","authorization":f"Bearer {context.credential.reveal()}"}, body, request.stream, context.timeout_profile, fingerprint, safe)
    @contextmanager
    def open_stream(self, request, transport, observer):
        observer.observe("request_start", fingerprint=request.fingerprint)
        try:
            with transport.open_stream(request) as response:
                observer.observe("response_headers", fingerprint=request.fingerprint, status_code=response.status_code)
                yield response
                observer.observe("stream_end", fingerprint=request.fingerprint, status_code=response.status_code)
        except Exception:
            observer.observe("transport_failure", fingerprint=request.fingerprint); raise
    def parse_stream(self, response, context):
        done = False
        for kind, payload in iter_sse_data(response.lines):
            if kind == "keepalive": yield ProtocolStreamEvent(StreamEventKind.KEEPALIVE); continue
            if kind == "truncated":
                yield ProtocolStreamEvent(StreamEventKind.PROTOCOL_ERROR, error=self.normalize_error(UpstreamFailure("stream_read", category_hint="premature_eof"), context)); continue
            if payload.strip() == "[DONE]":
                if done: yield ProtocolStreamEvent(StreamEventKind.PROTOCOL_ERROR, error=self.normalize_error(UpstreamFailure("stream_event", category_hint="duplicate_terminal"), context))
                else: done=True; yield ProtocolStreamEvent(StreamEventKind.PROTOCOL_DONE)
                continue
            try: parsed=json.loads(payload)
            except (ValueError, TypeError):
                yield ProtocolStreamEvent(StreamEventKind.PROTOCOL_ERROR, original_payload=payload, error=self.normalize_error(UpstreamFailure("stream_event", category_hint="malformed_response"), context)); continue
            if "error" in parsed:
                yield ProtocolStreamEvent(StreamEventKind.PROTOCOL_ERROR, error=self.normalize_error(UpstreamFailure("stream_event", upstream_code=str(parsed["error"].get("code")) if isinstance(parsed["error"],dict) and parsed["error"].get("code") else None, category_hint="stream_error"), context)); continue
            usage = self.normalize_usage(parsed["usage"], context) if isinstance(parsed.get("usage"), dict) else None
            yield ProtocolStreamEvent(StreamEventKind.USAGE if usage and not parsed.get("choices") else StreamEventKind.DATA, payload, freeze(parsed), usage)
    def normalize_usage(self, raw_usage, context):
        def token(*paths):
            for path in paths:
                value=raw_usage
                for key in path:
                    if not isinstance(value, dict): value=None; break
                    value=value.get(key)
                if isinstance(value, int) and not isinstance(value,bool) and value >= 0: return UsageDimension(value, "upstream")
            return UsageDimension(None, "missing")
        inp=token(("prompt_tokens",),("input_tokens",)); out=token(("completion_tokens",),("output_tokens",)); total=token(("total_tokens",))
        if total.value is None and inp.value is not None and out.value is not None: total=UsageDimension(inp.value+out.value,"derived")
        bounded={k:v for k,v in raw_usage.items() if k in {"prompt_tokens","input_tokens","completion_tokens","output_tokens","total_tokens","cached_input_tokens","reasoning_tokens"} and (v is None or isinstance(v,int))}
        return NormalizedUsage(inp,out,total,token(("prompt_tokens_details","cached_tokens"),("cached_input_tokens",)),token(("completion_tokens_details","reasoning_tokens"),("reasoning_tokens",)),bounded)
    def normalize_error(self, failure, context):
        status=failure.http_status; hint=failure.category_hint
        if status in (401,403): category="authentication" if status==401 else "permission"
        elif status==429: category="rate_limit"
        elif status and status>=500: category="upstream"
        elif status==400: category="invalid_request"
        else: category=hint or "transport"
        return NormalizedProtocolError(category,status,failure.upstream_code,category in {"rate_limit","upstream","timeout","connection_reset"},category=="rate_limit",category=="authentication",f"protocol-{category.replace('_','-')}",failure.phase)
