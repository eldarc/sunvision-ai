"""Bring-your-own-key, shared-key allowance and error mapping through the HTTP API.

inference-sdk's `InferenceHTTPClient` is replaced by a fake: no network, no Roboflow calls.
"""
import json
import logging

import pytest
from fastapi.testclient import TestClient
from inference_sdk.http.errors import HTTPCallErrorError, HTTPServerConnectionError

from sunvision_cv import app as app_module

USER_KEY = "uSeRkEy0123456789abcdef"
SHARED_KEY = "sHaReDkEy9876543210fedcba"

client = TestClient(app_module.app)


class FakeRoboflow:
    """Stands in for `inference_sdk.InferenceHTTPClient`; records every instance."""

    def __init__(self, raw):
        self.raw = raw
        self.instances = []
        self.error = None

    def factory(self):
        fake = self

        class FakeClient:
            def __init__(self, api_url, api_key=None):
                self.api_url, self.api_key, self.cfg = api_url, api_key, None
                fake.instances.append(self)

            def configure(self, cfg):
                self.cfg = cfg
                return self

            def infer(self, image, model_id=None):
                assert self.cfg is not None, "configure() must run before infer()"
                if fake.error is not None:
                    raise fake.error
                return fake.raw

        return FakeClient

    def fail(self, status, message=None):
        self.error = HTTPCallErrorError(description=f"HTTP {status}", status_code=status, api_message=message)


@pytest.fixture
def rf(monkeypatch, thumb_raw):
    import inference_sdk

    fake = FakeRoboflow(thumb_raw)
    monkeypatch.setattr(inference_sdk, "InferenceHTTPClient", fake.factory())
    return fake


@pytest.fixture
def shared(monkeypatch):
    monkeypatch.setenv("ROBOFLOW_API_KEY", SHARED_KEY)
    monkeypatch.setenv("SUNVISION_SHARED_MONTHLY_IMAGE_CAP", "10")
    monkeypatch.setenv("SUNVISION_SHARED_DAILY_PER_CLIENT", "0")


@pytest.fixture
def photo(thumb_path):
    return thumb_path.read_bytes()


def post(photo, key=None, provider="hosted"):
    headers = {"X-Roboflow-Key": key} if key is not None else {}
    return client.post(
        f"/api/analyze?depth=false&provider={provider}",
        files={"file": ("t.jpg", photo, "image/jpeg")},
        headers=headers,
    )


def ledger():
    import os
    from pathlib import Path

    p = Path(os.environ["SUNVISION_QUOTA_FILE"])
    return json.loads(p.read_text()) if p.exists() else None


# --------------------------------------------------------------- header passthrough
def test_user_key_passthrough_never_logged_or_echoed(rf, shared, photo, caplog):
    caplog.set_level(logging.DEBUG)
    r1 = post(photo, key=f"  {USER_KEY}  ")
    r2 = post(photo, key=USER_KEY)
    assert r1.status_code == 200 and r2.status_code == 200, r1.text
    # A fresh client per request, carrying the user's key in the Authorization header.
    assert len(rf.instances) == 2 and rf.instances[0] is not rf.instances[1]
    for inst in rf.instances:
        assert inst.api_key == USER_KEY
        transport = inst.cfg.api_key_transport
        assert getattr(transport, "value", transport) == "header"
    body = r1.json()
    assert body["privacy"]["keySource"] == "user" and body["privacy"]["sentToExternalService"] is True
    assert "sharedQuota" not in body
    for r in (r1, r2):
        assert USER_KEY not in r.text and SHARED_KEY not in r.text
        assert all(USER_KEY not in v for v in r.headers.values())
    assert USER_KEY not in caplog.text and SHARED_KEY not in caplog.text
    assert ledger() is None  # user-key requests never touch the shared allowance


def test_user_key_is_not_capped_by_shared_allowance(rf, shared, photo, monkeypatch):
    monkeypatch.setenv("SUNVISION_SHARED_MONTHLY_IMAGE_CAP", "0")
    assert post(photo, key=USER_KEY).status_code == 200


def test_user_key_works_without_shared_key(rf, photo):
    r = post(photo, key=USER_KEY)
    assert r.status_code == 200 and r.json()["privacy"]["keySource"] == "user"


def test_shared_key_path(rf, shared, photo, caplog):
    caplog.set_level(logging.DEBUG)
    r = post(photo)
    assert r.status_code == 200
    body = r.json()
    assert rf.instances[0].api_key == SHARED_KEY
    assert body["privacy"]["keySource"] == "shared"
    assert body["sharedQuota"] == {**body["sharedQuota"], "enabled": True, "remaining": 9, "cap": 10, "exhausted": False}
    assert SHARED_KEY not in r.text and SHARED_KEY not in caplog.text
    assert ledger()["used"] == 1 and ledger()["reserved"] == 0


def test_blank_header_means_shared(rf, shared, photo):
    r = post(photo, key="   ")
    assert r.status_code == 200 and r.json()["privacy"]["keySource"] == "shared"


@pytest.mark.parametrize("bad", ["x" * 129, "abc def", "abc\x7fdef", "kéy"])
def test_user_key_format(rf, photo, bad):
    try:
        r = post(photo, key=bad)
    except UnicodeEncodeError:
        # httpx refuses non-latin-1 header values before sending; nothing reaches the server.
        r = client.post(
            "/api/analyze?depth=false",
            files={"file": ("t.jpg", photo, "image/jpeg")},
            headers=[(b"X-Roboflow-Key", bad.encode("utf-8"))],
        )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "user_key_format"
    assert bad not in r.text
    assert rf.instances == []


# --------------------------------------------------------------- error mapping, user key
@pytest.mark.parametrize(
    "rf_status,http,code",
    [
        (401, 401, "user_key_invalid"),
        (402, 402, "user_key_no_credits"),
        (403, 403, "user_key_forbidden"),
        (423, 423, "user_billing_paused"),
        (429, 429, "provider_rate_limited"),
        (404, 404, "model_unavailable"),
        (408, 504, "inference_timeout"),
        (504, 504, "inference_timeout"),
        (500, 502, "provider_error"),
        (503, 502, "provider_error"),
    ],
)
def test_user_key_error_mapping(rf, shared, photo, caplog, rf_status, http, code):
    caplog.set_level(logging.DEBUG)
    rf.fail(rf_status, message=f"echo of {USER_KEY} from upstream")
    r = post(photo, key=USER_KEY)
    assert r.status_code == http, r.text
    detail = r.json()["detail"]
    assert detail["code"] == code
    if code == "provider_rate_limited":
        assert r.headers["Retry-After"] == "30"
    if code == "user_key_no_credits":
        assert detail["usageUrl"].startswith("https://app.roboflow.com")
    if code == "provider_error":
        assert detail["providerStatus"] == rf_status
    assert USER_KEY not in r.text and USER_KEY not in caplog.text
    assert ledger() is None


def test_connection_error_is_timeout(rf, photo):
    rf.error = HTTPServerConnectionError("Error with server connection")
    r = post(photo, key=USER_KEY)
    assert r.status_code == 504 and r.json()["detail"]["code"] == "inference_timeout"


# --------------------------------------------------------------- shared key: accounting and mapping
@pytest.mark.parametrize(
    "rf_status,http,code,counted",
    [
        (401, 503, "shared_key_unavailable", True),
        (403, 503, "shared_key_unavailable", True),
        (404, 404, "model_unavailable", True),
        (423, 503, "shared_key_unavailable", False),
        (429, 429, "provider_rate_limited", False),
        (408, 504, "inference_timeout", False),
        (409, 502, "provider_error", False),
        (500, 502, "provider_error", False),
        (502, 502, "provider_error", False),
        (504, 504, "inference_timeout", False),
    ],
)
def test_shared_key_error_mapping_and_counting(rf, shared, photo, rf_status, http, code, counted):
    rf.fail(rf_status)
    r = post(photo)
    assert r.status_code == http and r.json()["detail"]["code"] == code
    st = ledger()
    assert st["used"] == (1 if counted else 0) and st["reserved"] == 0
    assert st["lastProviderStatus"] == rf_status
    if code == "shared_key_unavailable":
        assert r.json()["detail"]["byokUrl"].startswith("https://app.roboflow.com")
    assert SHARED_KEY not in r.text


def test_shared_402_marks_exhausted_until_rollover(rf, shared, photo):
    rf.fail(402, "Not enough credits to perform this request.")
    r = post(photo)
    assert r.status_code == 402
    d = r.json()["detail"]
    assert d["code"] == "shared_quota_exhausted"
    assert d["cap"] == 10 and d["used"] == 0 and d["resetsAt"].endswith("T00:00:00Z") and d["byokUrl"]
    st = ledger()
    assert st["exhaustedByProvider"] is True and st["used"] == 0
    # Later shared requests fail without calling Roboflow; a user key still works.
    rf.error = None
    n = len(rf.instances)
    r = post(photo)
    assert r.status_code == 402 and r.json()["detail"]["code"] == "shared_quota_exhausted"
    assert len(rf.instances) == n
    assert post(photo, key=USER_KEY).status_code == 200
    h = client.get("/api/health").json()["sharedQuota"]
    assert h["exhausted"] is True and h["remaining"] == 0


def test_shared_cap_reached(rf, shared, photo, monkeypatch):
    monkeypatch.setenv("SUNVISION_SHARED_MONTHLY_IMAGE_CAP", "1")
    assert post(photo).status_code == 200
    r = post(photo)
    assert r.status_code == 402
    d = r.json()["detail"]
    assert d["code"] == "shared_quota_exhausted" and d["cap"] == 1 and d["used"] == 1
    assert len(rf.instances) == 1


def test_shared_daily_per_client(rf, shared, photo, monkeypatch):
    monkeypatch.setenv("SUNVISION_SHARED_DAILY_PER_CLIENT", "2")
    assert post(photo).status_code == 200
    assert post(photo).status_code == 200
    r = post(photo)
    assert r.status_code == 429
    assert r.json()["detail"]["code"] == "shared_rate_limited"
    assert 1 <= int(r.headers["Retry-After"]) <= 86400
    assert len(rf.instances) == 2
    assert post(photo, key=USER_KEY).status_code == 200  # own key bypasses it


def test_trusted_proxy_client_ip(rf, shared, photo, monkeypatch):
    monkeypatch.setenv("SUNVISION_SHARED_DAILY_PER_CLIENT", "1")
    monkeypatch.setenv("SUNVISION_TRUST_PROXY", "1")

    def via(ip):
        return client.post(
            "/api/analyze?depth=false",
            files={"file": ("t.jpg", photo, "image/jpeg")},
            headers={"X-Forwarded-For": f"198.51.100.9, {ip}"},
        )

    assert via("192.0.2.1").status_code == 200
    assert via("192.0.2.1").status_code == 429
    assert via("192.0.2.2").status_code == 200
    assert "192.0.2.1" not in json.dumps(ledger())


def test_ipv6_clients_share_their_64(rf, shared, photo, monkeypatch):
    monkeypatch.setenv("SUNVISION_SHARED_DAILY_PER_CLIENT", "1")
    monkeypatch.setenv("SUNVISION_TRUST_PROXY", "1")

    def via(ip):
        return client.post(
            "/api/analyze?depth=false",
            files={"file": ("t.jpg", photo, "image/jpeg")},
            headers={"X-Forwarded-For": ip},
        )

    assert via("2001:db8:1:2::1").status_code == 200
    assert via("2001:db8:1:2:abcd::99").status_code == 429  # same /64
    assert via("2001:db8:1:3::1").status_code == 200  # another /64


def test_client_bucket():
    from sunvision_cv.byok import client_bucket

    assert client_bucket("192.0.2.1") == "192.0.2.1"
    assert client_bucket("2001:db8:1:2:aaaa:bbbb:cccc:dddd") == "2001:db8:1:2::/64"
    assert client_bucket("::ffff:192.0.2.1") == "192.0.2.1"
    assert client_bucket("testclient") == "testclient"


def test_no_shared_key(rf, photo):
    r = post(photo)
    assert r.status_code == 503 and r.json()["detail"]["code"] == "shared_key_unavailable"
    assert rf.instances == []


def test_cap_zero_is_byok_only(rf, shared, photo, monkeypatch):
    monkeypatch.setenv("SUNVISION_SHARED_MONTHLY_IMAGE_CAP", "0")
    r = post(photo)
    assert r.status_code == 503 and r.json()["detail"]["code"] == "shared_key_unavailable"
    assert rf.instances == [] and ledger() is None


def test_validation_errors_do_not_spend_allowance(rf, shared):
    r = client.post("/api/analyze?depth=false", files={"file": ("x.jpg", b"not an image", "image/jpeg")})
    assert r.status_code == 400 and ledger() is None


# --------------------------------------------------------------- health and CORS
def test_health_shared_quota_block(rf, shared, photo):
    h = client.get("/api/health")
    q = h.json()["sharedQuota"]
    assert set(q) == {"enabled", "remaining", "cap", "resetsAt", "exhausted"}
    assert q["enabled"] is True and q["remaining"] == 10 and q["cap"] == 10 and q["exhausted"] is False
    assert q["resetsAt"].endswith("-01T00:00:00Z")
    assert SHARED_KEY not in h.text
    post(photo)
    assert client.get("/api/health").json()["sharedQuota"]["remaining"] == 9


def test_health_without_shared_key():
    q = client.get("/api/health").json()["sharedQuota"]
    assert q == {"enabled": False, "remaining": None, "cap": None, "resetsAt": None, "exhausted": False}


def test_health_cap_zero(shared, monkeypatch):
    monkeypatch.setenv("SUNVISION_SHARED_MONTHLY_IMAGE_CAP", "0")
    assert client.get("/api/health").json()["sharedQuota"]["enabled"] is False


def test_cors_allows_key_header():
    r = client.options(
        "/api/analyze",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "x-roboflow-key",
        },
    )
    assert r.status_code == 200
    assert "x-roboflow-key" in r.headers["access-control-allow-headers"].lower()
    assert r.headers["access-control-allow-origin"] == "http://localhost:5173"


# --------------------------------------------------------------- request body cap


def test_oversized_body_rejected_by_content_length(rf, shared):
    big = b"\0" * (app_module.MAX_REQUEST_BYTES + 10)
    r = client.post("/api/analyze?depth=false", files={"file": ("t.jpg", big, "image/jpeg")})
    assert r.status_code == 413
    assert r.json()["detail"]["code"] == "too_large"
    assert rf.instances == []
    assert ledger() is None


def test_oversized_streamed_body_rejected_while_streaming(rf, shared):
    # No Content-Length (chunked): the middleware counts the streamed bytes.
    sent = {"n": 0}

    def chunks():
        boundary = b"--b0undary"
        yield boundary + b'\r\nContent-Disposition: form-data; name="file"; filename="t.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'
        for _ in range(40):
            sent["n"] += 1
            yield b"\0" * (1024 * 1024)
        yield b"\r\n" + boundary + b"--\r\n"

    r = client.post(
        "/api/analyze?depth=false",
        content=chunks(),
        headers={"Content-Type": "multipart/form-data; boundary=b0undary"},
    )
    assert r.status_code == 413
    assert r.json()["detail"]["code"] == "too_large"
    assert rf.instances == []


def test_local_provider_never_caches_a_user_key_model(monkeypatch):
    import sys
    import types

    from sunvision_cv import providers

    loaded = []
    fake = types.ModuleType("inference")
    fake.get_model = lambda model_id, api_key: loaded.append(api_key) or object()
    monkeypatch.setitem(sys.modules, "inference", fake)
    monkeypatch.setattr(providers.RoboflowLocalProvider, "_cache", {})
    monkeypatch.setenv("ROBOFLOW_API_KEY", SHARED_KEY)
    user = providers.get_provider("local", api_key=USER_KEY, key_source="user")
    m1 = user._model()
    assert providers.RoboflowLocalProvider._cache == {}
    shared_prov = providers.get_provider("local")
    m2 = shared_prov._model()
    assert m2 is not m1 and loaded == [USER_KEY, SHARED_KEY]
    # a later user-key request does not get the shared-key model either
    m3 = providers.get_provider("local", api_key=USER_KEY, key_source="user")._model()
    assert m3 is not m2 and loaded == [USER_KEY, SHARED_KEY, USER_KEY]
