"""Shared-key allowance ledger (sunvision_cv/quota.py, byok.md §5.2)."""
import json
import threading
from datetime import datetime, timezone

import pytest

from sunvision_cv.quota import QuotaDenied, QuotaStore, counts_against_quota


class Clock:
    def __init__(self, dt):
        self.dt = dt

    def __call__(self):
        return self.dt


def utc(*a):
    return datetime(*a, tzinfo=timezone.utc)


@pytest.fixture
def clock():
    return Clock(utc(2026, 11, 25, 10, 0, 0))


def make(tmp_path, clock, cap=3, daily=0, **kw):
    return QuotaStore(tmp_path / "q" / "roboflow.json", monthly_cap=cap, daily_per_client=daily, now=clock, **kw)


def ledger(store):
    return json.loads(store.path.read_text())


@pytest.mark.parametrize(
    "status,counted",
    [(200, True), (401, True), (403, True), (404, True), (400, True),
     (402, False), (408, False), (409, False), (423, False), (429, False),
     (500, False), (502, False), (503, False), (504, False), (None, False)],
)
def test_counts_against_quota(status, counted):
    assert counts_against_quota(status) is counted


def test_success_counts_failure_refunds(tmp_path, clock):
    s = make(tmp_path, clock, cap=3)
    r = s.reserve("1.2.3.4")
    assert ledger(s)["reserved"] == 1 and s.status()["remaining"] == 2
    s.settle(r, counted=True, provider_status=200)
    st = ledger(s)
    assert st["used"] == 1 and st["reserved"] == 0 and st["lastProviderStatus"] == 200
    r = s.reserve("1.2.3.4")
    s.settle(r, counted=False, provider_status=503)
    assert ledger(s)["used"] == 1 and s.status()["remaining"] == 2
    s.settle(r, counted=True)  # double settle is a no-op
    assert ledger(s)["used"] == 1


def test_cap_reached(tmp_path, clock):
    s = make(tmp_path, clock, cap=2)
    for _ in range(2):
        s.settle(s.reserve(None), counted=True)
    with pytest.raises(QuotaDenied) as e:
        s.reserve(None)
    assert e.value.reason == "exhausted" and e.value.cap == 2 and e.value.used == 2
    assert e.value.resets_at == "2026-12-01T00:00:00Z"
    assert s.status() == {"enabled": True, "remaining": 0, "cap": 2, "resetsAt": "2026-12-01T00:00:00Z", "exhausted": True}


def test_in_flight_reservations_hold_the_cap(tmp_path, clock):
    s = make(tmp_path, clock, cap=1)
    s.reserve(None)
    with pytest.raises(QuotaDenied):
        s.reserve(None)


def test_month_rollover_resets_usage_and_provider_exhaustion(tmp_path, clock):
    s = make(tmp_path, clock, cap=2)
    s.settle(s.reserve(None), counted=True)
    s.settle(s.reserve(None), counted=False, provider_status=402, provider_exhausted=True)
    st = ledger(s)
    assert st["exhaustedByProvider"] is True and st["exhaustedAt"] == "2026-11-25T10:00:00Z" and st["used"] == 1
    with pytest.raises(QuotaDenied) as e:
        s.reserve(None)
    assert e.value.reason == "provider_exhausted"
    assert s.status()["exhausted"] is True and s.status()["remaining"] == 0

    clock.dt = utc(2026, 11, 30, 23, 59, 59)
    with pytest.raises(QuotaDenied):
        s.reserve(None)

    clock.dt = utc(2026, 12, 1, 0, 0, 1)
    assert s.status() == {"enabled": True, "remaining": 2, "cap": 2, "resetsAt": "2027-01-01T00:00:00Z", "exhausted": False}
    s.settle(s.reserve(None), counted=True)
    st = ledger(s)
    assert st["period"] == "2026-12" and st["used"] == 1 and st["exhaustedByProvider"] is False


def test_settle_after_rollover_does_not_count_into_new_month(tmp_path, clock):
    s = make(tmp_path, clock, cap=5)
    r = s.reserve(None)
    clock.dt = utc(2026, 12, 1, 0, 0, 5)
    s.settle(r, counted=True)
    assert ledger(s)["used"] == 0


def test_per_client_daily_limit(tmp_path, clock):
    s = make(tmp_path, clock, cap=100, daily=2)
    s.settle(s.reserve("10.0.0.1"), counted=True)
    s.settle(s.reserve("10.0.0.1"), counted=True)
    with pytest.raises(QuotaDenied) as e:
        s.reserve("10.0.0.1")
    assert e.value.reason == "client_daily"
    assert e.value.retry_after == 14 * 3600  # 10:00 UTC → midnight
    s.settle(s.reserve("10.0.0.2"), counted=True)  # another client is unaffected

    clock.dt = utc(2026, 11, 26, 0, 0, 0)
    s.settle(s.reserve("10.0.0.1"), counted=True)  # next UTC day
    assert ledger(s)["used"] == 4


def test_uncharged_failures_do_not_use_the_daily_allowance(tmp_path, clock):
    s = make(tmp_path, clock, cap=100, daily=1)
    s.settle(s.reserve("10.0.0.1"), counted=False, provider_status=429)
    s.settle(s.reserve("10.0.0.1"), counted=True)
    with pytest.raises(QuotaDenied):
        s.reserve("10.0.0.1")


def test_ledger_stores_no_raw_ip_and_no_temp_files(tmp_path, clock):
    s = make(tmp_path, clock, cap=10, daily=5)
    s.settle(s.reserve("203.0.113.77"), counted=True)
    text = s.path.read_text()
    assert "203.0.113.77" not in text
    st = json.loads(text)
    assert list(st["perClient"]) == ["2026-11-25"]
    (h, n), = st["perClient"]["2026-11-25"].items()
    assert len(h) == 16 and n == 1
    leftovers = [p.name for p in s.path.parent.iterdir() if p.name.endswith(".tmp")]
    assert leftovers == []


def test_old_days_are_pruned(tmp_path, clock):
    s = make(tmp_path, clock, cap=10, daily=5)
    s.settle(s.reserve("a"), counted=True)
    clock.dt = utc(2026, 11, 27, 9, 0, 0)
    s.settle(s.reserve("a"), counted=True)
    assert list(ledger(s)["perClient"]) == ["2026-11-27"]


def test_cap_zero_disables(tmp_path, clock):
    s = make(tmp_path, clock, cap=0)
    with pytest.raises(QuotaDenied) as e:
        s.reserve(None)
    assert e.value.reason == "disabled"
    assert s.status()["enabled"] is False
    assert not s.path.exists()


def test_status_without_shared_key(tmp_path, clock):
    s = make(tmp_path, clock, cap=10)
    assert s.status(shared_key_configured=False) == {
        "enabled": False, "remaining": None, "cap": None, "resetsAt": None, "exhausted": False,
    }


def test_status_is_read_only(tmp_path, clock):
    s = make(tmp_path, clock, cap=10)
    assert s.status()["remaining"] == 10
    assert not s.path.parent.exists()


def test_stale_reservation_expires(tmp_path, clock):
    s = make(tmp_path, clock, cap=1, daily=1, reservation_ttl_s=60)
    s.reserve("c")  # never settled (crashed worker)
    with pytest.raises(QuotaDenied):
        s.reserve("c")
    clock.dt = utc(2026, 11, 25, 10, 1, 1)
    s.settle(s.reserve("c"), counted=True)
    assert ledger(s)["used"] == 1


def test_corrupt_ledger_fails_closed(tmp_path, clock):
    s = make(tmp_path, clock, cap=10)
    s.path.parent.mkdir(parents=True)
    s.path.write_text("{not json")
    with pytest.raises(QuotaDenied) as e:
        s.reserve(None)
    assert e.value.reason == "ledger"
    assert s.status()["enabled"] is False
    assert s.path.read_text() == "{not json"


def test_env_configuration(monkeypatch, tmp_path):
    monkeypatch.setenv("SUNVISION_SHARED_MONTHLY_IMAGE_CAP", "7")
    monkeypatch.setenv("SUNVISION_SHARED_DAILY_PER_CLIENT", "3")
    monkeypatch.setenv("SUNVISION_QUOTA_FILE", str(tmp_path / "x.json"))
    s = QuotaStore.from_env()
    assert (s.cap, s.daily_per_client, s.path) == (7, 3, tmp_path / "x.json")
    monkeypatch.delenv("SUNVISION_SHARED_MONTHLY_IMAGE_CAP")
    monkeypatch.delenv("SUNVISION_SHARED_DAILY_PER_CLIENT")
    s = QuotaStore.from_env()
    assert (s.cap, s.daily_per_client) == (2000, 5)


def test_concurrent_reservations_never_exceed_cap(tmp_path, clock):
    s = make(tmp_path, clock, cap=20)
    ok, denied = [], []

    def worker():
        try:
            r = s.reserve(None)
        except QuotaDenied:
            denied.append(1)
            return
        s.settle(r, counted=True)
        ok.append(1)

    threads = [threading.Thread(target=worker) for _ in range(40)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(ok) == 20 and len(denied) == 20 and ledger(s)["used"] == 20


def test_salt_is_not_stored_in_the_ledger_and_rotates_daily(tmp_path, clock, monkeypatch):
    monkeypatch.delenv("SUNVISION_QUOTA_SALT", raising=False)
    s = make(tmp_path, clock, cap=10, daily=5)
    s.settle(s.reserve("203.0.113.77"), counted=True)
    st = json.loads(s.path.read_text())
    assert "salt" not in st
    salt_file = s.path.with_name(s.path.name + ".salt")
    first = json.loads(salt_file.read_text())
    assert first["day"] == "2026-11-25" and first["salt"] not in s.path.read_text()
    assert oct(salt_file.stat().st_mode & 0o777) == "0o600"
    (h1,), = [list(st["perClient"]["2026-11-25"])]
    clock.dt = utc(2026, 11, 26, 9, 0, 0)
    s.settle(s.reserve("203.0.113.77"), counted=True)
    second = json.loads(salt_file.read_text())
    assert second["day"] == "2026-11-26" and second["salt"] != first["salt"]
    (h2,), = [list(ledger(s)["perClient"]["2026-11-26"])]
    assert h2 != h1


def test_old_ledger_salt_is_dropped(tmp_path, clock):
    s = make(tmp_path, clock, cap=10, daily=5)
    s.path.parent.mkdir(parents=True, exist_ok=True)
    s.path.write_text(json.dumps({"period": "2026-11", "used": 0, "salt": "oldsalt", "perClient": {}, "reservations": {}}))
    s.settle(s.reserve("a"), counted=True)
    assert "salt" not in ledger(s)
