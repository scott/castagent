"""Read built-in rows from manifest.json without importing the registry."""

import json
from pathlib import Path


def row_for(key: str) -> dict:
    path = Path(__file__).with_name("manifest.json")
    for row in json.loads(path.read_text()):
        if row.get("key") == key:
            return row
    raise RuntimeError(f"manifest.json has no row for {key}")
