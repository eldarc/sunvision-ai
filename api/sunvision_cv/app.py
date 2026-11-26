"""sunvisionai CV API (FastAPI).

Run:  cd api && uv run uvicorn sunvision_cv.app:app --reload --port 8000

Privacy: uploaded bytes are held in memory only, EXIF (incl. GPS) is removed
before anything is sent to an external service, and image bytes are never
logged. Every /api/analyze response states whether the image left the machine.

Keys (docs/research/byok.md §5): a user's own Roboflow key may arrive in the
``X-Roboflow-Key`` header. It is used for that request only (a fresh
``InferenceHTTPClient``, Authorization header transport) and is never logged,
stored or echoed. Without it the server's shared ``ROBOFLOW_API_KEY`` is used,
guarded by the monthly / per-client allowance in ``quota.py``. The shared key
is never sent to the browser.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .analysis import PIPELINE_VERSION, build_analysis
from .depth import DepthAnythingV2Transformers, InferenceModelsDepth, b64, default_depth_provider
from .images import MAX_BYTES, ImageValidationError, prepare_upload, rescale_analysis
from .byok import (
    USER_KEY_HEADER,
    ApiError,
    client_ip,
    error_for_denial,
    error_for_provider,
    parse_user_key,
    shared_unavailable,
)
from .providers import (
    ProviderError,
    ProviderQuotaError,
    RoboflowHostedProvider,
    RoboflowLocalProvider,
    api_key_from_env,
    get_provider,
    model_id_from_env,
)
from .quota import QuotaDenied, QuotaStore, counts_against_quota

try:  # optional .env at repo root or api/
    from dotenv import load_dotenv

    for p in (Path(__file__).resolve().parents[2] / ".env", Path(__file__).resolve().parents[1] / ".env"):
        if p.exists():
            load_dotenv(p, override=False)
except ImportError:  # pragma: no cover
    pass

log = logging.getLogger("sunvision")

# Whole-request cap for /api/analyze, enforced while the body streams in (before the multipart
# parser spools it to disk): the image limit plus room for the multipart envelope.
MAX_REQUEST_BYTES = MAX_BYTES + 1024 * 1024


def _too_large_detail() -> dict:
    return {"code": "too_large", "message": f"request exceeds {MAX_BYTES // (1024 * 1024)} MB"}


class AnalyzeBodyLimit:
    """ASGI middleware: rejects an /api/analyze body over MAX_REQUEST_BYTES with 413, by
    Content-Length up front and by counting the streamed bytes otherwise."""

    def __init__(self, app, limit: int = MAX_REQUEST_BYTES):
        self.app = app
        self.limit = limit

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("path") != "/api/analyze":
            return await self.app(scope, receive, send)
        for name, value in scope.get("headers", []):
            if name == b"content-length":
                try:
                    too_big = int(value) > self.limit
                except ValueError:
                    too_big = False
                if too_big:
                    return await self._reject(send)
        seen = 0
        started = False

        async def counted_receive():
            nonlocal seen
            msg = await receive()
            if msg["type"] == "http.request":
                seen += len(msg.get("body", b""))
                if seen > self.limit:
                    # An HTTPException passes through FastAPI's body parsing (anything else
                    # would become a 400) and is rendered by its exception handler.
                    raise HTTPException(status_code=413, detail=_too_large_detail())
            return msg

        async def tracked_send(msg):
            nonlocal started
            if msg["type"] == "http.response.start":
                started = True
            await send(msg)

        try:
            await self.app(scope, counted_receive, tracked_send)
        except HTTPException as exc:
            # Raised outside FastAPI's handlers (e.g. while another layer reads the body).
            if exc.status_code != 413 or started:
                raise
            await self._reject(send)

    async def _reject(self, send):
        body = json.dumps({"detail": _too_large_detail()}).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 413,
                "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()), (b"connection", b"close")],
            }
        )
        await send({"type": "http.response.body", "body": body})


app = FastAPI(title="sunvisionai CV API", version=PIPELINE_VERSION)
# Added before CORS so CORS stays outermost and a 413 still carries its headers.
app.add_middleware(AnalyzeBodyLimit)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in os.environ.get("SUNVISION_CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", USER_KEY_HEADER],
    expose_headers=["Retry-After"],
)


def _sdk_installed() -> bool:
    try:
        import inference_sdk  # noqa: F401
    except ImportError:
        return False
    return True


@app.get("/api/health")
def health() -> dict:
    return {
        "status": "ok",
        "pipelineVersion": PIPELINE_VERSION,
        "facadeModel": model_id_from_env(),
        "apiKeyConfigured": api_key_from_env() is not None,
        "providers": {
            "hosted": RoboflowHostedProvider.available(),
            "local": RoboflowLocalProvider.available(),
        },
        "depth": {
            "transformers": DepthAnythingV2Transformers.available(),
            "inferenceModels": InferenceModelsDepth.available(),
        },
        "maxUploadBytes": MAX_BYTES,
        "byok": {"header": USER_KEY_HEADER, "available": _sdk_installed()},
        "sharedQuota": QuotaStore.from_env().status(shared_key_configured=api_key_from_env() is not None),
    }


# A plain `def`: FastAPI runs it in its threadpool, so the blocking Roboflow call, the quota
# ledger lock and Depth Anything never stall the event loop (and /api/health with it).
@app.post("/api/analyze")
def analyze(
    request: Request,
    file: UploadFile = File(...),
    provider: Literal["hosted", "local"] = Query("hosted"),
    depth: bool = Query(True),
    confidence: float = Query(0.3, ge=0.05, le=0.95),
):
    try:
        user_key = parse_user_key(request)
    except ApiError as err:
        return err.response()
    key_source = "user" if user_key else "shared"

    data = file.file.read(MAX_BYTES + 1)
    try:
        img = prepare_upload(data)
    except ImageValidationError as exc:
        raise HTTPException(status_code=exc.status, detail={"code": exc.code, "message": str(exc)}) from exc
    finally:
        del data

    # Only hosted inference with the shared key spends the shared allowance.
    store: QuotaStore | None = None
    reservation = None
    if provider == "hosted" and key_source == "shared":
        if api_key_from_env() is None:
            return shared_unavailable().response()
        store = QuotaStore.from_env()
        try:
            reservation = store.reserve(client_ip(request))
        except QuotaDenied as denied:
            return error_for_denial(denied).response()

    prov = get_provider(provider, confidence=confidence, api_key=user_key, key_source=key_source)
    counted = True  # conservative default if something unexpected escapes
    provider_status: int | None = None
    try:
        result = prov.infer(img.rgb)
        provider_status = 200
    except ProviderError as exc:
        provider_exhausted = isinstance(exc, ProviderQuotaError)
        snapshot = None
        if store is not None and reservation is not None:
            counted = exc.charged if exc.charged is not None else counts_against_quota(exc.status_code)
            store.settle(
                reservation,
                counted=counted,
                provider_status=exc.status_code,
                provider_exhausted=provider_exhausted,
            )
            if provider_exhausted:
                snapshot = store.snapshot()
        err = error_for_provider(exc, key_source, quota_snapshot=snapshot)
        log.warning("inference failed: %s (%s key, provider status %s)", err.code, key_source, exc.status_code)
        return err.response()
    finally:
        if store is not None and reservation is not None and not reservation.settled:
            store.settle(reservation, counted=counted, provider_status=provider_status)

    depth_provider = default_depth_provider() if depth else None
    analysis, depth_enc = build_analysis(
        result,
        image_rgb=img.rgb,
        depth_provider=depth_provider,
        depth_url="",
        depth_bin_url=None,
        confidence_threshold=confidence,
    )
    analysis = rescale_analysis(analysis, 1.0 / img.scale, img.original_width, img.original_height)
    if depth_enc and "depth" in analysis:
        analysis["depth"]["url"] = "data:image/png;base64," + b64(depth_enc["png"])
        analysis["depth"]["binBase64"] = b64(depth_enc["bin"])
    if depth and depth_provider is None:
        analysis["warnings"].append("depth estimation unavailable (install the `depth` extra)")
    analysis["privacy"] = {
        "sentToExternalService": result.sent_to_external_service,
        "service": result.service,
        "exifStripped": True,
        "storedOnServer": False,
        "keySource": key_source if provider == "hosted" else None,
    }
    if store is not None:
        analysis["sharedQuota"] = store.status(shared_key_configured=True)
    analysis["inputScale"] = img.scale
    return analysis
