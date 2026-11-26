import io

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

from sunvision_cv import app as app_module
from sunvision_cv.analysis import build_analysis
from sunvision_cv.depth import DepthResult, encode_depth
from sunvision_cv.images import prepare_upload
from sunvision_cv.providers import MissingApiKeyError, ReplayProvider, RoboflowHostedProvider


def test_replay_end_to_end(thumb_raw, tmp_path):
    p = tmp_path / "raw.json"
    import json

    p.write_text(json.dumps(thumb_raw))
    result = ReplayProvider(p).infer()
    yy, xx = np.mgrid[0:200, 0:200]
    fake_depth = DepthResult((yy / 200.0).astype(np.float32), "relative-inverse", "synthetic", "test", 1.0)
    analysis, enc = build_analysis(result, depth_result=fake_depth)
    assert analysis["imageWidth"] == 200 and analysis["model"]["modelId"] == "building-facade-segmentation-instance/4"
    assert analysis["model"]["license"] == "CC BY 4.0"
    assert analysis["primaryFacadeId"] == "ccbffceb-ba0d-40d6-94c1-d5b87ee51c55"
    assert len(analysis["floorRows"]) >= 3
    assert analysis["roofline"] and analysis["groundline"]
    assert analysis["depth"]["binUrl"] == "depth16.bin" and analysis["depth"]["bits"] == 16
    assert all("depthMedian" in d for d in analysis["detections"])
    assert len(enc["bin"]) == enc["width"] * enc["height"] * 2


def test_no_features_warning(tmp_path):
    import json

    p = tmp_path / "raw.json"
    p.write_text(json.dumps({"image": {"width": 50, "height": 50}, "predictions": []}))
    analysis, _ = build_analysis(ReplayProvider(p).infer())
    assert any("manual annotation" in w for w in analysis["warnings"])
    assert analysis["floorRows"] == []


def test_encode_depth_roundtrip():
    d = np.linspace(2.0, 7.0, 64 * 32, dtype=np.float32).reshape(32, 64)
    enc = encode_depth(d)
    q = np.frombuffer(enc["bin"], dtype="<u2").reshape(32, 64)
    back = enc["rawMin"] + q / 65535.0 * (enc["rawMax"] - enc["rawMin"])
    assert np.max(np.abs(back - d)) < 1e-3


def test_prepare_strips_exif_and_downscales():
    img = Image.new("RGB", (3000, 1000), (120, 130, 140))
    exif = Image.Exif()
    exif[0x0112] = 1
    buf = io.BytesIO()
    img.save(buf, "JPEG", exif=exif.tobytes())
    prep = prepare_upload(buf.getvalue())
    assert prep.rgb.shape[1] == 2048 and prep.original_width == 3000
    assert abs(prep.scale - 2048 / 3000) < 1e-9


def test_hosted_without_key_raises(monkeypatch):
    monkeypatch.delenv("ROBOFLOW_API_KEY", raising=False)
    try:
        RoboflowHostedProvider(api_key=None).infer(np.zeros((10, 10, 3), np.uint8))
    except MissingApiKeyError:
        return
    raise AssertionError("expected MissingApiKeyError")


client = TestClient(app_module.app)


def test_health():
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json()["facadeModel"]


def test_rejects_non_image():
    r = client.post("/api/analyze", files={"file": ("x.jpg", b"not an image at all", "image/jpeg")})
    assert r.status_code == 400 and r.json()["detail"]["code"] == "unsupported_type"


def test_rejects_gif():
    buf = io.BytesIO()
    Image.new("RGB", (10, 10)).save(buf, "GIF")
    r = client.post("/api/analyze", files={"file": ("x.gif", buf.getvalue(), "image/gif")})
    assert r.status_code == 400


def test_rejects_oversize():
    r = client.post("/api/analyze", files={"file": ("x.jpg", b"\xff" * (15 * 1024 * 1024 + 10), "image/jpeg")})
    assert r.status_code == 413


def test_missing_key_is_503(monkeypatch, thumb_path):
    monkeypatch.delenv("ROBOFLOW_API_KEY", raising=False)
    r = client.post("/api/analyze?depth=false", files={"file": ("t.jpg", thumb_path.read_bytes(), "image/jpeg")})
    detail = r.json()["detail"]
    assert r.status_code == 503 and detail["code"] == "shared_key_unavailable"
    assert detail["legacyCode"] == "missing_api_key"


def test_analyze_with_stubbed_provider(monkeypatch, thumb_path, thumb_raw):
    from sunvision_cv.providers import ProviderResult

    class Stub:
        def infer(self, image):
            assert image.shape[:2] == (200, 200)
            return ProviderResult(raw=thumb_raw, provider="roboflow-hosted", model_id="building-facade-segmentation-instance/4",
                                  inference_ms=12.0, sent_to_external_service=True, service="https://serverless.roboflow.com")

    monkeypatch.setenv("ROBOFLOW_API_KEY", "shared-test-key")
    monkeypatch.setattr(app_module, "get_provider", lambda name, confidence=0.3, **kw: Stub())
    r = client.post("/api/analyze?depth=false", files={"file": ("t.jpg", thumb_path.read_bytes(), "image/jpeg")})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["privacy"]["sentToExternalService"] is True and body["privacy"]["exifStripped"] is True
    assert body["classCounts"]["window"] >= 5
