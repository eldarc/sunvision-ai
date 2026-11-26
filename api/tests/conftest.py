import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
FIX = Path(__file__).parent / "fixtures"


@pytest.fixture
def thumb_raw():
    return json.loads((FIX / "thumb_response.json").read_text())


@pytest.fixture
def thumb_path():
    return FIX / "thumb.jpg"


def grid_windows(rows, cols, *, x0=100, y0=100, dx=80, dy=110, w=40, h=60, slope=0.0, drop=(), jitter=0.0, seed=0):
    """Synthetic window grid. Row 0 is the TOP row in image space."""
    import numpy as np

    rng = np.random.default_rng(seed)
    out = []
    for r in range(rows):
        for c in range(cols):
            if (r, c) in drop:
                continue
            cx = x0 + c * dx + rng.normal(0, jitter)
            cy = y0 + r * dy + slope * (cx - x0) + rng.normal(0, jitter)
            out.append({"id": f"r{r}c{c}", "cls": "window", "confidence": 0.9,
                        "bbox": [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], "source": "model"})
    return out


_ISOLATED_ENV = (
    "ROBOFLOW_API_KEY",
    "SUNVISION_SHARED_MONTHLY_IMAGE_CAP",
    "SUNVISION_SHARED_DAILY_PER_CLIENT",
    "SUNVISION_QUOTA_SALT",
    "SUNVISION_TRUST_PROXY",
)


@pytest.fixture(autouse=True)
def _isolate_keys_and_network(monkeypatch, tmp_path):
    """Every test gets its own quota ledger, no real Roboflow key and no network.

    `sunvision_cv.app` loads the gitignored .env on import, so the real key is
    removed from the environment here; tests that need a shared key set a fake one.
    """
    for name in _ISOLATED_ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("SUNVISION_QUOTA_FILE", str(tmp_path / "quota" / "roboflow.json"))
    import inference_sdk

    class _NoNetwork:
        def __init__(self, *a, **k):
            raise AssertionError("tests must not create a real InferenceHTTPClient")

    monkeypatch.setattr(inference_sdk, "InferenceHTTPClient", _NoNetwork)
