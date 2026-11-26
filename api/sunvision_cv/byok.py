"""Bring-your-own-key plumbing and the API error contract (docs/research/byok.md §5.1, §5.3).

* The user's Roboflow key arrives in the ``X-Roboflow-Key`` request header only.
  It is used for that one request, never logged, never stored and never echoed.
* Errors have the shape ``{"detail": {"code", "message", ...}}``.
"""
from __future__ import annotations

import ipaddress
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Literal

from fastapi import Request
from fastapi.responses import JSONResponse

from .providers import (
    InferenceTimeoutError,
    MissingApiKeyError,
    ModelUnavailableError,
    ProviderAuthError,
    ProviderBillingPausedError,
    ProviderError,
    ProviderForbiddenError,
    ProviderNotInstalledError,
    ProviderQuotaError,
    ProviderRateLimitedError,
)
from .quota import QuotaDenied

log = logging.getLogger("sunvision")

USER_KEY_HEADER = "X-Roboflow-Key"
MAX_USER_KEY_LEN = 128
BYOK_URL = "https://app.roboflow.com/settings/api"
USAGE_URL = "https://app.roboflow.com"
DEFAULT_PROVIDER_RETRY_AFTER_S = 30

KeySource = Literal["user", "shared"]


@dataclass
class ApiError(Exception):
    status: int
    code: str
    message: str
    extra: dict[str, Any] = field(default_factory=dict)
    headers: dict[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        super().__init__(self.code)

    def response(self) -> JSONResponse:
        return JSONResponse(
            status_code=self.status,
            content={"detail": {"code": self.code, "message": self.message, **self.extra}},
            headers=self.headers or None,
        )


def parse_user_key(request: Request) -> str | None:
    """Read and validate the optional ``X-Roboflow-Key`` header.

    Whitespace is stripped; an empty value means "no key". Values over 128
    characters or with non-printable / non-ASCII characters are rejected with
    400 ``user_key_format``. The value is never included in the error.
    """
    raw = request.headers.get(USER_KEY_HEADER)
    if raw is None:
        return None
    key = raw.strip()
    if not key:
        return None
    if len(key) > MAX_USER_KEY_LEN or not all(33 <= ord(ch) <= 126 for ch in key):
        raise ApiError(
            400,
            "user_key_format",
            f"The {USER_KEY_HEADER} header is not a valid Roboflow API key "
            f"(printable ASCII, no spaces, at most {MAX_USER_KEY_LEN} characters).",
        )
    return key


def client_bucket(address: str) -> str:
    """Per-client key for an address: an IPv6 address counts as its /64.

    One IPv6 subscriber usually holds at least a /64 and can pick any address
    in it, so keying on the full address would give them unlimited buckets.
    IPv4 (including IPv4-mapped IPv6) and unparseable values are kept as given.
    """
    try:
        ip = ipaddress.ip_address(address.strip("[]"))
    except ValueError:
        return address
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return str(ip.ipv4_mapped)
        return str(ipaddress.IPv6Network((ip, 64), strict=False))
    return str(ip)


def client_ip(request: Request) -> str | None:
    """Client address for the per-client daily limit (an IPv6 client as its /64).

    ``X-Forwarded-For`` is honoured only with ``SUNVISION_TRUST_PROXY=1`` (deploy
    behind exactly one reverse proxy); then the last hop, which that proxy
    appended, is used, so a client cannot spoof it.
    """
    if os.environ.get("SUNVISION_TRUST_PROXY", "").strip().lower() in ("1", "true", "yes"):
        xff = request.headers.get("x-forwarded-for", "")
        hops = [h.strip() for h in xff.split(",") if h.strip()]
        if hops:
            return client_bucket(hops[-1])
    return client_bucket(request.client.host) if request.client and request.client.host else None


def shared_unavailable(message: str | None = None) -> ApiError:
    return ApiError(
        503,
        "shared_key_unavailable",
        message or "This server has no shared Roboflow key available. Add your own free Roboflow key.",
        {"byokUrl": BYOK_URL, "legacyCode": "missing_api_key"},
    )


def shared_exhausted(*, cap: int | None, used: int | None, resets_at: str) -> ApiError:
    return ApiError(
        402,
        "shared_quota_exhausted",
        "The shared Roboflow allowance for this month is used up. Add your own free Roboflow key.",
        {"resetsAt": resets_at, "cap": cap, "used": used, "byokUrl": BYOK_URL},
    )


def error_for_denial(denied: QuotaDenied) -> ApiError:
    if denied.reason in ("disabled", "ledger"):
        return shared_unavailable()
    if denied.reason == "client_daily":
        retry = denied.retry_after or 1
        return ApiError(
            429,
            "shared_rate_limited",
            "Today's free analyses on the shared key are used up for this client. Add your own free Roboflow key.",
            {"retryAfter": retry, "byokUrl": BYOK_URL},
            {"Retry-After": str(retry)},
        )
    return shared_exhausted(cap=denied.cap, used=denied.used, resets_at=denied.resets_at)


_warned_shared_status: set[int] = set()


def error_for_provider(exc: ProviderError, key_source: KeySource, *, quota_snapshot: dict | None = None) -> ApiError:
    """Turn (key source, provider error) into the byok.md §5.3 contract."""
    status = exc.status_code
    if isinstance(exc, ProviderRateLimitedError):
        retry = exc.retry_after or DEFAULT_PROVIDER_RETRY_AFTER_S
        return ApiError(
            429,
            "provider_rate_limited",
            "Roboflow is rate-limiting requests. Try again in a moment.",
            {"retryAfter": retry},
            {"Retry-After": str(retry)},
        )
    if isinstance(exc, ModelUnavailableError):
        return ApiError(404, "model_unavailable", str(exc))
    if isinstance(exc, InferenceTimeoutError):
        return ApiError(504, "inference_timeout", str(exc))
    if isinstance(exc, ProviderNotInstalledError):
        return ApiError(503, "provider_not_installed", str(exc))

    if key_source == "user":
        if isinstance(exc, ProviderQuotaError):
            return ApiError(
                402,
                "user_key_no_credits",
                "Your Roboflow workspace is out of credits this month.",
                {"usageUrl": USAGE_URL},
            )
        if isinstance(exc, (ProviderAuthError, MissingApiKeyError)):
            return ApiError(401, "user_key_invalid", "Roboflow rejected this key. Use the Private API Key.")
        if isinstance(exc, ProviderForbiddenError):
            return ApiError(403, "user_key_forbidden", "This key is valid but cannot run the facade model.")
        if isinstance(exc, ProviderBillingPausedError):
            return ApiError(423, "user_billing_paused", "Billing is paused for your Roboflow workspace.")
    else:
        if isinstance(exc, ProviderQuotaError):
            snap = quota_snapshot or {}
            return shared_exhausted(cap=snap.get("cap"), used=snap.get("used"), resets_at=snap.get("resetsAt", ""))
        if isinstance(exc, (ProviderAuthError, ProviderForbiddenError, ProviderBillingPausedError)):
            if (status or 0) not in _warned_shared_status:  # misconfiguration: log once per status
                _warned_shared_status.add(status or 0)
                log.error("shared Roboflow key refused by the provider (HTTP %s); check ROBOFLOW_API_KEY", status)
            return shared_unavailable()
        if isinstance(exc, MissingApiKeyError):
            return shared_unavailable()

    return ApiError(
        502,
        "provider_error",
        "Roboflow inference failed.",
        {"providerStatus": status},
    )
