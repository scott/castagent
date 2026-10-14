import json
import os
import re
import sqlite3
import pytest
import tempfile
import yaml
from pathlib import Path

from cast import releases
from cast.builder_tools import (
    create_agent,
    check_name_availability,
    install_mcp,
    recommend_model,
    list_agents,
    get_agent_config,
    read_file,
    update_agent_config,
    update_instructions,
    suggest_name,
)
from cast.builder_tools.tools import AGENTS_DIR


class TestCreateAgent:
    """Tests for create_agent tool."""

    def test_create_agent_creates_files(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            # Override AGENTS_DIR for testing
            from cast.builder_tools import tools
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                result = create_agent.invoke({"name": "test-agent"})
                assert "created successfully" in result

                agent_path = Path(tmpdir) / "test-agent"
                assert (agent_path / "agent.yaml").exists()
                assert (agent_path / "instructions.md").exists()
                assert (agent_path / "skills").exists()
                assert (agent_path / "tools").exists()
                assert (agent_path / "mcp").exists()
            finally:
                tools.AGENTS_DIR = original_dir

    def test_apply_process_dirs_creates_in_cast_agents_dir(self, tmp_path, monkeypatch):
        """CAST_AGENTS_DIR is the directory create_agent writes, including for meta tests."""
        from cast import versioning
        from cast.builder_tools import tools

        agents = tmp_path / "agents"
        builder = tmp_path / "builder"
        agents.mkdir()
        previous_agents = tools.AGENTS_DIR
        previous_builder = tools.BUILDER_DIR
        previous_versioning = versioning.AGENTS_DIR
        home_yaml = Path.home() / ".cast" / "agents" / "email-agent" / "agent.yaml"
        home_before = home_yaml.read_text(encoding="utf-8") if home_yaml.exists() else None
        monkeypatch.setenv("CAST_AGENTS_DIR", str(agents))
        monkeypatch.setenv("CAST_BUILDER_DIR", str(builder))

        try:
            tools.apply_process_dirs()
            assert tools.AGENTS_DIR == agents
            assert tools.BUILDER_DIR == builder
            assert versioning.AGENTS_DIR == agents
            created = create_agent.invoke({"name": "email-agent", "description": "reads email"})
            assert "created successfully" in created
            agent_yaml = agents / "email-agent" / "agent.yaml"
            assert agent_yaml.is_file()
            assert "email-agent" in agent_yaml.read_text(encoding="utf-8")
            agent_yaml.write_text("name: stale\n", encoding="utf-8")
            again = create_agent.invoke({"name": "email-agent"})
            assert "already exists" in again
            assert agent_yaml.read_text(encoding="utf-8") == "name: stale\n"
            assert (builder / "created-agent").read_text(encoding="utf-8").strip() == "email-agent"
        finally:
            tools.AGENTS_DIR = previous_agents
            tools.BUILDER_DIR = previous_builder
            versioning.AGENTS_DIR = previous_versioning

        home_after = home_yaml.read_text(encoding="utf-8") if home_yaml.exists() else None
        assert home_after == home_before

    def test_create_agent_already_exists(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                create_agent.invoke({"name": "existing-agent"})
                result = create_agent.invoke({"name": "existing-agent"})
                assert "already exists" in result
            finally:
                tools.AGENTS_DIR = original_dir

    def test_create_agent_records_registry_row(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools
            original_dir = tools.AGENTS_DIR
            root = Path(tmpdir)
            tools.AGENTS_DIR = root / "agents"
            try:
                agent_name = "bb-answers-registry"
                result = create_agent.invoke({"name": agent_name, "description": "Answers questions"})
                assert "created successfully" in result
                db_path = root / "cast.db"
                assert db_path.is_file()
                conn = sqlite3.connect(str(db_path))
                try:
                    row = conn.execute(
                        "SELECT name, agent_yaml_path FROM agents WHERE name = ?",
                        (agent_name,),
                    ).fetchone()
                finally:
                    conn.close()
                assert row is not None
                assert row[0] == agent_name
                assert Path(row[1]) == root / "agents" / agent_name / "agent.yaml"
                home_db = Path.home() / ".cast" / "cast.db"
                if home_db.exists():
                    home = sqlite3.connect(str(home_db))
                    try:
                        leaked = home.execute(
                            "SELECT 1 FROM agents WHERE name = ?",
                            (agent_name,),
                        ).fetchone()
                    except sqlite3.Error:
                        leaked = None
                    finally:
                        home.close()
                    assert leaked is None
            finally:
                tools.AGENTS_DIR = original_dir

    def test_create_agent_records_marker_for_the_wizard(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools
            original_dir = tools.AGENTS_DIR
            original_builder = tools.BUILDER_DIR
            root = Path(tmpdir)
            tools.AGENTS_DIR = root / "agents"
            tools.BUILDER_DIR = root / "builder"

            try:
                result = create_agent.invoke({"name": "bb-summarizer", "description": "summarizes"})
                assert "created successfully" in result
                marker = tools.BUILDER_DIR / tools.CREATED_AGENT_MARKER
                assert marker.read_text(encoding="utf-8").strip() == "bb-summarizer"
            finally:
                tools.AGENTS_DIR = original_dir
                tools.BUILDER_DIR = original_builder

    def test_create_agent_yaml_content(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                create_agent.invoke({"name": "yaml-test-agent"})
                agent_yaml_path = Path(tmpdir) / "yaml-test-agent" / "agent.yaml"

                with open(agent_yaml_path, "r") as f:
                    config = yaml.safe_load(f)

                assert config["name"] == "yaml-test-agent"
                assert config["version"] == "1.0"
                assert "brain" in config
                assert "tools" in config
                assert config["tools"]["builtin"] == ["bash", "read", "glob"]
            finally:
                tools.AGENTS_DIR = original_dir


class TestInstallMcp:
    """Tests for install_mcp tool."""

    def test_install_mcp_creates_config(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                # First create the agent
                create_agent.invoke({"name": "mcp-test-agent"})

                # Install MCP server
                result = install_mcp.invoke({"name": "mcp-test-agent", "server": "gmail"})
                assert "Installed MCP server 'gmail'" in result

                mcp_path = Path(tmpdir) / "mcp-test-agent" / "mcp" / "gmail.yaml"
                assert mcp_path.exists()

                with open(mcp_path, "r") as f:
                    config = yaml.safe_load(f)

                assert config["server"] == "gmail"
                assert config["auth"]["type"] == "oauth"
            finally:
                tools.AGENTS_DIR = original_dir

    def test_install_mcp_updates_agent_yaml(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                create_agent.invoke({"name": "mcp-update-agent"})
                install_mcp.invoke({"name": "mcp-update-agent", "server": "slack"})

                agent_yaml_path = Path(tmpdir) / "mcp-update-agent" / "agent.yaml"
                with open(agent_yaml_path, "r") as f:
                    config = yaml.safe_load(f)

                mcp_list = config["tools"]["mcp"]
                assert any(m.get("server") == "slack" for m in mcp_list)
            finally:
                tools.AGENTS_DIR = original_dir

    def test_install_mcp_agent_not_found(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                with pytest.raises(ValueError, match="does not exist"):
                    install_mcp.invoke({"name": "nonexistent", "server": "gmail"})
            finally:
                tools.AGENTS_DIR = original_dir


class TestRecommendModel:
    """Tests for recommend_model tool."""

    def test_recommend_simple_task(self):
        result = recommend_model.invoke({"requirements": "Simple task to classify emails"})
        assert "haiku" in result.lower() or "mini" in result.lower()

    def test_recommend_complex_task(self):
        result = recommend_model.invoke({"requirements": "Complex analysis and reasoning"})
        assert "sonnet" in result.lower() or "opus" in result.lower()

    def test_recommend_coding_task(self):
        result = recommend_model.invoke({"requirements": "Code review and debugging"})
        assert "sonnet" in result.lower()

    def test_recommend_default(self):
        result = recommend_model.invoke({"requirements": "General purpose agent"})
        assert "sonnet" in result.lower()

    def test_recommend_model_ids_are_in_the_catalog(self):
        from cast.providers.registry import model_status

        prompts = [
            "Simple task to classify emails",
            "Complex analysis and reasoning",
            "Code review and debugging",
            "General purpose agent",
        ]
        for prompt in prompts:
            result = recommend_model.invoke({"requirements": prompt})
            ids = re.findall(r"openrouter/\S+", result)
            assert ids, result
            for model_id in ids:
                status = model_status(model_id.rstrip("."))
                assert status["valid"], status
            assert "brain.model" in result


class TestListAgents:
    """Tests for list_agents tool."""

    def test_list_agents_empty(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                result = list_agents.invoke({})
                assert result == []
            finally:
                tools.AGENTS_DIR = original_dir

    def test_list_agents_returns_names(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                create_agent.invoke({"name": "agent-a"})
                create_agent.invoke({"name": "agent-b"})

                result = list_agents.invoke({})
                assert "agent-a" in result
                assert "agent-b" in result
                assert result == sorted(result)
            finally:
                tools.AGENTS_DIR = original_dir


class TestGetAgentConfig:
    """Tests for get_agent_config tool."""

    def test_get_agent_config_returns_yaml(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                create_agent.invoke({"name": "config-agent"})
                result = get_agent_config.invoke({"name": "config-agent"})
                assert "name: config-agent" in result
            finally:
                tools.AGENTS_DIR = original_dir

    def test_get_agent_config_not_found(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                with pytest.raises(ValueError, match="does not exist"):
                    get_agent_config.invoke({"name": "nonexistent"})
            finally:
                tools.AGENTS_DIR = original_dir


class TestUpdateAgentConfig:
    """Tests for update_agent_config tool."""

    def test_update_agent_config_merges(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                create_agent.invoke({"name": "update-config-agent"})
                result = update_agent_config.invoke({
                    "name": "update-config-agent",
                    "config_yaml": "version: '2.0'\ndescription: Updated",
                })
                assert "Updated agent.yaml" in result

                agent_yaml_path = Path(tmpdir) / "update-config-agent" / "agent.yaml"
                with open(agent_yaml_path, "r") as f:
                    config = yaml.safe_load(f)

                assert config["version"] == "2.0"
                assert config["description"] == "Updated"
                assert config["name"] == "update-config-agent"  # Original value preserved
                assert "Applied:" in result
                assert "description: Updated" in result
                assert "brain.model" not in result
            finally:
                tools.AGENTS_DIR = original_dir

    def test_rejects_unloadable_builder_shape(self):
        """Flat tools, top-level model, permissions, and memory are not stored."""
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools
            import cast.versioning as versioning

            original_dir = tools.AGENTS_DIR
            original_versioning = versioning.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)
            versioning.AGENTS_DIR = Path(tmpdir)

            try:
                create_agent.invoke({"name": "bb2-live", "description": "answers in one sentence"})
                agent_yaml_path = Path(tmpdir) / "bb2-live" / "agent.yaml"
                before = agent_yaml_path.read_text()

                result = update_agent_config.invoke({
                    "name": "bb2-live",
                    "config_yaml": """
model: openrouter/anthropic/claude-3-5-haiku
tools:
  - bash
  - read
  - glob
permissions:
  bash: approve-once
  read: allow
memory:
  enabled: true
""",
                })

                assert "Nothing was applied" in result
                assert "brain.model is still openrouter/minimax/minimax-m2.5" in result
                assert "approve-once" in result
                assert "allow" in result
                assert "not applied" in result.lower() or "was not applied" in result
                assert agent_yaml_path.read_text() == before

                config = yaml.safe_load(before)
                assert config["tools"]["builtin"] == ["bash", "read", "glob"]
                assert config["brain"]["model"] == "openrouter/minimax/minimax-m2.5"
                assert "model" not in config
                assert "permissions" not in config
                assert "memory" not in config

                changes = json.loads(
                    (Path(tmpdir) / "bb2-live" / ".cast" / "changes" / "changes.json").read_text()
                )
                assert len(changes["versions"]) == 1
                assert [entry["id"] for entry in changes["versions"]] == [1]
            finally:
                tools.AGENTS_DIR = original_dir
                versioning.AGENTS_DIR = original_versioning

    def test_rejects_permission_list_and_unknown_brain_model(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools

            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)
            try:
                create_agent.invoke({"name": "bb2-bskill"})
                before = (Path(tmpdir) / "bb2-bskill" / "agent.yaml").read_text()
                result = update_agent_config.invoke({
                    "name": "bb2-bskill",
                    "config_yaml": """
brain:
  model: claude-haiku-4-5
permissions:
  - approve-once
  - allow
""",
                })
                assert "Nothing was applied" in result
                assert "claude-haiku-4-5" in result
                assert "brain.model is still openrouter/minimax/minimax-m2.5" in result
                assert (Path(tmpdir) / "bb2-bskill" / "agent.yaml").read_text() == before
            finally:
                tools.AGENTS_DIR = original_dir

    def test_stores_catalog_model_and_reports_only_applied_fields(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools

            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)
            try:
                create_agent.invoke({"name": "shaped-agent"})
                result = update_agent_config.invoke({
                    "name": "shaped-agent",
                    "config_yaml": """
brain:
  model: openrouter/anthropic/claude-3.5-haiku
tools:
  builtin:
    - bash
    - read
harness:
  permissions:
    bash: ask
""",
                })
                assert "Updated agent.yaml" in result
                assert "Applied:" in result
                assert "brain.model: openrouter/anthropic/claude-3.5-haiku" in result
                assert "tools.builtin: bash, read" in result
                assert "harness.permissions: bash=ask" in result
                assert "Nothing else was changed." in result
                assert "approve-once" not in result
                assert "Claude 3.5" not in result

                config = yaml.safe_load((Path(tmpdir) / "shaped-agent" / "agent.yaml").read_text())
                assert config["brain"]["model"] == "openrouter/anthropic/claude-3.5-haiku"
                assert config["tools"]["builtin"] == ["bash", "read"]
                assert config["tools"]["mcp"] == []
                assert config["harness"]["permissions"] == {"bash": "ask"}
                assert "model" not in config
                assert "permissions" not in config
                assert "memory" not in config
            finally:
                tools.AGENTS_DIR = original_dir


class TestUpdateInstructions:
    """Tests for update_instructions tool."""

    def test_update_instructions(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                create_agent.invoke({"name": "instructions-agent"})
                result = update_instructions.invoke({
                    "name": "instructions-agent",
                    "instructions_md": "# Custom Instructions\n\nBe very helpful.",
                })
                assert "Updated instructions.md" in result

                instructions_path = Path(tmpdir) / "instructions-agent" / "instructions.md"
                content = instructions_path.read_text()
                assert "Custom Instructions" in content
                assert "Be very helpful." in content
            finally:
                tools.AGENTS_DIR = original_dir


class TestSuggestName:
    """Tests for suggest_name tool."""

    def test_suggest_name_from_description(self):
        result = suggest_name.invoke({"description": "an agent that reads my emails"})
        assert "suggested name:" in result.lower()
        assert "email" in result.lower()

    def test_suggest_name_avoids_conflicts(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                # Create an agent to cause a conflict
                create_agent.invoke({"name": "email-agent"})
                result = suggest_name.invoke({"description": "an agent that reads my emails"})
                assert "suggested name:" in result.lower()
                # Should have suggested an alternative since email-agent exists
                assert "was taken" in result.lower() or "email-agent-2" in result.lower()
            finally:
                tools.AGENTS_DIR = original_dir


class TestCheckNameAvailability:
    """Tests for check_name_availability tool."""

    def test_available_name(self):
        result = check_name_availability.invoke({"name": "totally-unique-agent-12345"})
        assert "available" in result.lower()

    def test_taken_name(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                create_agent.invoke({"name": "taken-agent"})
                result = check_name_availability.invoke({"name": "taken-agent"})
                assert "taken" in result.lower() or "already" in result.lower()
            finally:
                tools.AGENTS_DIR = original_dir


class TestCreateAgentWithDescription:
    """Tests for create_agent with description parameter."""

    def test_create_agent_with_description(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            from cast.builder_tools import tools
            original_dir = tools.AGENTS_DIR
            tools.AGENTS_DIR = Path(tmpdir)

            try:
                result = create_agent.invoke({
                    "name": "described-agent",
                    "description": "reads emails and drafts replies",
                })
                assert "created successfully" in result

                agent_yaml_path = Path(tmpdir) / "described-agent" / "agent.yaml"
                with open(agent_yaml_path, "r") as f:
                    config = yaml.safe_load(f)

                assert config["description"] == "reads emails and drafts replies"

                instructions_path = Path(tmpdir) / "described-agent" / "instructions.md"
                content = instructions_path.read_text()
                assert "reads emails and drafts replies" in content
                assert "Your Capabilities" in content
            finally:
                tools.AGENTS_DIR = original_dir


class TestCreateFromDescription:
    """Headless create used when cast new has no TTY."""

    def _isolate(self, tmp_path, monkeypatch):
        from cast.builder_tools import tools
        import cast.versioning as versioning

        agents = tmp_path / "agents"
        monkeypatch.setenv("CAST_AGENTS_DIR", str(agents))
        monkeypatch.setattr(versioning, "AGENTS_DIR", agents)
        monkeypatch.setattr(tools, "BUILDER_DIR", tmp_path / "builder")
        return tools, agents

    def test_creates_email_agent_from_issue_text(self, tmp_path, monkeypatch):
        tools, agents = self._isolate(tmp_path, monkeypatch)
        description = "Email assistant that triages and drafts replies"
        home_side = Path.home() / ".cast" / "agents" / "email-agent"
        real_marker = Path.home() / ".cast" / "builder" / "created-agent"
        marker_before = real_marker.read_text() if real_marker.exists() else None
        assert not home_side.exists()

        info = tools.create_from_description(description)
        assert info["name"] == "email-agent"
        assert info["description"] == description
        assert info["path"] == str(agents / "email-agent")

        config = yaml.safe_load((agents / "email-agent" / "agent.yaml").read_text())
        assert config["name"] == "email-agent"
        assert config["description"] == description
        instructions = (agents / "email-agent" / "instructions.md").read_text()
        assert description in instructions
        changes = agents / "email-agent" / ".cast" / "changes" / "changes.json"
        assert changes.is_file()
        assert not home_side.exists()
        marker_after = real_marker.read_text() if real_marker.exists() else None
        assert marker_after == marker_before
        recorded = (tmp_path / "builder" / "created-agent").read_text(encoding="utf-8").strip()
        assert recorded == "email-agent"

    def test_docs_example_picks_email_agent(self, tmp_path, monkeypatch):
        tools, agents = self._isolate(tmp_path, monkeypatch)
        description = "Summarises incoming email and drafts replies."
        info = tools.create_from_description(description + "\n")
        assert info["name"] == "email-agent"
        assert info["description"] == description
        assert (agents / "email-agent" / "agent.yaml").is_file()

    def test_suffix_when_name_is_taken(self, tmp_path, monkeypatch):
        tools, agents = self._isolate(tmp_path, monkeypatch)
        tools.AGENTS_DIR = agents
        create_agent.invoke({"name": "email-agent", "description": "taken"})
        info = tools.create_from_description("reads my email")
        assert info["name"] == "email-agent-2"
        assert (agents / "email-agent-2" / "agent.yaml").is_file()
        assert (agents / "email-agent" / "agent.yaml").is_file()

    def test_short_description_uses_new_agent(self, tmp_path, monkeypatch):
        tools, agents = self._isolate(tmp_path, monkeypatch)
        info = tools.create_from_description("ab")
        assert info["name"] == "new-agent"
        assert (agents / "new-agent").is_dir()

    def test_blank_description_is_refused(self, tmp_path, monkeypatch):
        tools, _agents = self._isolate(tmp_path, monkeypatch)
        with pytest.raises(ValueError, match="No description on stdin"):
            tools.create_from_description("  \n\t")

    def test_stdin_module_prints_json(self, tmp_path, monkeypatch, capsys):
        import io
        import sys
        from cast.create_from_stdin import main

        self._isolate(tmp_path, monkeypatch)
        monkeypatch.setattr(
            sys,
            "stdin",
            io.StringIO("Summarises incoming email and drafts replies.\n"),
        )
        assert main() == 0
        captured = capsys.readouterr()
        payload = json.loads(captured.out)
        assert payload["name"] == "email-agent"
        assert payload["path"].endswith("email-agent")
        assert captured.err == ""

    def test_stdin_module_rejects_blank(self, monkeypatch, capsys):
        import io
        import sys
        from cast.create_from_stdin import main

        monkeypatch.setattr(sys, "stdin", io.StringIO("\n"))
        assert main() == 2
        captured = capsys.readouterr()
        assert "No description on stdin" in captured.err
        assert captured.out == ""


class TestReadFile:
    """Tests for read_file tool."""

    def test_read_file_success(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            test_file = Path(tmpdir) / "test.txt"
            test_file.write_text("Hello, world!\nLine 2\nLine 3\n")
            
            result = read_file.invoke({"file_path": str(test_file)})
            assert "Hello, world!" in result
            assert "Line 2" in result
            assert "Line 3" in result

    def test_read_file_not_found(self):
        result = read_file.invoke({"file_path": "/nonexistent/path/file.txt"})
        assert "not found" in result.lower()

    def test_read_file_with_offset_and_limit(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            test_file = Path(tmpdir) / "test.txt"
            lines = [f"Line {i}\n" for i in range(1, 21)]
            test_file.write_text("".join(lines))
            
            result = read_file.invoke({"file_path": str(test_file), "offset": 5, "limit": 5})
            assert "Line 6" in result
            assert "Line 10" in result
            assert "Line 5" not in result
            assert "Line 11" not in result
            assert "more lines" in result

    def test_read_file_directory(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            result = read_file.invoke({"file_path": tmpdir})
            assert "not a file" in result.lower()

    def test_read_file_expands_tilde(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            test_file = Path(tmpdir) / "test.txt"
            test_file.write_text("Home directory file content")
            
            # Mock the home directory by using the tmpdir as home
            import os
            original_home = os.environ.get("HOME")
            os.environ["HOME"] = tmpdir
            try:
                result = read_file.invoke({"file_path": "~/test.txt"})
                assert "Home directory file content" in result
            finally:
                if original_home:
                    os.environ["HOME"] = original_home
                else:
                    del os.environ["HOME"]


class TestCreateReleaseTool:
    """Builder create_release uses the same SQLite writer as cast.releases."""

    def test_create_release_tool_writes_sqlite(self, monkeypatch, tmp_path):
        home = tmp_path / "home"
        monkeypatch.setenv("HOME", str(home))
        agents = home / ".cast" / "agents"
        agent = agents / "builder-agent"
        agent.mkdir(parents=True)
        (agent / "agent.yaml").write_text("name: builder-agent\nversion: '0.0'\n")
        (agent / "instructions.md").write_text("# builder\n")

        from cast.builder_tools import tools
        monkeypatch.setattr(tools, "AGENTS_DIR", agents)
        monkeypatch.setattr(releases, "AGENTS_DIR", agents)

        result = tools.create_release.invoke({
            "name": "builder-agent",
            "version": "1.5.0",
            "message": "from builder",
        })
        assert "created successfully" in result
        assert "1.5.0" in result

        db_path = home / ".cast" / "cast.db"
        assert db_path.exists()
        conn = sqlite3.connect(str(db_path))
        try:
            row = conn.execute(
                """
                SELECT version, message, change_number, tarball_path
                FROM releases WHERE agent_name = ?
                """,
                ("builder-agent",),
            ).fetchone()
        finally:
            conn.close()
        assert row[0] == "1.5.0"
        assert row[1] == "from builder"
        assert row[2] == 0
        assert row[3].endswith("1.5.0.tar.gz")
        manifest = json.loads((agent / ".cast" / "releases" / "releases.json").read_text())
        assert manifest["current"]["version"] == "1.5.0"
        assert manifest["releases"][0]["tarball_path"] == ".cast/releases/1.5.0.tar.gz"
