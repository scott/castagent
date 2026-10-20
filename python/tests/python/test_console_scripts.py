"""Installed console scripts must run, not return an unawaited coroutine.

setuptools writes ``sys.exit(<entry point>())``. Pointing that at an async
``main`` creates a coroutine, prints it, and exits 1 before argument parsing.
"""

import inspect
import shutil
import subprocess
import sys
import sysconfig
from importlib.metadata import entry_points
from pathlib import Path

import pytest


def _entry_point(name: str):
    matches = [ep for ep in entry_points(group="console_scripts") if ep.name == name]
    assert matches, f"{name} is not installed as a console script"
    assert len(matches) == 1
    return matches[0]


def _script_path(name: str) -> str:
    found = shutil.which(name)
    if found:
        return found
    # sys.executable in a venv is a symlink. Resolving it lands in the
    # system interpreter directory, which does not contain these scripts.
    scripts = sysconfig.get_path("scripts")
    candidate = Path(scripts) / name
    if candidate.is_file():
        return str(candidate)
    pytest.fail(
        f"{name} console script was not found on PATH or in {scripts}"
    )


@pytest.mark.parametrize(
    ("name", "target"),
    [
        ("cast-runtime", "cast.runtime:run"),
        ("cast-builder", "cast.builder:run"),
    ],
)
def test_console_script_help_exits_zero(name: str, target: str):
    entry = _entry_point(name)
    assert entry.value == target
    loaded = entry.load()
    assert not inspect.iscoroutinefunction(loaded)

    completed = subprocess.run(
        [_script_path(name), "--help"],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    output = f"{completed.stdout}\n{completed.stderr}"
    assert completed.returncode == 0, output
    assert "usage" in output.lower()
    assert "coroutine object" not in output
    assert "was never awaited" not in output
