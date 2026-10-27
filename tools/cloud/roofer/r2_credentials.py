# Vendored UNCHANGED (below this header) from dk-building-data: /Users/martincollignon/conductor/workspaces/dk-building-data/minnetonka-v3/scripts/reconstruction_annotations/r2_credentials.py
# branch mc/skraafoto-splat-research, base commit dabbd1179e080290e48c313034515614c43766eb (the file is untracked there, not yet on main);
# sha256 of the original: d7c2eb02a8f77b2f203df583a91de56b10493f7752d5cd1497622cef487397e8. Re-vendor from main once it lands; do not edit here.
"""Load Cloudflare R2 credentials from environment or Google Secret Manager.

When ``R2_SECRET_PROJECT`` is set, Application Default Credentials are used to
read the configured secret versions. Without it, the two credential values are
read from their existing environment variables. Secret payloads are never
included in errors or cached globally.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from typing import Any, Callable


DEFAULT_ACCESS_KEY_SECRET_ID = "dk-lidar-r2-access-key-id"
DEFAULT_SECRET_ACCESS_KEY_SECRET_ID = "dk-lidar-r2-secret-access-key"
ACCESS_KEY_VERSION_ENV = "R2_ACCESS_KEY_SECRET_VERSION"
SECRET_ACCESS_KEY_VERSION_ENV = "R2_SECRET_ACCESS_KEY_SECRET_VERSION"

_PROJECT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$")
_SECRET_VERSION = re.compile(
    r"^projects/(?P<project>[^/]+)/secrets/(?P<secret>[A-Za-z0-9_-]+)/versions/(?P<version>[A-Za-z0-9_-]+)$"
)


class R2CredentialError(ValueError):
    """R2 credentials are missing or could not be loaded safely."""


def _version_name(env: Mapping[str, str], variable: str, project: str, default_secret: str) -> str:
    configured = env.get(variable, "").strip()
    if not configured:
        return f"projects/{project}/secrets/{default_secret}/versions/latest"

    match = _SECRET_VERSION.fullmatch(configured)
    if match is None:
        raise R2CredentialError(f"{variable} must be a Secret Manager secret-version resource name")
    if match.group("project") != project:
        raise R2CredentialError(f"{variable} must reference the project configured by R2_SECRET_PROJECT")
    return configured


def _secret_payload(client: Any, version_name: str) -> str:
    try:
        response = client.access_secret_version(request={"name": version_name})
        payload = response.payload.data
        value = payload.decode("utf-8").strip()
    except Exception:
        # Cloud client exceptions can contain request details. Keep them out of
        # user-visible errors and, especially, never include a secret payload.
        raise R2CredentialError("R2 credentials could not be read from Secret Manager") from None
    if not value:
        raise R2CredentialError("R2 Secret Manager credential is empty")
    return value


def _secret_manager_client() -> Any:
    try:
        from google.cloud import secretmanager
    except ImportError:
        raise R2CredentialError(
            "Secret Manager access requires google-cloud-secret-manager; install scripts/reconstruction_annotations/requirements.txt"
        ) from None
    try:
        return secretmanager.SecretManagerServiceClient()
    except Exception:
        raise R2CredentialError("Secret Manager client could not be initialized with Application Default Credentials") from None


def load_r2_credentials(
    env: Mapping[str, str] | None = None,
    *,
    client_factory: Callable[[], Any] | None = None,
) -> tuple[str, str]:
    """Return ``(access_key_id, secret_access_key)`` without persistent caching.

    Setting ``R2_SECRET_PROJECT`` selects Secret Manager deterministically. A
    Secret Manager, permission, or ADC error is returned to the caller and does
    not fall back to credential environment variables.

    ``client_factory`` is an injection point for local checks; production callers
    use the Google client created with Application Default Credentials.
    """
    values = os.environ if env is None else env
    project = values.get("R2_SECRET_PROJECT", "").strip()
    if not project:
        access_key = values.get("R2_ACCESS_KEY_ID", "").strip()
        secret_key = values.get("R2_SECRET_ACCESS_KEY", "").strip()
        missing = [
            name
            for name, value in (
                ("R2_ACCESS_KEY_ID", access_key),
                ("R2_SECRET_ACCESS_KEY", secret_key),
            )
            if not value
        ]
        if missing:
            raise R2CredentialError("missing required R2 credential environment variable(s): " + ", ".join(missing))
        return access_key, secret_key

    if not _PROJECT_ID.fullmatch(project):
        raise R2CredentialError("R2_SECRET_PROJECT must be a valid Google Cloud project ID")

    access_version = _version_name(
        values,
        ACCESS_KEY_VERSION_ENV,
        project,
        DEFAULT_ACCESS_KEY_SECRET_ID,
    )
    secret_version = _version_name(
        values,
        SECRET_ACCESS_KEY_VERSION_ENV,
        project,
        DEFAULT_SECRET_ACCESS_KEY_SECRET_ID,
    )
    client = client_factory() if client_factory is not None else _secret_manager_client()
    try:
        access_key = _secret_payload(client, access_version)
        secret_key = _secret_payload(client, secret_version)
    finally:
        close = getattr(client, "close", None)
        if callable(close):
            try:
                close()
            except Exception:
                pass
    return access_key, secret_key
