"""Shared Roboflow key allowance (docs/research/byok.md §5.2).

The server's own ``ROBOFLOW_API_KEY`` runs on Roboflow's free plan, so its use
is capped per calendar month (UTC) and per client per day. Requests made with a
user's own key (``X-Roboflow-Key``) are never counted here.

Ledger: one JSON object at ``SUNVISION_QUOTA_FILE`` (default
``api/.quota/roboflow.json``, gitignored), rewritten atomically (temp file +
``os.replace``) while holding ``fcntl.flock`` on a sidecar ``.lock`` file, so
several uvicorn workers stay consistent.

Counting rules (Roboflow's "Failed requests" pricing): a success and any
401/403/404 use credits and count; 402, 408, 409, 423, 429 and 5xx do not.
Other statuses count (conservative: never under-count). A 402 on the shared key
marks it exhausted until the month rolls over.

Client IPs are never stored in clear: only ``sha256(salt + ip)[:16]`` for
today. This is pseudonymisation, not anonymisation: the IPv4 space is small, so
whoever holds both a hash and its salt can recover the IP by brute force. The
salt is therefore never written into the ledger. It is ``SUNVISION_QUOTA_SALT``
when set (recommended for deploys); otherwise a random salt kept in a separate
0600 sidecar file (``<ledger>.salt``) and replaced every UTC day, so a leaked
salt exposes at most that day's per-client hashes.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import math
import os
import secrets
import tempfile
import threading
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterator

try:  # POSIX only; on other platforms the in-process lock is all we have
    import fcntl
except ImportError:  # pragma: no cover
    fcntl = None  # type: ignore[assignment]

log = logging.getLogger("sunvision.quota")

DEFAULT_MONTHLY_CAP = 2000
DEFAULT_DAILY_PER_CLIENT = 5
RESERVATION_TTL_S = 600.0
NOT_CHARGED_STATUSES = frozenset({402, 408, 409, 423, 429})
API_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = API_DIR.parent
DEFAULT_QUOTA_FILE = API_DIR / ".quota" / "roboflow.json"

_THREAD_LOCK = threading.Lock()


def counts_against_quota(status: int | None) -> bool:
    """Whether a Roboflow response with this HTTP status uses credits.

    ``None`` means no response was received (connection failure): not counted.
    """
    if status is None:
        return False
    if status >= 500 or status in NOT_CHARGED_STATUSES:
        return False
    return True


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return max(0, int(raw))
    except ValueError:
        log.warning("%s is not an integer; using %d", name, default)
        return default


def quota_file_from_env() -> Path:
    raw = os.environ.get("SUNVISION_QUOTA_FILE", "").strip()
    if not raw:
        return DEFAULT_QUOTA_FILE
    p = Path(raw).expanduser()
    return p if p.is_absolute() else REPO_ROOT / p


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def period_of(now: datetime) -> str:
    return now.strftime("%Y-%m")


def next_month_start(now: datetime) -> datetime:
    if now.month == 12:
        return datetime(now.year + 1, 1, 1, tzinfo=timezone.utc)
    return datetime(now.year, now.month + 1, 1, tzinfo=timezone.utc)


def iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def seconds_to_utc_midnight(now: datetime) -> int:
    tomorrow = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return max(1, math.ceil((tomorrow - now).total_seconds()))


class QuotaLedgerError(RuntimeError):
    """The ledger file exists but cannot be read. We fail closed."""


class QuotaDenied(Exception):
    """The shared key may not be used for this request.

    reason: ``disabled`` (cap 0), ``exhausted`` (our cap reached),
    ``provider_exhausted`` (Roboflow answered 402 this month),
    ``client_daily`` (per-client daily limit) or ``ledger`` (unreadable file).
    """

    def __init__(self, reason: str, *, cap: int, used: int, resets_at: str, retry_after: int | None = None):
        super().__init__(reason)
        self.reason = reason
        self.cap = cap
        self.used = used
        self.resets_at = resets_at
        self.retry_after = retry_after


@dataclass
class Reservation:
    id: str
    period: str
    day: str
    client: str | None
    settled: bool = field(default=False, repr=False)


class QuotaStore:
    def __init__(
        self,
        path: str | Path | None = None,
        *,
        monthly_cap: int | None = None,
        daily_per_client: int | None = None,
        salt: str | None = None,
        now: Callable[[], datetime] = utcnow,
        reservation_ttl_s: float = RESERVATION_TTL_S,
    ) -> None:
        self.path = Path(path) if path is not None else quota_file_from_env()
        self.cap = (
            monthly_cap
            if monthly_cap is not None
            else _env_int("SUNVISION_SHARED_MONTHLY_IMAGE_CAP", DEFAULT_MONTHLY_CAP)
        )
        self.daily_per_client = (
            daily_per_client
            if daily_per_client is not None
            else _env_int("SUNVISION_SHARED_DAILY_PER_CLIENT", DEFAULT_DAILY_PER_CLIENT)
        )
        self._salt = salt if salt is not None else (os.environ.get("SUNVISION_QUOTA_SALT", "").strip() or None)
        self.now = now
        self.reservation_ttl_s = reservation_ttl_s

    @classmethod
    def from_env(cls) -> "QuotaStore":
        return cls()

    @property
    def enabled(self) -> bool:
        return self.cap > 0

    # ------------------------------------------------------------------ ledger
    def _fresh(self, now: datetime) -> dict[str, Any]:
        return {
            "period": period_of(now),
            "cap": self.cap,
            "used": 0,
            "reserved": 0,
            "exhaustedByProvider": False,
            "exhaustedAt": None,
            "lastProviderStatus": None,
            "perClient": {},
            "reservations": {},
        }

    def _read(self) -> dict[str, Any] | None:
        try:
            text = self.path.read_text()
        except FileNotFoundError:
            return None
        except OSError as exc:
            raise QuotaLedgerError(f"cannot read quota ledger: {exc.__class__.__name__}") from exc
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise QuotaLedgerError("quota ledger is not valid JSON") from exc
        if not isinstance(data, dict) or not isinstance(data.get("used"), int) or not isinstance(data.get("period"), str):
            raise QuotaLedgerError("quota ledger has an unexpected shape")
        data.setdefault("reserved", 0)
        data.setdefault("exhaustedByProvider", False)
        data.setdefault("exhaustedAt", None)
        data.setdefault("lastProviderStatus", None)
        if not isinstance(data.get("perClient"), dict):
            data["perClient"] = {}
        if not isinstance(data.get("reservations"), dict):
            data["reservations"] = {}
        return data

    def _write(self, state: dict[str, Any]) -> None:
        self._write_json(self.path, state)

    @staticmethod
    def _write_json(path: Path, state: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as fh:
                json.dump(state, fh, indent=2, sort_keys=True)
                fh.write("\n")
                fh.flush()
                os.fsync(fh.fileno())
            os.chmod(tmp, 0o600)
            os.replace(tmp, path)
        except BaseException:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(tmp)
            raise

    @contextlib.contextmanager
    def _locked(self) -> Iterator[None]:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with _THREAD_LOCK:
            lock_path = self.path.with_name(self.path.name + ".lock")
            fh = open(lock_path, "a+")
            try:
                if fcntl is not None:
                    fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
                yield
            finally:
                if fcntl is not None:
                    fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
                fh.close()

    def _normalise(self, state: dict[str, Any] | None, now: datetime) -> dict[str, Any]:
        """Apply month rollover, today's per-client window and reservation expiry."""
        period = period_of(now)
        if state is None:
            state = self._fresh(now)
        elif state.get("period") != period:
            log.info("shared quota period rolled over to %s", period)
            state = self._fresh(now)
        # A salt never sits next to the hashes: a top-level "salt" key is dropped on the next write.
        state.pop("salt", None)
        state["cap"] = self.cap
        today = now.strftime("%Y-%m-%d")
        state["perClient"] = {today: dict(state["perClient"].get(today, {}))}
        cutoff = now.timestamp() - self.reservation_ttl_s
        for rid, r in list(state["reservations"].items()):
            if not isinstance(r, dict) or float(r.get("at", 0)) < cutoff:
                state["reservations"].pop(rid, None)
                self._refund_client(state, r if isinstance(r, dict) else {})
        state["reserved"] = len(state["reservations"])
        return state

    @staticmethod
    def _refund_client(state: dict[str, Any], r: dict[str, Any]) -> None:
        day, client = r.get("day"), r.get("client")
        bucket = state["perClient"].get(day) if day else None
        if bucket is not None and client in bucket:
            bucket[client] = max(0, int(bucket[client]) - 1)
            if bucket[client] == 0:
                del bucket[client]

    def _daily_salt(self, day: str) -> str:
        """The salt for `day`: SUNVISION_QUOTA_SALT, else the sidecar file's (rotated daily). Caller holds the lock."""
        if self._salt:
            return self._salt
        path = self.path.with_name(self.path.name + ".salt")
        try:
            data = json.loads(path.read_text())
            if isinstance(data, dict) and data.get("day") == day and isinstance(data.get("salt"), str) and data["salt"]:
                return data["salt"]
        except (OSError, json.JSONDecodeError):
            pass
        salt = secrets.token_hex(16)
        self._write_json(path, {"day": day, "salt": salt})
        return salt

    def _client_hash(self, client_ip: str | None, day: str) -> str | None:
        if not client_ip:
            return None
        salt = self._daily_salt(day)
        return hashlib.sha256(f"{salt}:{client_ip}".encode()).hexdigest()[:16]

    # ------------------------------------------------------------------ API
    def status(self, shared_key_configured: bool = True) -> dict[str, Any]:
        """The `/api/health` `sharedQuota` block. Read-only: never creates, locks or writes the ledger."""
        if not shared_key_configured or not self.enabled:
            return {"enabled": False, "remaining": None, "cap": None, "resetsAt": None, "exhausted": False}
        now = self.now()
        resets_at = iso_z(next_month_start(now))
        try:
            # os.replace makes every write atomic, so a lock-free read sees a whole ledger.
            state = self._normalise(self._read(), now)
        except QuotaLedgerError:
            log.error("quota ledger unreadable; shared key disabled until it is fixed (%s)", self.path.name)
            return {"enabled": False, "remaining": None, "cap": self.cap, "resetsAt": resets_at, "exhausted": False}
        exhausted = bool(state["exhaustedByProvider"]) or state["used"] >= self.cap
        remaining = 0 if exhausted else max(0, self.cap - state["used"] - state["reserved"])
        return {
            "enabled": True,
            "remaining": remaining,
            "cap": self.cap,
            "resetsAt": resets_at,
            "exhausted": exhausted,
        }

    def snapshot(self) -> dict[str, Any]:
        """Current counters, for error details (`cap`, `used`, `resetsAt`)."""
        now = self.now()
        try:
            used = self._normalise(self._read(), now)["used"]
        except QuotaLedgerError:
            used = None
        return {"cap": self.cap, "used": used, "resetsAt": iso_z(next_month_start(now))}

    def reserve(self, client_ip: str | None) -> Reservation:
        """Claim one shared-key analysis, or raise `QuotaDenied`."""
        now = self.now()
        resets_at = iso_z(next_month_start(now))
        if not self.enabled:
            raise QuotaDenied("disabled", cap=0, used=0, resets_at=resets_at)
        with self._locked():
            try:
                state = self._normalise(self._read(), now)
            except QuotaLedgerError as exc:
                log.error("quota ledger unreadable; refusing shared-key use (%s)", exc)
                raise QuotaDenied("ledger", cap=self.cap, used=0, resets_at=resets_at) from exc
            used = int(state["used"])
            if state["exhaustedByProvider"]:
                raise QuotaDenied("provider_exhausted", cap=self.cap, used=used, resets_at=resets_at)
            if used + state["reserved"] >= self.cap:
                raise QuotaDenied("exhausted", cap=self.cap, used=used, resets_at=resets_at)
            today = now.strftime("%Y-%m-%d")
            client = self._client_hash(client_ip, today)
            bucket = state["perClient"][today]
            if client is not None and self.daily_per_client > 0 and bucket.get(client, 0) >= self.daily_per_client:
                raise QuotaDenied(
                    "client_daily",
                    cap=self.cap,
                    used=used,
                    resets_at=resets_at,
                    retry_after=seconds_to_utc_midnight(now),
                )
            rid = uuid.uuid4().hex
            state["reservations"][rid] = {"at": now.timestamp(), "day": today, "client": client}
            state["reserved"] = len(state["reservations"])
            if client is not None:
                bucket[client] = bucket.get(client, 0) + 1
            self._write(state)
        return Reservation(id=rid, period=period_of(now), day=today, client=client)

    def settle(
        self,
        reservation: Reservation,
        *,
        counted: bool,
        provider_status: int | None = None,
        provider_exhausted: bool = False,
    ) -> None:
        """Release a reservation. `counted` adds one to `used` (the request used credits)."""
        if reservation.settled:
            return
        reservation.settled = True
        now = self.now()
        with self._locked():
            try:
                state = self._normalise(self._read(), now)
            except QuotaLedgerError as exc:
                log.error("quota ledger unreadable while settling (%s)", exc)
                return
            same_period = state["period"] == reservation.period
            live = state["reservations"].pop(reservation.id, None)
            state["reserved"] = len(state["reservations"])
            if same_period and counted:
                state["used"] = int(state["used"]) + 1
            if live is not None and not counted:
                self._refund_client(state, live)
            if provider_status is not None:
                state["lastProviderStatus"] = provider_status
            if provider_exhausted and same_period:
                state["exhaustedByProvider"] = True
                state["exhaustedAt"] = iso_z(now)
            self._write(state)

    def mark_provider_exhausted(self, provider_status: int = 402) -> None:
        """Roboflow said the shared workspace is out of credits: refuse until the month rolls over."""
        now = self.now()
        with self._locked():
            state = self._normalise(self._read(), now)
            state["exhaustedByProvider"] = True
            state["exhaustedAt"] = iso_z(now)
            state["lastProviderStatus"] = provider_status
            self._write(state)

