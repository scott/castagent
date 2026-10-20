"""Deploy and the runtime share tests/fixtures/agent-yaml-version.json."""

import json
import os
import tempfile
from pathlib import Path

from cast.agent.base import MISSING_AGENT_VERSION, AgentConfig, read_agent_yaml_version

_TABLE_PATH = Path(__file__).resolve().parents[4] / "tests" / "fixtures" / "agent-yaml-version.json"


def _table() -> dict:
    return json.loads(_TABLE_PATH.read_text(encoding="utf-8"))


def test_missing_version_constant_matches_the_shared_table():
    table = _table()
    assert MISSING_AGENT_VERSION == table["missingVersion"]
    assert table["cases"]


def test_agent_yaml_version_matches_the_shared_table(case):
    parsed = read_agent_yaml_version(case["yaml"])
    assert parsed.version == case["expected"], case["name"]
    assert parsed.explicit is case["explicit"], case["name"]
    assert isinstance(parsed.version, str)

    with tempfile.TemporaryDirectory() as tmp:
        yaml_path = os.path.join(tmp, "agent.yaml")
        with open(yaml_path, "w", encoding="utf-8", newline="") as handle:
            handle.write(case["yaml"])
        config = AgentConfig.from_path(tmp)

    assert config.version == case["expected"], case["name"]
    assert isinstance(config.version, str)
    assert config.config["version"] == case["expected"]
    if case["expected"] == "1.10":
        assert config.version != "1.1"


def pytest_generate_tests(metafunc):
    if "case" not in metafunc.fixturenames:
        return
    table = _table()
    metafunc.parametrize("case", table["cases"], ids=[item["name"] for item in table["cases"]])
