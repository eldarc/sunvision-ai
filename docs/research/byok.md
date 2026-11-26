# Research: bring your own Roboflow key (BYOK) and quota handling

Status: research notes and the resulting design, implemented in `api/sunvision_cv/byok.py`, `quota.py` and
`providers.py`, and in `web/src/lib/roboflowKey.ts` and `analyzeApi.ts`. Probes run 2026-11-25 (UTC).
All curl probes used the deliberately invalid key `invalid_test_key`, the generic User-Agent
`Sunvision/0.1 (open-source research prototype)` and a synthetic 64x64 grey PNG. The private key in `.env`
was not used, printed or read.

## TL;DR

* **A browser page on our origin cannot call Roboflow serverless inference directly.**
  `serverless.roboflow.com`, `detect.roboflow.com` and `outline.roboflow.com` send
  `Access-Control-Allow-Origin` only for origins that match `*.roboflow.com`. `http://localhost:5173`,
  `http://127.0.0.1:5173`, `https://example.com` and `null` get no ACAO header on either the preflight or the
  POST, so the browser blocks the response. The user's key therefore has to go through our FastAPI
  (`/api/analyze`), in a request header.
* **`api.roboflow.com` (platform API) is open to every origin** (`Access-Control-Allow-Origin: *`). The browser
  can check a pasted key there before using it (`GET https://api.roboflow.com/` with `Authorization: Bearer`).
* **Out of credits gives HTTP 402.** Roboflow documents 402 as "monthly Hosted API inference quota has been
  reached" with an `AccessException` error type. A real serverless 402 body seen in the wild is
  `{"message":"Not enough credits to perform this request.","error_type":"CreditsExceededError"}`.
  A 402 does not use credits.
* **Free plan:** 10 credits/month, no credit card. RF-DETR Seg 2XL (our model) costs 0.3125 credits per
  1,000 images, so 10 credits cover at most 32,000 images if nothing else in the workspace uses credits.
* **Attribution:** link the Universe model page with its CC BY 4.0 notice, plus a "Powered by Roboflow" text
  link. Use the official logo files from roboflow.com/brand, unaltered. No published rule about
  "Powered by" wording was found.

## 1. Can the browser call Roboflow hosted inference directly?

### Preflight (OPTIONS) with `Origin: http://localhost:5173`

Same result on all three hosts (`serverless`, `detect`, `outline` `.roboflow.com/building-facade-segmentation-instance/4`):

```
HTTP/2 200
access-control-allow-credentials: true
access-control-allow-headers: Content-Type,Authorization,ngrok-skip-browser-warning,api-key,api_key,Access-Control-Allow-Origin,X-Execution-Id,X-Request-ID,X-Roboflow-Special-Namespace,X-Force-Trace
access-control-allow-methods: GET,POST,PUT,DELETE,OPTIONS
access-control-expose-headers: Content-Length,Content-Range,X-Request-Id
access-control-max-age: 1728000
(no access-control-allow-origin)
```

### POST with an invalid key

`POST ...?api_key=invalid_test_key&confidence=0.3`, `Content-Type: application/x-www-form-urlencoded`,
base64 body, `Origin: http://localhost:5173`:

```
HTTP/2 401
content-type: application/json
access-control-allow-credentials: true
access-control-expose-headers: Content-Length,Content-Range,X-Request-Id
(no access-control-allow-origin)
x-inference-engine: inference-models
x-rf-cluster: us-east1

{"status":401,"message":"Unauthorized api_key. This key is not authorized for serverless inference."}
```

* With no key at all: `401 {"status":401,"message":"Unauthorized api_key"}`.
* With `Authorization: Bearer invalid_test_key` instead of `?api_key=`: same 401 body.
* With a non-existent version (`/999`) and an invalid key: still 401, because auth is checked first.
* Workflows endpoint (`/infer/workflows/...`): same CORS behaviour, same 401 body.

### Which origins get `Access-Control-Allow-Origin`

| Origin sent | ACAO on OPTIONS | ACAO on POST |
|---|---|---|
| `http://localhost:5173`, `http://localhost:3000`, `http://localhost`, `http://127.0.0.1:5173` | none | none |
| `https://example.com`, `https://roboflow.com`, `null` | none | none |
| `https://app.roboflow.com`, `https://universe.roboflow.com`, `https://foo.roboflow.com` | reflected | reflected |
| `https://evil-app.roboflow.com.example.com` | reflected | reflected |

The allow-list is origin-based. The 401 for `app.roboflow.com` carries ACAO even with an invalid key, so the
check does not depend on the key. The last row suggests the origin pattern is not anchored at the end
(an origin that only *contains* `.roboflow.com` is reflected together with `Allow-Credentials: true`).
**We must not rely on this.** It is worth a responsible-disclosure note to Roboflow; nothing was sent.

**Caveat (not verified):** a request with a *valid* key was not tried. The evidence (ACAO
missing on the preflight, which carries no key, and present for `*.roboflow.com` even on a 401) points to a
key-independent origin allow-list.

### Platform API (`api.roboflow.com`) is CORS-open

```
OPTIONS https://api.roboflow.com/  (Origin: http://localhost:5173, Request-Headers: authorization)
HTTP/2 204
access-control-allow-origin: *
access-control-allow-headers: authorization

GET https://api.roboflow.com/  (Authorization: Bearer invalid_test_key)
HTTP/2 401
access-control-allow-origin: *
{"error":{"message":"This API key does not exist (or has been revoked).","status":401,"type":"OAuthException","hint":"You may retrieve your API key via the Roboflow Dashboard. Go to Account > Roboflow Keys to retrieve yours."}}
```

So the browser can **validate a pasted key** (and learn its workspace slug for the usage link) directly with
Roboflow, without our server and without running inference. Not verified: whether a successful root call is
free. The credits page lists no per-call rate for REST metadata.

### Request format, for the record (from docs, used server-side)

* `POST https://serverless.roboflow.com/{project}/{version}`.
* Image as a raw base64 string in the body with `Content-Type: application/x-www-form-urlencoded`
  (not multipart, not JSON), or as `?image=<url-encoded URL>`.
* Query parameters: `confidence` (0-100 on the legacy route; inference-sdk sends 0-1), `overlap`, `classes`,
  `format=json`.
* Auth: `Authorization: Bearer <key>` is the recommended channel (keeps the key out of URLs and logs).
  `?api_key=` and a body `api_key` field are legacy. When several are present, the query wins over the header.
  inference-sdk 1.8.6 (our venv) sends the header when `InferenceConfiguration(api_key_transport="header")`,
  which `providers.py` sets.
* Instance segmentation response: detection fields (`x`,`y`,`width`,`height`,`class`,`class_id`,
  `confidence`,`detection_id`) plus `points: [{x,y},...]`, and `image: {width,height}`.

### Publishable keys and OAuth (alternatives considered)

* The **publishable key** (`rf_<workspaceId>`) is browser-safe but is "inference and model download on
  workspace models only", so a user's publishable key would not be expected to run a model owned by the
  `building-facade` Universe workspace. It is meant for inferencejs (in-browser weights), and our model is a
  2XL Seg model, which is too heavy for that. Not tested.
* **Sign in with Roboflow** (OAuth 2.1 + PKCE, scope `model:infer`) exists, but the docs only say the tokens
  work on `api.roboflow.com`, and the code exchange needs a server-side client secret. It would be a
  smoother onboarding path, but it does not replace BYOK.

## 2. Errors for no credits, quota, bad key or no access

Documented REST status codes (docs.roboflow.com/developer/errors-and-status-codes):

| Status | Roboflow meaning | Uses credits? |
|---|---|---|
| 401 | No `api_key`, an invalid one, or a key missing the required scope | yes ("other failures") |
| **402** | Plan does not allow the operation. For inference: "the model or architecture is only available on a credit-based plan, or the workspace's monthly Hosted API inference quota has been reached". Body includes an `AccessException` error type. | **no** |
| 403 | Key is valid but has no access to the workspace or resource | yes |
| 404 | Workspace, project or version not found or not visible | yes |
| 423 | Workspace billing is paused | no |
| 429 | Rate limited. Honour `Retry-After`; `RateLimit-*` headers. Repeated invalid-key requests are limited per IP with a plain-text 429 body. | no |
| 5xx | Server error, safe to retry with backoff | no |

The "Uses credits?" column comes from the Serverless pricing page ("Failed requests"): 402, 408, 409, 423,
429 and 5xx do not use credits, while 401, 403 and 404 still do.

Observed real bodies:

* 401 (our probe): `{"status":401,"message":"Unauthorized api_key. This key is not authorized for serverless inference."}`
* 402 (Roboflow forum, serverless host via inference-sdk):
  `{"message":"Not enough credits to perform this request.","error_type":"CreditsExceededError"}`
  (discuss.roboflow.com/t/11853). The docs name `AccessException`. **Detect on status 402, not on the
  error_type string.**

How inference-sdk 1.8.6 surfaces these errors (`inference_sdk/http/client.py: wrap_errors`):

* An HTTP error becomes `HTTPCallErrorError(status_code, api_message)`, where `api_message` is
  `body.message or body.detail`. `error_type` is **not** exposed, so map by `status_code`.
* 429, 503 and 504 are retried inside the SDK. If the retries fail you get `HTTPCallErrorError` with the
  last status and `api_message=None`. `Retry-After` is not exposed.
* `providers.py` (`error_for_status`) therefore maps by `status_code`, with 402 as its own error (§5.3).
  Only statuses without a specific mapping become the generic `provider_error` (HTTP 502).

## 3. Free plan limits and cost per inference

* roboflow.com/pricing, Free Tier: $0, "does not require a credit card", **10 credits a month**, reset each
  billing period, no rollover. Core costs $39/month with more credits; extra credits are prepaid or
  on-demand (on-demand needs a card).
* roboflow.com/credits, when included credits run out on the free plan: you "will no longer be able to use
  many features of the application" until credits reset or you buy prepaid credits. So it is a hard stop,
  which shows up as 402.
* Serverless pricing (docs.roboflow.com/deployment/roboflow-cloud/serverless-api/model-pricing): billed
  **per image**, "whatever the image size and however long inference takes". RF-DETR Seg rates in credits
  per 1,000 images: Nano 0.1875; Small/Medium/Large/Preview 0.25; **XL and 2XL 0.3125**.
* Our model `building-facade-segmentation-instance/4` is RF-DETR Seg **2XL** (docs/CV_PIPELINE.md, Universe
  metadata), so it costs **0.3125 credits per 1,000 images, or 0.0003125 credits per image**.
  My arithmetic: 10 free credits / 0.0003125 = **32,000 images per month at most**, and only if the workspace
  spends no credits on anything else (storage, training, other models). Credits are per workspace and are
  shared across all its usage.
* Not verified: whether a Universe model run with *your* key bills your workspace at the same rate. The
  pricing page does not mention Universe. The find-your-key page says your key "grants access to ... public
  models on Roboflow Universe, and the hosted inference APIs", so the call is billed to the caller's workspace.
* Also observed in forum reports (not official): during infrastructure stalls some users were billed for
  timed-out requests. Keep our own counter instead of relying on Roboflow's.

## 4. Attribution and where users get a key

* **Model credit (license obligation).** The dataset and model are CC BY 4.0 (repo docs/DATA_SOURCES.md and
  CV_PIPELINE.md, from the Universe page). CC BY needs the creator, the title, a link and the license:
  "Facade model: *building-facade-segmentation-instance* v4 by Building Facade on Roboflow Universe, CC BY 4.0"
  linking to `https://universe.roboflow.com/building-facade/building-facade-segmentation-instance` and
  `https://creativecommons.org/licenses/by/4.0/`. (The Universe page answered 403 to an automated fetch on
  2026-11-25; the licence is as recorded in docs/DATA_SOURCES.md.) The RF-DETR Seg architecture itself, Nano to 2XL, is Apache 2.0
  per docs.roboflow.com/models/model-licenses. Serverless use includes a commercial license.
* **Service credit.** roboflow.com/brand has logos (full logo, wordmark, symbol; ink for light backgrounds,
  light for dark), clear-space guidance and "don't recolor, stretch, squash, rotate, or place on busy
  images". Asset zip: `https://media.roboflow.com/brand/roboflow-brand-assets.zip`. The page does **not**
  define "Powered by" or "Built with" wording. A plain text line "Detection powered by Roboflow" linking to
  roboflow.com, optionally with the unaltered wordmark, is reasonable and does not imply endorsement. Do not
  hotlink the `_next/static` SVG paths, because they are content-hashed. Vendor the files from the zip and
  keep the zip's notice.
* **Sign up:** `https://app.roboflow.com/login` (what every "Get Started for Free" button on
  roboflow.com/pricing links to). Free, no card.
* **Find the key:** `https://app.roboflow.com/settings/api` (Settings, then "API Keys"). It redirects into
  the current workspace (`app.roboflow.com/{workspace}/settings/api`). Copy the **Private API Key**, not the
  publishable `rf_...` key.
* **Check usage:** `app.roboflow.com/{workspace}/settings/usage`. The plan page is `.../settings/plan`.

## 5. Design

### 5.1 Data flow

```
browser ── POST /api/analyze  (multipart image)
           X-Roboflow-Key: <user key>     (optional, header only, never in URL/body/query)
        ◄─ FacadeAnalysis | {detail:{code,message,...}}

api ── user key present?  yes → RoboflowHostedProvider(api_key=user_key), no quota accounting
                          no  → shared key from env, guarded by QuotaStore
     → serverless.roboflow.com with Authorization: Bearer (api_key_transport="header")
```

* **The browser never calls `serverless.roboflow.com`.** CORS forbids it (section 1). The image goes
  through the same validation, EXIF stripping and downscale path in `/api/analyze` as any other upload.
* **Key check on paste (browser only):** `GET https://api.roboflow.com/` with `Authorization: Bearer <key>`.
  A 200 means it is valid, and the response names the workspace (use it for the "check usage" link).
  `401 OAuthException` means it is invalid. If the key starts with `rf_` and is short, warn that it looks
  like the publishable key.
* **Storage:** keep the key in `sessionStorage` by default. Add a "Remember on this device" checkbox that
  moves it to `localStorage`, plus a clear "Forget key" button. Wrap every access in try/catch. Never put the
  key in the zustand persisted scene, exports, share links or analytics.
* **API hygiene for the user key:**
  * Read it from the `X-Roboflow-Key` header.
  * Strip whitespace and reject anything over 128 characters or containing non-printable characters (400
    `invalid_user_key_format`).
  * Never log it. Inference failures are logged by error code only; `str(exc)` for SDK errors is never
    logged without first removing the key (`deduct_api_key_from_string`).
  * Build a fresh `InferenceHTTPClient` for each request. Do not cache clients keyed by user key.
  * The header is listed in the explicit CORS `allow_headers`.
  * Echo `"keySource": "user" | "shared"` in the response `privacy` block, never the key itself.
* **Production:** BYOK requires HTTPS for the API origin.

### 5.2 Shared key with a monthly cap

Environment (`.env`, gitignored; the names, without values, are in `.env.example`):

```
ROBOFLOW_API_KEY=...                         # shared key; tests and dev read it from .env
SUNVISION_SHARED_MONTHLY_IMAGE_CAP=2000      # 0 disables the shared key (BYOK-only public deploy)
SUNVISION_SHARED_DAILY_PER_CLIENT=5          # per IP hash, public deploy abuse guard
SUNVISION_QUOTA_FILE=api/.quota/roboflow.json
```

Why 2,000 and not 32,000: 2,000 × 0.0003125 = 0.625 credits, leaving most of the 10 free credits for
storage, training and our own fixture rebuilds. It is only a default; tune it from the workspace usage
page.

Quota file (one JSON object, rewritten atomically: write to a temp file, `os.replace`, guarded by
`fcntl.flock` on a sidecar lock file. Single-process uvicorn is fine; with several workers the lock is
what keeps it correct):

```json
{
  "period": "2026-11",
  "cap": 2000,
  "used": 137,
  "reserved": 0,
  "exhaustedByProvider": false,
  "exhaustedAt": null,
  "lastProviderStatus": 200,
  "perClient": {"2026-11-25": {"<sha256(ip+salt)[:16]>": 3}}
}
```

Rules:

1. Roll `period` over in UTC at the start of each month. The free plan resets on the workspace's billing
   date, not the 1st; if Roboflow still returns 402 after our reset, rule 3 handles it.
2. Before calling Roboflow with the shared key, check `exhaustedByProvider == false`,
   `used + reserved < cap` and the per-client daily limit. If all pass, `reserved += 1`. Afterwards,
   `reserved -= 1`, and `used += 1` on success or on any 401/403/404 (those use credits). Do not count
   402, 408, 409, 423, 429 or 5xx (Roboflow does not charge them).
3. If Roboflow returns **402** for the shared key, set `exhaustedByProvider = true` and `exhaustedAt`. Every
   later shared request fails immediately until the period rolls over. A retry probe once per 24 h is
   optional.
4. If Roboflow returns **401 or 403** for the shared key, the server is misconfigured. Log it once and
   answer 503 `shared_key_unavailable`; do not blame the user.
5. `/api/health` carries a `sharedQuota` block so the UI can say "N free analyses left this month" before
   anyone uploads: `{ "enabled": true, "remaining": 1863, "cap": 2000, "resetsAt": "2026-12-01T00:00:00Z",
   "exhausted": false }`.

### 5.3 Our API error contract (`{"detail": {"code", "message", ...}}`)

| HTTP | `code` | When | Extra fields |
|---|---|---|---|
| 402 | `shared_quota_exhausted` | Our cap reached, or Roboflow returned 402 on the shared key | `resetsAt`, `cap`, `used`, `byokUrl` |
| 429 | `shared_rate_limited` | Per-client daily cap on the shared key | `Retry-After` header (seconds to UTC midnight) |
| 402 | `user_key_no_credits` | Roboflow 402 with the user's key | `usageUrl` |
| 401 | `user_key_invalid` | Roboflow 401 with the user's key | none |
| 403 | `user_key_forbidden` | Roboflow 403 with the user's key (no access to the model) | none |
| 423 | `user_billing_paused` | Roboflow 423 with the user's key | none |
| 429 | `provider_rate_limited` | Roboflow 429 after SDK retries | `Retry-After` if known, else 30 |
| 400 | `user_key_format` | Malformed header value | none |
| 503 | `shared_key_unavailable` | No shared key configured, cap set to 0, or Roboflow 401/403 on the shared key | `byokUrl` |
| 404 | `model_unavailable` | Roboflow 404 | none |
| 504 | `inference_timeout` | 408/504 or a connection error | none |
| 502 | `provider_error` | Anything else | `providerStatus` |

A missing or rejected key is `shared_key_unavailable` (shared key) or `user_key_invalid` (user key).
`shared_key_unavailable` also carries `legacyCode: "missing_api_key"`.

Provider mapping (inside `RoboflowHostedProvider.infer`, by `exc.status_code`, together with
`key_source`): 402 → `ProviderQuotaError`, 401 → `ProviderAuthError`, 403 → `ProviderForbiddenError`,
423 → `ProviderBillingPausedError`, 429 → `ProviderRateLimitedError`. The app layer turns
(`key_source`, error) into the table above.

### 5.4 UX copy

**Settings popover ("Roboflow key", a small key icon in the header; also opened from any quota error):**

> **Use your own Roboflow key (free)**
> Sunvision uses a Roboflow model to find windows and balconies. We share a small free monthly allowance.
> With your own free key you never hit our limit.
> 1. Create a free account at app.roboflow.com (no card needed).
> 2. Copy your **Private API Key** from Settings → API Keys.
> 3. Paste it here.
>
> [ key input ] [Check & save]   ☐ Remember on this device
>
> Your key stays in this browser and is sent only with your own analysis requests to the Sunvision API,
> which passes it to Roboflow. We never store or log it.
> Detection powered by **Roboflow** · Model: *building-facade-segmentation-instance* v4 by Building Facade on
> Roboflow Universe (CC BY 4.0)

States: "Key works · workspace *{ws}*" (green) / "Roboflow doesn't recognise this key. Copy the Private API
Key, not the publishable `rf_…` key." / "Using your key · [Forget key]".

**Before upload (shared key):** "Free analyses left this month: **1,863**. Using your own Roboflow key
removes this limit."

**`shared_quota_exhausted` (402):**

> **Our free monthly allowance is used up.**
> Sunvision's shared Roboflow allowance ran out for this month (resets {date}). To keep going, add your own
> free Roboflow key. It takes about a minute. [Add my key] [Draw windows by hand instead]

**`shared_rate_limited` (429):** "You've used today's free analyses on the shared key. Add your own free
Roboflow key to continue now, or try again tomorrow."

**`user_key_no_credits` (402):** "Your Roboflow workspace is out of credits for this month. Check your usage
at app.roboflow.com/{ws}/settings/usage, or draw windows by hand."

**`user_key_invalid` (401):** "Roboflow rejected this key. Make sure you copied the Private API Key from
Settings → API Keys." [Edit key]

**`user_key_forbidden` (403):** "This key works but can't run the facade model. Check that it belongs to a
workspace that can use public Universe models."

Every error state offers the manual-annotation fallback ("No geometry is fabricated").

## Sources

* Probes: curl to serverless/detect/outline.roboflow.com and api.roboflow.com, 2026-11-25, invalid key only.
* docs.roboflow.com/developer/errors-and-status-codes
* docs.roboflow.com/deployment/roboflow-cloud/serverless-api/model-pricing ("Failed requests", RF-DETR Seg rates)
* roboflow.com/pricing (Free Tier: 10 credits/month, no card); roboflow.com/credits (free-plan stop)
* docs.roboflow.com/reference/authentication/authentication/find-your-roboflow-api-key (`app.roboflow.com/settings/api`, Bearer header)
* docs.roboflow.com/reference/authentication/authentication (publishable key, OAuth)
* docs.roboflow.com/reference/authentication/authentication/sign-in-with-roboflow-getting-started
* docs.roboflow.com/models/model-licenses (RF-DETR Seg Apache 2.0)
* roboflow.com/brand (logo rules, asset zip)
* discuss.roboflow.com/t/http-402-payment-required-creditsexceedederror-when-using-webrtc-gpu-medium-on-research-plan/11853 (402 body)
* Roboflow MCP skills `roboflow-api-reference` (inference.md, api-key-management.md) and `roboflow-plans-and-pricing` (where to check)
* api/.venv inference_sdk 1.8.6: `http/client.py` (`wrap_errors`, `__auth_headers`), `http/utils/executors.py` (`RETRYABLE_STATUS_CODES = {429, 503, 504}`)
