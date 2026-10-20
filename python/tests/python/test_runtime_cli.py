"""The runtime bearer token comes from AUTH_TOKEN, never from argv."""

import asyncio
import os
import subprocess
import sys

import pytest

import cast
import cast.runtime as runtime_mod
from cast.runtime import build_runtime_parser, main, read_auth_token


def _package_root() -> str:
    return os.path.dirname(os.path.dirname(cast.__file__))


def test_help_documents_auth_token_env():
    text = build_runtime_parser().format_help()
    assert "AUTH_TOKEN" in text
    assert "--auth-token" not in text
    assert "--agent-path" in text
    assert "--port" in text
    assert "--host" in text


def test_read_auth_token_uses_the_environment_only():
    assert read_auth_token({}) is None
    assert read_auth_token({"AUTH_TOKEN": ""}) is None
    assert read_auth_token({"AUTH_TOKEN": "env-bearer"}) == "env-bearer"
    assert read_auth_token({"OTHER": "env-bearer"}) is None


def test_parser_rejects_auth_token_flag(capsys):
    parser = build_runtime_parser()
    with pytest.raises(SystemExit) as caught:
        parser.parse_args([
            "--agent-path",
            "/tmp/agent",
            "--auth-token",
            "flag-must-be-rejected",
        ])
    assert caught.value.code != 0
    err = capsys.readouterr().err
    assert "unrecognized arguments" in err
    assert "--auth-token" in err


def test_module_help_documents_auth_token():
    env = os.environ.copy()
    env["PYTHONPATH"] = _package_root()
    env.pop("AUTH_TOKEN", None)
    result = subprocess.run(
        [sys.executable, "-m", "cast.runtime", "--help"],
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "AUTH_TOKEN" in result.stdout
    assert "--auth-token" not in result.stdout


def test_module_rejects_auth_token_flag():
    env = os.environ.copy()
    env["PYTHONPATH"] = _package_root()
    env.pop("AUTH_TOKEN", None)
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "cast.runtime",
            "--agent-path",
            "/tmp/agent",
            "--auth-token",
            "flag-must-be-rejected",
        ],
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )
    assert result.returncode != 0
    assert "--auth-token" in result.stderr
    assert "unrecognized arguments" in result.stderr


def _agent_dir(tmp_path):
    agent = tmp_path / "agent"
    agent.mkdir()
    (agent / "agent.yaml").write_text("name: demo\n")
    return agent


def _patch_runtime(monkeypatch, seen):
    class FakeAgent:
        def __init__(self, config, agent_path=None):
            seen["agent_path"] = agent_path

    class FakeServer:
        def __init__(self, agent, host="localhost", port=0):
            seen["host"] = host
            seen["port"] = port

        def set_auth_token(self, token):
            seen["token"] = token

        async def run(self):
            seen["ran"] = True

    # Patch the module object. A string path breaks after another test
    # drops the cast package from sys.modules.
    monkeypatch.setattr(runtime_mod, "RuntimeAgent", FakeAgent)
    monkeypatch.setattr(runtime_mod, "A2AServer", FakeServer)


def test_main_sets_token_from_the_environment(tmp_path, monkeypatch):
    agent = _agent_dir(tmp_path)
    monkeypatch.setenv("AUTH_TOKEN", "env-bearer-token")
    monkeypatch.setattr(sys, "argv", [
        "cast.runtime",
        "--agent-path",
        str(agent),
        "--port",
        "9",
        "--host",
        "127.0.0.1",
    ])
    seen = {}
    _patch_runtime(monkeypatch, seen)

    asyncio.run(main())

    assert seen["token"] == "env-bearer-token"
    assert seen["host"] == "127.0.0.1"
    assert seen["port"] == 9
    assert seen["agent_path"] == str(agent)
    assert seen["ran"] is True


def test_main_starts_without_auth_when_env_is_unset(tmp_path, monkeypatch):
    agent = _agent_dir(tmp_path)
    monkeypatch.delenv("AUTH_TOKEN", raising=False)
    monkeypatch.setattr(sys, "argv", [
        "cast.runtime",
        "--agent-path",
        str(agent),
    ])
    seen = {}
    _patch_runtime(monkeypatch, seen)

    asyncio.run(main())

    assert "token" not in seen
    assert seen["ran"] is True


def test_main_rejects_auth_token_flag_before_starting(tmp_path, monkeypatch):
    agent = _agent_dir(tmp_path)
    monkeypatch.setenv("AUTH_TOKEN", "env-bearer-token")
    monkeypatch.setattr(sys, "argv", [
        "cast.runtime",
        "--agent-path",
        str(agent),
        "--auth-token",
        "flag-must-be-rejected",
    ])
    seen = {}
    _patch_runtime(monkeypatch, seen)

    with pytest.raises(SystemExit) as caught:
        asyncio.run(main())

    assert caught.value.code != 0
    assert "token" not in seen
    assert "ran" not in seen
