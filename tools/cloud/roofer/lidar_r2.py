# Vendored UNCHANGED (below this header) from dk-building-data: /Users/martincollignon/conductor/workspaces/dk-building-data/minnetonka-v3/scripts/reconstruction_annotations/lidar_r2.py
# branch mc/skraafoto-splat-research, base commit dabbd1179e080290e48c313034515614c43766eb (the file is untracked there, not yet on main);
# sha256 of the original: 3774a13e8c96113ea148bd388a701882c05d55031161dcf11437edcc1dade1b4. Re-vendor from main once it lands; do not edit here.
#!/usr/bin/env python3
"""Fetch and publish immutable, SHA-256 verified LiDAR tiles in Cloudflare R2.

The index is write-once per dataset/release/tile. LAZ bytes use a content-addressed
object key, so a conflicting release cannot silently replace a tile pointer.
This module never falls back to the upstream service; the acquisition caller
decides whether a missing index should trigger its local LiDAR downloader.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import sys
import tempfile
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import urlsplit, urlunsplit

if __package__:
    from .r2_credentials import R2CredentialError, load_r2_credentials
else:
    from r2_credentials import R2CredentialError, load_r2_credentials


SCHEMA_VERSION = "lidar-r2-tile/v1"
INDEX_PREFIX = "lidar/v1/index"
OBJECT_PREFIX = "lidar/v1/tiles"
UNKNOWN_RELEASE = "source-version-unknown"
DEFAULT_DATASET = "punktsky"
DEFAULT_ACCOUNT_ID = "691682f9ad7a2e6378c27998ceffaaf9"
DEFAULT_BUCKET = "dk-lidar-cache"
DEFAULT_TIMEOUT_SECONDS = 1800
MAX_TIMEOUT_SECONDS = 3600
DEFAULT_MAX_TILE_BYTES = 512 * 1024 * 1024
MAX_TILE_BYTES = 5 * 1024 * 1024 * 1024
MAX_INDEX_BYTES = 64 * 1024
CHUNK_BYTES = 1024 * 1024
LASF_MAGIC = b"LASF"
ACCOUNT_ID = re.compile(r"^[0-9a-fA-F]{32}$")
SAFE_COMPONENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SAFE_TILE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,150}\.laz$", re.IGNORECASE)
SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")
SENSITIVE_PROVENANCE_KEY = re.compile(r"(?:secret|password|token|credential|authorization|api.?key)", re.IGNORECASE)


class R2TileCacheError(ValueError):
    """An R2 tile index or verified local tile cannot be safely used."""


@dataclass(frozen=True)
class CacheEntry:
    dataset: str
    release: str
    tile: str
    sha256: str
    size_bytes: int
    object_key: str
    index_key: str
    path: Path | None = None
    provenance: dict[str, Any] | None = None


def _clean_component(value: str, field: str) -> str:
    if not isinstance(value, str) or not SAFE_COMPONENT.fullmatch(value) or ".." in value:
        raise R2TileCacheError(f"{field} must be a safe, non-empty path component")
    return value


def _identity(dataset: str, release: str, tile: str) -> tuple[str, str, str]:
    dataset = _clean_component(dataset, "dataset")
    release = _clean_component(release, "release")
    if not isinstance(tile, str) or not SAFE_TILE.fullmatch(tile) or ".." in tile:
        raise R2TileCacheError("tile must be a bare .laz filename without path components")
    return dataset, release, tile


def _keys(dataset: str, release: str, tile: str, digest: str) -> tuple[str, str]:
    if not SHA256_HEX.fullmatch(digest):
        raise R2TileCacheError("tile SHA-256 must be a lowercase 64-character hex digest")
    index_key = f"{INDEX_PREFIX}/{dataset}/{release}/{tile}.json"
    object_key = f"{OBJECT_PREFIX}/{dataset}/{release}/{tile}/{digest}.laz"
    return index_key, object_key


def _timestamp() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _redact_uri(value: str) -> str:
    """Drop URL user information, query parameters, and fragments from provenance."""
    try:
        parsed = urlsplit(value)
    except ValueError:
        return "[redacted-unparseable-uri]"
    if not parsed.scheme or not parsed.netloc:
        return value[:2048]
    hostname = parsed.hostname or ""
    if parsed.port:
        hostname = f"{hostname}:{parsed.port}"
    return urlunsplit((parsed.scheme, hostname, parsed.path, "", ""))


def _sanitize_provenance(value: Any, depth: int = 0) -> Any:
    if depth > 8:
        raise R2TileCacheError("provenance JSON is nested too deeply")
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for raw_key, item in value.items():
            key = str(raw_key)
            if SENSITIVE_PROVENANCE_KEY.search(key):
                continue
            result[key[:128]] = _sanitize_provenance(item, depth + 1)
        return result
    if isinstance(value, list):
        if len(value) > 1000:
            raise R2TileCacheError("provenance JSON has too many array entries")
        return [_sanitize_provenance(item, depth + 1) for item in value]
    if isinstance(value, str):
        return _redact_uri(value) if "://" in value else value[:4096]
    if value is None or isinstance(value, (bool, int, float)):
        return value
    raise R2TileCacheError("provenance JSON may contain only JSON values")


def _canonical_json(value: Any) -> bytes:
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise R2TileCacheError("provenance or tile index is not valid JSON") from exc
    if len(encoded) > MAX_INDEX_BYTES:
        raise R2TileCacheError(f"tile index exceeds {MAX_INDEX_BYTES:,} bytes")
    return encoded


def _error_status(exc: Exception) -> tuple[str, int | None]:
    response = getattr(exc, "response", None)
    if not isinstance(response, dict):
        return "", None
    error = response.get("Error") if isinstance(response.get("Error"), dict) else {}
    metadata = response.get("ResponseMetadata") if isinstance(response.get("ResponseMetadata"), dict) else {}
    status = metadata.get("HTTPStatusCode")
    return str(error.get("Code", "")), status if isinstance(status, int) else None


def _is_missing(exc: Exception) -> bool:
    code, status = _error_status(exc)
    return status == 404 or code in {"404", "NoSuchKey", "NotFound", "NoSuchBucket"}


def _is_precondition_conflict(exc: Exception) -> bool:
    code, status = _error_status(exc)
    return status in {409, 412} or code in {"ConditionalRequestConflict", "PreconditionFailed"}


def _sha256_file(path: Path, max_bytes: int) -> tuple[str, int]:
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise R2TileCacheError(f"cannot stat local LAZ file: {path}") from exc
    if not path.is_file() or size < len(LASF_MAGIC):
        raise R2TileCacheError(f"local LAZ file is missing or too small: {path}")
    if size > max_bytes:
        raise R2TileCacheError(f"local LAZ file exceeds the {max_bytes:,}-byte limit")
    digest = hashlib.sha256()
    try:
        with path.open("rb") as stream:
            if stream.read(4) != LASF_MAGIC:
                raise R2TileCacheError(f"local file is not a LAS/LAZ tile (missing LASF magic): {path}")
            stream.seek(0)
            for chunk in iter(lambda: stream.read(CHUNK_BYTES), b""):
                digest.update(chunk)
    except OSError as exc:
        raise R2TileCacheError(f"cannot read local LAZ file: {path}") from exc
    return digest.hexdigest(), size


def _atomic_write_no_replace(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(temp_name)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        try:
            # A same-filesystem hard link publishes atomically without replacing
            # an existing cache record, even when two fetches race.
            os.link(temporary, path)
        except FileExistsError:
            existing = path.read_bytes()
            if existing != data:
                raise R2TileCacheError(f"refusing to replace conflicting local cache file: {path}")
        temporary.unlink(missing_ok=True)
        try:
            directory_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except OSError:
            pass
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def _atomic_install_no_replace(temporary: Path, path: Path, expected_sha256: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        os.link(temporary, path)
    except FileExistsError:
        existing_hash, _ = _sha256_file(path, MAX_TILE_BYTES)
        if existing_hash != expected_sha256:
            raise R2TileCacheError(f"refusing to replace conflicting local LAZ cache file: {path}")
    else:
        try:
            directory_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        except OSError:
            pass
    finally:
        temporary.unlink(missing_ok=True)


def _file_content_md5(path: Path) -> str:
    digest = hashlib.md5(usedforsecurity=False)
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(CHUNK_BYTES), b""):
            digest.update(chunk)
    return base64.b64encode(digest.digest()).decode("ascii")


class R2TileCache:
    """R2 client with immutable tile objects and per-tile write-once indices."""

    def __init__(
        self,
        *,
        bucket: str,
        client: Any,
        timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
        max_tile_bytes: int = DEFAULT_MAX_TILE_BYTES,
    ) -> None:
        if not isinstance(bucket, str) or not SAFE_COMPONENT.fullmatch(bucket) or ".." in bucket:
            raise R2TileCacheError("R2 bucket name is missing or invalid")
        if not 1 <= timeout_seconds <= MAX_TIMEOUT_SECONDS:
            raise R2TileCacheError(f"timeout must be between 1 and {MAX_TIMEOUT_SECONDS} seconds")
        if not 4 <= max_tile_bytes <= MAX_TILE_BYTES:
            raise R2TileCacheError(f"max tile size must be between 4 and {MAX_TILE_BYTES:,} bytes")
        self.bucket = bucket
        self.client = client
        self.timeout_seconds = timeout_seconds
        self.max_tile_bytes = max_tile_bytes
        self._preflight_complete = False

    @classmethod
    def from_env(
        cls,
        *,
        timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
        max_tile_bytes: int = DEFAULT_MAX_TILE_BYTES,
    ) -> "R2TileCache":
        account_id = os.environ.get("R2_ACCOUNT_ID", "").strip()
        bucket = os.environ.get("R2_LIDAR_BUCKET", "").strip()
        missing = [
            name
            for name, value in (
                ("R2_ACCOUNT_ID", account_id),
                ("R2_LIDAR_BUCKET", bucket),
            )
            if not value
        ]
        if missing:
            raise R2TileCacheError("missing required R2 environment variable(s): " + ", ".join(missing))
        if not ACCOUNT_ID.fullmatch(account_id):
            raise R2TileCacheError("R2_ACCOUNT_ID must be a 32-character hexadecimal account ID")
        try:
            access_key, secret_key = load_r2_credentials()
        except R2CredentialError as exc:
            raise R2TileCacheError(str(exc)) from None
        try:
            import boto3
            from botocore.config import Config
        except ImportError as exc:
            raise R2TileCacheError("R2 access requires boto3; install scripts/reconstruction_annotations/requirements.txt") from exc
        client = boto3.client(
            "s3",
            endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name="auto",
            config=Config(
                connect_timeout=min(15, timeout_seconds),
                read_timeout=timeout_seconds,
                request_checksum_calculation="when_required",
                retries={"max_attempts": 2, "mode": "standard"},
                s3={"addressing_style": "path"},
            ),
        )
        return cls(
            bucket=bucket,
            client=client,
            timeout_seconds=timeout_seconds,
            max_tile_bytes=max_tile_bytes,
        )

    def preflight(self) -> None:
        """Fail before a slow upstream download when the configured bucket is inaccessible."""
        if self._preflight_complete:
            return
        try:
            self.client.head_bucket(Bucket=self.bucket)
        except Exception as exc:
            code, status = _error_status(exc)
            detail = f"HTTP {status}" if status else code or type(exc).__name__
            raise R2TileCacheError(f"R2 bucket preflight failed ({detail}); refusing upstream LiDAR fallback") from None
        self._preflight_complete = True

    def local_path(self, cache_dir: Path, dataset: str, release: str, tile: str) -> Path:
        dataset, release, tile = _identity(dataset, release, tile)
        return cache_dir.expanduser().resolve() / dataset / release / tile

    def fetch_tile(
        self,
        *,
        dataset: str,
        release: str,
        tile: str,
        cache_dir: Path,
    ) -> CacheEntry | None:
        dataset, release, tile = _identity(dataset, release, tile)
        self.preflight()
        cache_path = self.local_path(cache_dir, dataset, release, tile)
        sidecar_path = cache_path.with_name(cache_path.name + ".json")
        if cache_path.exists() or sidecar_path.exists():
            return self._verify_local_entry(cache_path, sidecar_path, dataset, release, tile)

        try:
            response = self.client.get_object(Bucket=self.bucket, Key=f"{INDEX_PREFIX}/{dataset}/{release}/{tile}.json")
        except Exception as exc:
            if _is_missing(exc):
                return None
            code, status = _error_status(exc)
            detail = f"HTTP {status}" if status else code or type(exc).__name__
            raise R2TileCacheError(f"R2 tile index read failed ({detail})") from None
        try:
            body = response.get("Body")
            if body is None:
                raise R2TileCacheError("R2 tile index response has no body")
            raw = body.read(MAX_INDEX_BYTES + 1)
            if len(raw) > MAX_INDEX_BYTES:
                raise R2TileCacheError("R2 tile index exceeds the configured 64 KiB limit")
        finally:
            body = response.get("Body")
            if body is not None and hasattr(body, "close"):
                body.close()
        try:
            index = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise R2TileCacheError("R2 tile index is not valid UTF-8 JSON") from exc
        entry = self._parse_index(index, dataset, release, tile)
        self._verify_remote_object(entry)
        downloaded = self._download_object(entry, cache_path)
        _atomic_write_no_replace(sidecar_path, _canonical_json(self._index_document(entry)))
        return CacheEntry(**{**asdict(entry), "path": downloaded})

    def publish_tile(
        self,
        local_path: Path,
        *,
        dataset: str,
        release: str = UNKNOWN_RELEASE,
        tile: str | None = None,
        provenance: Mapping[str, Any] | None = None,
    ) -> CacheEntry:
        dataset = _clean_component(dataset, "dataset")
        release = _clean_component(release, "release")
        tile = tile or local_path.name
        dataset, release, tile = _identity(dataset, release, tile)
        source = local_path.expanduser().resolve()
        digest, size = _sha256_file(source, self.max_tile_bytes)
        self.preflight()
        index_key, object_key = _keys(dataset, release, tile, digest)
        existing_index = self._read_optional_index(index_key)
        if existing_index is not None:
            entry = self._parse_index(existing_index, dataset, release, tile, path=source)
            if entry.sha256 != digest or entry.size_bytes != size:
                raise R2TileCacheError("R2 tile index already points to different contents; refusing to overwrite")
            self._verify_remote_object(entry)
            return entry
        clean_provenance = _sanitize_provenance(dict(provenance or {}))
        if not isinstance(clean_provenance, dict):
            raise R2TileCacheError("provenance must be a JSON object")
        clean_provenance.setdefault("source", "verified_local_laz")
        clean_provenance.setdefault("verification", ["LASF_magic", "sha256_stream"])
        clean_provenance.setdefault("retrieved_at", _timestamp())
        document = {
            "schema_version": SCHEMA_VERSION,
            "dataset": dataset,
            "release": release,
            "tile": tile,
            "sha256": digest,
            "size_bytes": size,
            "object_key": object_key,
            "published_at": _timestamp(),
            "provenance": clean_provenance,
        }
        object_metadata = {
            "schema-version": SCHEMA_VERSION,
            "dataset": dataset,
            "release": release,
            "tile": tile,
            "sha256": digest,
        }
        self._put_content_object(source, object_key, digest, size, object_metadata)
        self._put_index(index_key, document, digest)
        return self._parse_index(document, dataset, release, tile, path=source)

    def _parse_index(
        self,
        value: Any,
        dataset: str,
        release: str,
        tile: str,
        *,
        path: Path | None = None,
    ) -> CacheEntry:
        if not isinstance(value, dict) or value.get("schema_version") != SCHEMA_VERSION:
            raise R2TileCacheError("tile index has an unsupported schema")
        if (value.get("dataset"), value.get("release"), value.get("tile")) != (dataset, release, tile):
            raise R2TileCacheError("tile index identity does not match the requested dataset/release/tile")
        digest = value.get("sha256")
        size = value.get("size_bytes")
        if not isinstance(digest, str) or not SHA256_HEX.fullmatch(digest):
            raise R2TileCacheError("tile index contains an invalid SHA-256 digest")
        if isinstance(size, bool) or not isinstance(size, int) or not 4 <= size <= self.max_tile_bytes:
            raise R2TileCacheError("tile index contains an invalid or over-limit size")
        index_key, expected_object_key = _keys(dataset, release, tile, digest)
        if value.get("object_key") != expected_object_key:
            raise R2TileCacheError("tile index content-addressed object key does not match its SHA-256")
        provenance = value.get("provenance")
        if not isinstance(provenance, dict):
            raise R2TileCacheError("tile index provenance must be an object")
        return CacheEntry(
            dataset=dataset,
            release=release,
            tile=tile,
            sha256=digest,
            size_bytes=size,
            object_key=expected_object_key,
            index_key=index_key,
            path=path,
            provenance=provenance,
        )

    def _index_document(self, entry: CacheEntry) -> dict[str, Any]:
        return {
            "schema_version": SCHEMA_VERSION,
            "dataset": entry.dataset,
            "release": entry.release,
            "tile": entry.tile,
            "sha256": entry.sha256,
            "size_bytes": entry.size_bytes,
            "object_key": entry.object_key,
            "published_at": _timestamp(),
            "provenance": entry.provenance or {},
        }

    def _verify_local_entry(
        self,
        path: Path,
        sidecar: Path,
        dataset: str,
        release: str,
        tile: str,
    ) -> CacheEntry:
        if not path.is_file() or not sidecar.is_file():
            raise R2TileCacheError(f"local R2 cache entry is incomplete: {path}")
        try:
            document = json.loads(sidecar.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise R2TileCacheError(f"local R2 cache sidecar is invalid: {sidecar}") from exc
        entry = self._parse_index(document, dataset, release, tile, path=path)
        actual_sha, actual_size = _sha256_file(path, self.max_tile_bytes)
        if actual_sha != entry.sha256 or actual_size != entry.size_bytes:
            raise R2TileCacheError(f"local cached LAZ failed SHA-256/size verification: {path}")
        return entry

    def _verify_remote_object(self, entry: CacheEntry) -> None:
        try:
            head = self.client.head_object(Bucket=self.bucket, Key=entry.object_key)
        except Exception as exc:
            if _is_missing(exc):
                raise R2TileCacheError("tile index points to a missing R2 content object") from None
            code, status = _error_status(exc)
            detail = f"HTTP {status}" if status else code or type(exc).__name__
            raise R2TileCacheError(f"R2 content metadata read failed ({detail})") from None
        metadata = head.get("Metadata") if isinstance(head.get("Metadata"), dict) else {}
        expected_metadata = {
            "sha256": entry.sha256,
            "dataset": entry.dataset,
            "release": entry.release,
            "tile": entry.tile,
            "schema-version": SCHEMA_VERSION,
        }
        normalized_metadata = {str(key).lower(): str(value) for key, value in metadata.items()}
        if any(normalized_metadata.get(key) != value for key, value in expected_metadata.items()):
            raise R2TileCacheError("R2 content object metadata does not match its tile index")
        if head.get("ContentLength") != entry.size_bytes:
            raise R2TileCacheError("R2 content object size does not match its tile index")

    def _download_object(self, entry: CacheEntry, destination: Path) -> Path:
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, temp_name = tempfile.mkstemp(prefix=f".{destination.name}.", suffix=".download", dir=destination.parent)
        temporary = Path(temp_name)
        os.fchmod(fd, 0o600)
        digest = hashlib.sha256()
        total = 0
        prefix = bytearray()
        started = __import__("time").monotonic()
        response: dict[str, Any] | None = None
        try:
            with os.fdopen(fd, "wb") as output:
                try:
                    response = self.client.get_object(Bucket=self.bucket, Key=entry.object_key)
                except Exception as exc:
                    code, status = _error_status(exc)
                    detail = f"HTTP {status}" if status else code or type(exc).__name__
                    raise R2TileCacheError(f"R2 content download failed ({detail})") from None
                body = response.get("Body")
                if body is None:
                    raise R2TileCacheError("R2 content response has no body")
                content_length = response.get("ContentLength")
                if content_length != entry.size_bytes:
                    raise R2TileCacheError("R2 response content length does not match tile index")
                while True:
                    if __import__("time").monotonic() - started > self.timeout_seconds:
                        raise R2TileCacheError(f"R2 download exceeded {self.timeout_seconds} seconds")
                    chunk = body.read(CHUNK_BYTES)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > self.max_tile_bytes or total > entry.size_bytes:
                        raise R2TileCacheError("R2 download exceeded the indexed or configured byte limit")
                    if len(prefix) < len(LASF_MAGIC):
                        prefix.extend(chunk[: len(LASF_MAGIC) - len(prefix)])
                    digest.update(chunk)
                    output.write(chunk)
                if bytes(prefix) != LASF_MAGIC:
                    raise R2TileCacheError("R2 object is not a LAS/LAZ tile (missing LASF magic)")
                output.flush()
                os.fsync(output.fileno())
            actual_sha = digest.hexdigest()
            if actual_sha != entry.sha256 or total != entry.size_bytes:
                raise R2TileCacheError("downloaded R2 tile failed SHA-256/size verification")
            _atomic_install_no_replace(temporary, destination, entry.sha256)
            return destination
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
        finally:
            if response is not None:
                body = response.get("Body")
                if body is not None and hasattr(body, "close"):
                    body.close()

    def _put_content_object(
        self,
        source: Path,
        key: str,
        digest: str,
        size: int,
        metadata: dict[str, str],
    ) -> None:
        try:
            with source.open("rb") as body:
                response = self.client.put_object(
                    Bucket=self.bucket,
                    Key=key,
                    Body=body,
                    ContentLength=size,
                    ContentType="application/vnd.laszip",
                    Metadata=metadata,
                    ContentMD5=_file_content_md5(source),
                    IfNoneMatch="*",
                )
        except Exception as exc:
            if not _is_precondition_conflict(exc):
                code, status = _error_status(exc)
                detail = f"HTTP {status}" if status else code or type(exc).__name__
                raise R2TileCacheError(f"R2 immutable tile upload failed ({detail})") from None
            response = None
        if response is None:
            existing = self._head_existing(key)
            expected = {str(k).lower(): str(v) for k, v in metadata.items()}
            actual = {str(k).lower(): str(v) for k, v in (existing.get("Metadata") or {}).items()}
            if existing.get("ContentLength") != size or any(actual.get(k) != v for k, v in expected.items()):
                raise R2TileCacheError("R2 content-addressed key already exists with conflicting metadata/size")

    def _put_index(self, key: str, document: dict[str, Any], digest: str) -> None:
        body = _canonical_json(document)
        index_digest = hashlib.sha256(body).hexdigest()
        try:
            self.client.put_object(
                Bucket=self.bucket,
                Key=key,
                Body=body,
                ContentLength=len(body),
                ContentType="application/json",
                Metadata={"schema-version": SCHEMA_VERSION, "sha256": index_digest},
                ContentMD5=base64.b64encode(hashlib.md5(body, usedforsecurity=False).digest()).decode("ascii"),
                IfNoneMatch="*",
            )
            return
        except Exception as exc:
            if not _is_precondition_conflict(exc):
                code, status = _error_status(exc)
                detail = f"HTTP {status}" if status else code or type(exc).__name__
                raise R2TileCacheError(f"R2 tile index write failed ({detail})") from None
        existing = self._read_index_object(key)
        if (
            existing.get("dataset"),
            existing.get("release"),
            existing.get("tile"),
            existing.get("sha256"),
        ) != (
            document["dataset"],
            document["release"],
            document["tile"],
            digest,
        ):
            raise R2TileCacheError("R2 tile index already points to different contents; refusing to overwrite")

    def _read_optional_index(self, key: str) -> dict[str, Any] | None:
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=key)
        except Exception as exc:
            if _is_missing(exc):
                return None
            code, status = _error_status(exc)
            detail = f"HTTP {status}" if status else code or type(exc).__name__
            raise R2TileCacheError(f"R2 tile index read failed ({detail})") from None
        body = response.get("Body")
        if body is None:
            raise R2TileCacheError("existing R2 index has no response body")
        try:
            raw = body.read(MAX_INDEX_BYTES + 1)
        finally:
            if hasattr(body, "close"):
                body.close()
        if len(raw) > MAX_INDEX_BYTES:
            raise R2TileCacheError("existing R2 index exceeds the 64 KiB limit")
        try:
            result = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise R2TileCacheError("existing R2 index is invalid JSON") from exc
        if not isinstance(result, dict):
            raise R2TileCacheError("existing R2 index is not a JSON object")
        return result

    def _read_index_object(self, key: str) -> dict[str, Any]:
        result = self._read_optional_index(key)
        if result is None:
            raise R2TileCacheError("could not read existing R2 index (not found)")
        return result

    def _head_existing(self, key: str) -> dict[str, Any]:
        try:
            return self.client.head_object(Bucket=self.bucket, Key=key)
        except Exception as exc:
            code, status = _error_status(exc)
            detail = f"HTTP {status}" if status else code or type(exc).__name__
            raise R2TileCacheError(f"could not verify existing R2 object ({detail})") from None


def _read_provenance(path: Path | None, source_uri: str | None) -> dict[str, Any]:
    result: dict[str, Any] = {}
    if path is not None:
        try:
            value = json.loads(path.expanduser().read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise R2TileCacheError(f"cannot read provenance JSON: {path}") from exc
        if not isinstance(value, dict):
            raise R2TileCacheError("provenance JSON must contain an object")
        result.update(value)
    if source_uri:
        result["source_uri"] = source_uri
    return result


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout-seconds", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument("--max-tile-bytes", type=int, default=DEFAULT_MAX_TILE_BYTES)
    subparsers = parser.add_subparsers(dest="command", required=True)

    put = subparsers.add_parser("put", help="publish a verified local .laz tile and write its index once")
    put.add_argument("--input", required=True, type=Path)
    put.add_argument("--dataset", default=DEFAULT_DATASET)
    put.add_argument("--release", default=UNKNOWN_RELEASE)
    put.add_argument("--tile", help="bare tile .laz filename (defaults to input basename)")
    put.add_argument("--provenance-json", type=Path)
    put.add_argument("--source-uri", help="optional source URI; query parameters are removed")

    get = subparsers.add_parser("get", help="fetch a tile through its immutable index into a local cache")
    get.add_argument("--dataset", default=DEFAULT_DATASET)
    get.add_argument("--release", default=UNKNOWN_RELEASE)
    get.add_argument("--tile", required=True)
    get.add_argument("--cache-dir", required=True, type=Path)

    subparsers.add_parser("check", help="verify access to the configured R2 bucket")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        cache = R2TileCache.from_env(
            timeout_seconds=args.timeout_seconds,
            max_tile_bytes=args.max_tile_bytes,
        )
        cache.preflight()
        if args.command == "check":
            print(json.dumps({"bucket": cache.bucket, "status": "accessible"}, sort_keys=True))
            return 0
        if args.command == "put":
            entry = cache.publish_tile(
                args.input,
                dataset=args.dataset,
                release=args.release,
                tile=args.tile,
                provenance=_read_provenance(args.provenance_json, args.source_uri),
            )
            print(json.dumps(asdict(entry), ensure_ascii=False, sort_keys=True, default=str))
            return 0
        entry = cache.fetch_tile(
            dataset=args.dataset,
            release=args.release,
            tile=args.tile,
            cache_dir=args.cache_dir,
        )
        if entry is None:
            print("R2 tile index not found", file=sys.stderr)
            return 4
        print(json.dumps(asdict(entry), ensure_ascii=False, sort_keys=True, default=str))
        return 0
    except R2TileCacheError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
