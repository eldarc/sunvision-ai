# sunvision-ai CV API

Python backend for live photo analysis: Roboflow RF-DETR facade segmentation
(`building-facade-segmentation-instance/4`), Roboflow Supervision post-processing,
window floor-row clustering and Depth Anything relative depth. See
[`docs/CV_PIPELINE.md`](../docs/CV_PIPELINE.md) for the method.

The curated web examples do **not** need this server: they replay recorded inference.

## Setup

```bash
cd api
uv sync --extra depth --group dev        # FastAPI, inference-sdk, supervision, OpenCV, torch+transformers
```

Optional: `uv sync --extra local` adds Roboflow Inference to run the facade model on this machine.

Credentials go in the gitignored `.env` at the repo root (see `.env.example`):

```
ROBOFLOW_API_KEY=...            # shared key: hosted (serverless.roboflow.com) or local weight download
SUNVISION_FACADE_MODEL=building-facade-segmentation-instance/4
SUNVISION_DEPTH_PROVIDER=transformers   # or inference-models (needs key + `inference-models`)
SUNVISION_SHARED_MONTHLY_IMAGE_CAP=2000 # shared-key analyses per UTC month; 0 = BYOK only
SUNVISION_SHARED_DAILY_PER_CLIENT=5     # shared-key analyses per client (hashed IP) per UTC day; 0 = no limit
SUNVISION_QUOTA_FILE=api/.quota/roboflow.json   # gitignored ledger
```

In local development the shared key simply comes from `.env`.

## Run

```bash
cd api && uv run uvicorn sunvision_cv.app:app --reload --port 8000
```

* `GET  /api/health`
* `POST /api/analyze?provider=hosted&depth=true` with multipart field `file`

With `provider=hosted` the (EXIF-stripped, ≤2048 px) image is sent to Roboflow's servers;
the response says so in `privacy` (including `keySource: "user" | "shared"`, never the key).

## Roboflow keys: bring your own, or the shared allowance

Design: [`docs/research/byok.md`](../docs/research/byok.md) §5.

* **Your own key.** Send it in the `X-Roboflow-Key` request header (never a URL or body field).
  The API builds a fresh `InferenceHTTPClient` for that request, passes the key to Roboflow in the
  `Authorization: Bearer` header (`api_key_transport="header"`), and never logs, stores or echoes it.
  Requests with your own key are not counted against the shared allowance. The value is trimmed; more than
  128 characters or non-printable characters give `400 user_key_format`.
* **The shared key** (`ROBOFLOW_API_KEY`) is never sent to the browser. It is capped by
  `SUNVISION_SHARED_MONTHLY_IMAGE_CAP` (per UTC calendar month) and `SUNVISION_SHARED_DAILY_PER_CLIENT`
  (per salted hash of the client IP, per UTC day; raw IPs are never stored). Set
  `SUNVISION_TRUST_PROXY=1` only behind a single reverse proxy that appends `X-Forwarded-For`.
* **Ledger.** `api/.quota/roboflow.json` (gitignored), rewritten atomically (temp file + `os.replace`)
  under `fcntl.flock` on a sidecar `.lock`, so several workers stay consistent. Each shared request
  reserves a slot first; a success or a Roboflow 401/403/404 (and any other unlisted status) counts,
  while 402, 408, 409, 423, 429, 5xx and connection failures do not (Roboflow does not bill them).
  A Roboflow 402 on the shared key marks it exhausted until the month rolls over. An unreadable ledger
  fails closed (shared key refused) until it is fixed or removed.
* **`GET /api/health`** includes
  `sharedQuota: {enabled, remaining, cap, resetsAt, exhausted}` (`remaining` and `cap` are `null` when
  the shared key is disabled or missing). Successful shared-key analyses also return `sharedQuota`.

Error contract (`{"detail": {"code", "message", ...}}`):

| HTTP | `code` | When | Extra |
|---|---|---|---|
| 402 | `shared_quota_exhausted` | our monthly cap reached, or Roboflow 402 on the shared key | `resetsAt`, `cap`, `used`, `byokUrl` |
| 429 | `shared_rate_limited` | per-client daily limit on the shared key | `Retry-After` header (seconds to UTC midnight), `retryAfter` |
| 402 | `user_key_no_credits` | Roboflow 402 with your key | `usageUrl` |
| 401 | `user_key_invalid` | Roboflow 401 with your key | |
| 403 | `user_key_forbidden` | Roboflow 403 with your key | |
| 423 | `user_billing_paused` | Roboflow 423 with your key | |
| 429 | `provider_rate_limited` | Roboflow 429 after inference-sdk retries | `Retry-After` header (30 s), `retryAfter` |
| 400 | `user_key_format` | malformed `X-Roboflow-Key` | |
| 503 | `shared_key_unavailable` | no shared key, cap 0, unreadable ledger, or Roboflow 401/403/423 on the shared key | `byokUrl`, `legacyCode: "missing_api_key"` |
| 404 | `model_unavailable` | Roboflow 404 / invalid model id | |
| 504 | `inference_timeout` | Roboflow 408/504 or no connection | |
| 502 | `provider_error` | anything else | `providerStatus` |

Try the exhaustion path locally with `SUNVISION_SHARED_MONTHLY_IMAGE_CAP=1`, or a BYOK-only server with `0`.

## Build fixture analysis for a curated example

```bash
cd api && uv run python ../scripts/analyze_example.py <example-id>
```

Reads `web/public/examples/<id>/photo.jpg` and the recorded `data/raw/<id>/roboflow_raw.json`
(runs hosted inference once and saves the raw response if it is missing and a key is set),
runs Depth Anything V2 Small locally, and writes `analysis.json`, `depth.png`, `depth16.bin`.

The first run downloads the ~100 MB depth checkpoint from huggingface.co. If the download
stalls behind a proxy (the Rust Xet client ignores some proxy setups), set
`HF_HUB_DISABLE_XET=1` to fall back to plain HTTPS.

## Tests

```bash
cd api && uv run --group dev pytest -q
```

The tests never call Roboflow: `conftest.py` removes `ROBOFLOW_API_KEY` from the environment, points the
quota ledger at a temporary file and replaces `inference_sdk.InferenceHTTPClient` with a guard (key tests
use a recording fake).
