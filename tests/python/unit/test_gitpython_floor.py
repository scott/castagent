"""The GitPython floor must stay outside historical OSV ranges."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
FLOOR = (3, 2, 1)


def _version(spec: str) -> tuple[int, ...]:
    return tuple(int(part) for part in spec.split("."))


def test_pyproject_excludes_vulnerable_gitpython_releases():
    text = (ROOT / "python" / "pyproject.toml").read_text()
    assert 'GitPython>=3.2.1' in text
    for vulnerable in ("3.1.0", "3.1.30", "3.1.41", "3.1.61"):
        assert _version(vulnerable) < FLOOR


def _pins(text: str) -> list[str]:
    pins = []
    for line in text.splitlines():
        stripped = line.strip().removesuffix("\\").strip()
        if not stripped or stripped.startswith("#") or stripped.startswith("--hash"):
            continue
        pins.append(stripped)
        name, operator, version = stripped.partition("==")
        assert name
        assert operator == "=="
        assert version
    return pins


def test_requirements_lock_pins_gitpython_at_or_above_the_floor():
    pins = _pins((ROOT / "python" / "requirements.lock").read_text())

    gitpython = next(pin for pin in pins if pin.lower().startswith("gitpython=="))
    assert _version(gitpython.split("==", 1)[1]) >= FLOOR
