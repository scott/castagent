"""The hashed lockfile covers every direct pyproject dependency."""

import re
import tomllib
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]


def _canonical(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def _dependency_name(spec: str) -> str:
    return re.split(r"[<>=!~;\s\[]", spec.strip(), maxsplit=1)[0]


def test_every_pyproject_dependency_is_pinned_in_the_lock():
    project = tomllib.loads((_ROOT / "pyproject.toml").read_text())
    pinned = set()
    for line in (_ROOT / "requirements.lock").read_text().splitlines():
        match = re.match(r"^([A-Za-z0-9_.-]+)==", line)
        if match:
            pinned.add(_canonical(match.group(1)))
    missing = [
        spec
        for spec in project["project"]["dependencies"]
        if _canonical(_dependency_name(spec)) not in pinned
    ]
    assert missing == []
    assert "anthropic==" in (_ROOT / "requirements.lock").read_text()
    assert "langchain-anthropic==" in (_ROOT / "requirements.lock").read_text()
