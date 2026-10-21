"""Read built-in rows from manifest.json without importing the registry."""

import json
from pathlib import Path


def _path() -> Path:
    return Path(__file__).with_name("manifest.json")


def load_rows() -> list:
    data = json.loads(_path().read_text())
    if isinstance(data, dict):
        rows = data.get("providers") or []
    else:
        rows = data
    if not isinstance(rows, list):
        raise RuntimeError("manifest.json providers must be a list")
    return rows


def provider_rows() -> list:
    """Rows that register a provider. Reserved prefix rows are not included."""
    return [row for row in load_rows() if row.get("impl") != "reserved"]


def reserved_rows() -> list:
    return [row for row in load_rows() if row.get("impl") == "reserved"]


def row_for(key: str) -> dict:
    for row in load_rows():
        if row.get("key") == key:
            return row
    raise RuntimeError(f"manifest.json has no row for {key}")
