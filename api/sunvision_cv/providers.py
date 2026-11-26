"""Inference providers for the facade segmentation model.

All providers return a `ProviderResult` whose `raw` field is the unmodified
Roboflow-format response (``{"image": {...}, "predictions": [...]}``) so that
fixtures can be replayed byte-for-byte.

Providers
---------
* ``RoboflowHostedProvider`` – Roboflow Serverless API via ``inference-sdk``
  (``InferenceHTTPClient``). Uses the caller's own key (``X-Roboflow-Key``,
  bring-your-own-key) or the shared ``ROBOFLOW_API_KEY``. Sends the image to
  Roboflow's servers – callers must disclose this to the user.
* ``RoboflowLocalProvider`` – runs the model on this machine with the
  ``inference`` package (``inference.get_model``). Weights are downloaded once
  with ``ROBOFLOW_API_KEY``; the image itself never leaves the machine.
* ``ReplayProvider`` – loads a previously saved raw response (used for the
  curated examples and for tests; no network).
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

DEFAULT_MODEL_ID = "building-facade-segmentation-instance/4"
DEFAULT_API_URL = "https://serverless.roboflow.com"

MODEL_CARD = {
    "building-facade-segmentation-instance/4": {
        "architecture": "rfdetr-seg-2xlarge",
        "universeUrl": "https://universe.roboflow.com/building-facade/building-facade-segmentation-instance",
        "license": "CC BY 4.0",
    }
}


class ProviderError(RuntimeError):
    """Base class; `code` is a stable machine-readable string for the API.

    `status_code` is the HTTP status Roboflow answered with (None when no
    response was received or the request was never sent). `charged` says
    whether Roboflow is expected to bill the request: True/False when known,
    None to let the quota layer decide from `status_code` (see quota.py).
    Messages never contain an API key.
    """

    code = "provider_error"

    def __init__(
        self,
        message: str = "",
        *,
        status_code: int | None = None,
        charged: bool | None = None,
        retry_after: int | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.charged = charged
        self.retry_after = retry_after


class MissingApiKeyError(ProviderError):
    code = "missing_api_key"


class ModelUnavailableError(ProviderError):
    code = "model_unavailable"


class InferenceTimeoutError(ProviderError):
    code = "inference_timeout"


class ProviderNotInstalledError(ProviderError):
    code = "provider_not_installed"


class ProviderQuotaError(ProviderError):
    """Roboflow 402: the workspace is out of credits (or the plan forbids the model)."""

    code = "provider_quota"


class ProviderAuthError(ProviderError):
    """Roboflow 401: missing, invalid or revoked key."""

    code = "provider_auth"


class ProviderForbiddenError(ProviderError):
    """Roboflow 403: valid key without access to the model."""

    code = "provider_forbidden"


class ProviderBillingPausedError(ProviderError):
    """Roboflow 423: workspace billing is paused."""

    code = "provider_billing_paused"


class ProviderRateLimitedError(ProviderError):
    """Roboflow 429 (after inference-sdk's own retries)."""

    code = "provider_rate_limited"


_STATUS_ERRORS: dict[int, type[ProviderError]] = {
    401: ProviderAuthError,
    402: ProviderQuotaError,
    403: ProviderForbiddenError,
    404: ModelUnavailableError,
    408: InferenceTimeoutError,
    423: ProviderBillingPausedError,
    429: ProviderRateLimitedError,
    504: InferenceTimeoutError,
}


def scrub_secret(text: str | None, *secrets: str | None) -> str:
    """Remove every occurrence of the given secrets (API keys) from `text`."""
    out = text or ""
    for secret in secrets:
        if secret:
            out = out.replace(secret, "[redacted]")
    return out


def error_for_status(status: int | None, api_message: str | None, *, model_id: str, secrets: tuple = ()) -> ProviderError:
    """Map a Roboflow HTTP status (from `HTTPCallErrorError.status_code`) to a provider error.

    The mapping is by status only: inference-sdk does not expose Roboflow's
    `error_type`, and Roboflow documents 402 for "out of credits" (byok.md §2).
    """
    detail = scrub_secret(api_message, *secrets)[:300]
    suffix = f": {detail}" if detail and detail != "N/A" else ""
    cls = _STATUS_ERRORS.get(status or -1, ProviderError)
    if cls is ModelUnavailableError:
        msg = f"Model {model_id} not found or not visible to this key ({status}){suffix}"
    elif cls is InferenceTimeoutError:
        msg = f"Roboflow inference timed out ({status})."
    else:
        msg = f"Roboflow answered {status}{suffix}"
    return cls(msg, status_code=status)


@dataclass
class ProviderResult:
    raw: dict[str, Any]
    provider: str  # matches ModelInfo.provider in scene.ts
    model_id: str
    inference_ms: float
    sent_to_external_service: bool
    service: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


def model_id_from_env() -> str:
    return os.environ.get("SUNVISION_FACADE_MODEL", DEFAULT_MODEL_ID)


def api_key_from_env() -> str | None:
    key = os.environ.get("ROBOFLOW_API_KEY", "").strip()
    return key or None


class RoboflowHostedProvider:
    name = "roboflow-hosted"

    def __init__(
        self,
        api_key: str | None = None,
        model_id: str | None = None,
        api_url: str | None = None,
        confidence: float = 0.3,
        key_source: str = "shared",
    ) -> None:
        self.api_key = api_key or api_key_from_env()
        self.key_source = key_source
        self.model_id = model_id or model_id_from_env()
        self.api_url = api_url or os.environ.get("ROBOFLOW_API_URL", DEFAULT_API_URL)
        self.confidence = confidence

    @staticmethod
    def available() -> bool:
        try:
            import inference_sdk  # noqa: F401
        except ImportError:
            return False
        return api_key_from_env() is not None

    def infer(self, image: np.ndarray) -> ProviderResult:
        """`image` is an RGB uint8 array (EXIF already stripped by the caller).

        A fresh `InferenceHTTPClient` is built for every call (never cached, so a
        user's key cannot leak into another request) and the key always travels
        in the `Authorization: Bearer` header, never in a URL.
        """
        if not self.api_key:
            raise MissingApiKeyError(
                "ROBOFLOW_API_KEY is not set. Add it to the gitignored .env file to enable hosted inference.",
                charged=False,
            )
        import inference_sdk
        from inference_sdk.http.errors import (
            EncodingError,
            HTTPCallErrorError,
            HTTPClientError,
            HTTPServerConnectionError,
            InvalidInputFormatError,
            InvalidModelIdentifier,
        )

        try:
            cfg = inference_sdk.InferenceConfiguration(
                confidence_threshold=self.confidence, api_key_transport="header"
            )
        except TypeError as exc:  # inference-sdk too old to send the key in a header
            raise ProviderNotInstalledError(
                "The installed inference-sdk cannot send the API key in a header. Upgrade inference-sdk.",
                charged=False,
            ) from exc
        client = inference_sdk.InferenceHTTPClient(api_url=self.api_url, api_key=self.api_key)
        client.configure(cfg)
        # inference-sdk treats numpy arrays as BGR (OpenCV convention).
        bgr = np.ascontiguousarray(image[:, :, ::-1])
        t0 = time.perf_counter()
        try:
            raw = client.infer(bgr, model_id=self.model_id)
        except InvalidModelIdentifier as exc:
            raise ModelUnavailableError(f"Invalid model id {self.model_id!r}.", charged=False) from exc
        except HTTPCallErrorError as exc:
            raise error_for_status(
                getattr(exc, "status_code", None),
                getattr(exc, "api_message", None),
                model_id=self.model_id,
                secrets=(self.api_key,),
            ) from exc
        except HTTPServerConnectionError as exc:
            raise InferenceTimeoutError(f"Could not reach {self.api_url}.", charged=False) from exc
        except (EncodingError, InvalidInputFormatError) as exc:
            raise ProviderError("Could not encode the image for Roboflow.", charged=False) from exc
        except HTTPClientError as exc:
            # e.g. retries exhausted without a status: the request may have been billed.
            raise ProviderError("Roboflow inference failed without an HTTP status.", charged=True) from exc
        finally:
            del client
        ms = (time.perf_counter() - t0) * 1000
        if isinstance(raw, list):
            raw = raw[0]
        return ProviderResult(
            raw=raw,
            provider=self.name,
            model_id=self.model_id,
            inference_ms=ms,
            sent_to_external_service=True,
            service=self.api_url,
            extra={"keySource": self.key_source},
        )

    def __repr__(self) -> str:  # never show the key
        return f"RoboflowHostedProvider(model_id={self.model_id!r}, api_url={self.api_url!r}, key_source={self.key_source!r})"


class RoboflowLocalProvider:
    """Runs the model locally with Roboflow Inference (`pip install inference`)."""

    name = "roboflow-inference-local"
    _cache: dict[str, Any] = {}

    def __init__(self, api_key: str | None = None, model_id: str | None = None, confidence: float = 0.3):
        # A user's own key (passed explicitly) is used for this request only: a model loaded
        # with it is never put in, or served from, the process-wide cache.
        self._user_key = api_key is not None
        self.api_key = api_key or api_key_from_env()
        self.model_id = model_id or model_id_from_env()
        self.confidence = confidence

    @staticmethod
    def available() -> bool:
        try:
            import inference  # noqa: F401
        except ImportError:
            return False
        return True

    def _model(self):
        if not self._user_key and self.model_id in self._cache:
            return self._cache[self.model_id]
        try:
            from inference import get_model
        except ImportError as exc:
            raise ProviderNotInstalledError(
                "The `inference` package is not installed. Run `uv sync --extra local`."
            ) from exc
        if not self.api_key:
            raise MissingApiKeyError("ROBOFLOW_API_KEY is required once to download the model weights.", charged=False)
        try:
            model = get_model(model_id=self.model_id, api_key=self.api_key)
        except Exception as exc:  # inference raises several model-loading errors
            raise ModelUnavailableError(
                f"Could not load {self.model_id} locally: {scrub_secret(str(exc), self.api_key)[:300]}", charged=False
            ) from exc
        if not self._user_key:
            self._cache[self.model_id] = model
        return model

    def infer(self, image: np.ndarray) -> ProviderResult:
        model = self._model()
        bgr = np.ascontiguousarray(image[:, :, ::-1])
        t0 = time.perf_counter()
        result = model.infer(bgr, confidence=self.confidence)
        ms = (time.perf_counter() - t0) * 1000
        if isinstance(result, list):
            result = result[0]
        raw = result.model_dump(by_alias=True, exclude_none=True) if hasattr(result, "model_dump") else dict(result)
        return ProviderResult(
            raw=raw,
            provider=self.name,
            model_id=self.model_id,
            inference_ms=ms,
            sent_to_external_service=False,
        )


class ReplayProvider:
    """Replays a saved raw Roboflow response (curated examples, tests)."""

    name = "replay"

    def __init__(self, path: str | Path, provider_label: str = "roboflow-hosted", model_id: str | None = None):
        self.path = Path(path)
        self.provider_label = provider_label
        self.model_id = model_id or model_id_from_env()

    def infer(self, image: np.ndarray | None = None) -> ProviderResult:
        if not self.path.exists():
            raise ModelUnavailableError(f"No recorded inference at {self.path}")
        raw = json.loads(self.path.read_text())
        ms = float(raw.get("time", 0.0)) * 1000 if isinstance(raw.get("time"), (int, float)) else 0.0
        return ProviderResult(
            raw=raw,
            provider=self.provider_label,
            model_id=self.model_id,
            inference_ms=ms,
            sent_to_external_service=False,
            extra={"replayedFrom": str(self.path)},
        )


def get_provider(name: str, confidence: float = 0.3, api_key: str | None = None, key_source: str = "shared"):
    """`api_key=None` means the shared key from the environment."""
    if name == "hosted":
        return RoboflowHostedProvider(api_key=api_key, confidence=confidence, key_source=key_source)
    if name == "local":
        return RoboflowLocalProvider(api_key=api_key, confidence=confidence)
    raise ValueError(f"Unknown provider {name!r} (expected 'hosted' or 'local')")
