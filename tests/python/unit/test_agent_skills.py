import os
from unittest.mock import MagicMock, patch

import pytest

from cast.agent.base import AgentConfig
from cast.agent.runtime import RuntimeAgent


def _write_skill(agent_dir, name, description, body):
    skill_dir = os.path.join(agent_dir, "skills", name)
    os.makedirs(skill_dir, exist_ok=True)
    with open(os.path.join(skill_dir, "SKILL.md"), "w", encoding="utf-8") as handle:
        handle.write(
            f"---\nname: {name}\ndescription: {description}\n---\n\n{body}\n"
        )
    return skill_dir


def _write_agent(tmp_path, skills_yaml="", instructions="You are a helpful test agent."):
    agent_dir = tmp_path / "email-agent"
    agent_dir.mkdir()
    text = "name: email-agent\nversion: '1.0'\ndescription: Sorts mail\n"
    if skills_yaml:
        text += skills_yaml
    (agent_dir / "agent.yaml").write_text(text)
    (agent_dir / "instructions.md").write_text(instructions)
    return str(agent_dir)


def test_skills_property_defaults_to_empty_list(tmp_path):
    config = AgentConfig.from_path(_write_agent(tmp_path))
    assert config.skills == []
    assert config.rendered_prompt() == "You are a helpful test agent."


def test_skills_property_preserves_yaml_order(tmp_path):
    agent_dir = _write_agent(
        tmp_path,
        skills_yaml="""skills:
  - name: zebra
    description: Last
    path: skills/zebra
  - name: alpha
    description: First
    path: skills/alpha
""",
    )
    config = AgentConfig.from_path(agent_dir)
    assert [item["name"] for item in config.skills] == ["zebra", "alpha"]


def test_rendered_prompt_includes_skill_bodies_in_yaml_order(tmp_path):
    agent_dir = _write_agent(tmp_path)
    _write_skill(agent_dir, "zebra", "Striped", "Do zebra things.")
    _write_skill(agent_dir, "triage", "Sort incoming mail into buckets", "# Triage\n\nSort the mail.")
    yaml_path = os.path.join(agent_dir, "agent.yaml")
    with open(yaml_path, "a", encoding="utf-8") as handle:
        handle.write(
            "skills:\n"
            "  - name: zebra\n"
            "    description: Striped\n"
            "    path: skills/zebra\n"
            "  - name: triage\n"
            "    description: Sort incoming mail into buckets\n"
            "    path: skills/triage\n"
        )
    config = AgentConfig.from_path(agent_dir)
    prompt = config.rendered_prompt()
    assert prompt == (
        "You are a helpful test agent.\n"
        "\n"
        "## Skills\n"
        "\n"
        "### zebra\n"
        "Striped\n"
        "\n"
        "Do zebra things.\n"
        "\n"
        "### triage\n"
        "Sort incoming mail into buckets\n"
        "\n"
        "# Triage\n"
        "\n"
        "Sort the mail.\n"
    )
    assert prompt.index("### zebra") < prompt.index("### triage")


def test_agent_card_lists_loaded_skills_instead_of_the_synthetic_one(tmp_path):
    agent_dir = _write_agent(tmp_path)
    _write_skill(agent_dir, "triage", "Sort incoming mail into buckets", "Sort the mail.")
    with open(os.path.join(agent_dir, "agent.yaml"), "a", encoding="utf-8") as handle:
        handle.write(
            "skills:\n"
            "  - name: triage\n"
            "    description: Sort incoming mail into buckets\n"
            "    path: skills/triage\n"
        )
    with patch.dict(os.environ, {}, clear=True):
        agent = RuntimeAgent(AgentConfig.from_path(agent_dir), agent_dir)
        card = agent.get_agent_card()
    assert card["skills"] == [{
        "id": "triage",
        "name": "triage",
        "description": "Sort incoming mail into buckets",
    }]


def test_agent_with_no_skills_keeps_the_synthetic_card_skill(tmp_path):
    agent_dir = _write_agent(tmp_path)
    with patch.dict(os.environ, {}, clear=True):
        card = RuntimeAgent(AgentConfig.from_path(agent_dir), agent_dir).get_agent_card()
    assert len(card["skills"]) == 1
    assert card["skills"][0]["id"] == "email-agent-skill"
    assert card["skills"][0]["name"] == "email-agent"
    assert card["skills"][0]["description"] == "Sorts mail"


def test_missing_skill_markdown_is_skipped(tmp_path):
    agent_dir = _write_agent(tmp_path)
    _write_skill(agent_dir, "triage", "Sort incoming mail into buckets", "Sort the mail.")
    with open(os.path.join(agent_dir, "agent.yaml"), "a", encoding="utf-8") as handle:
        handle.write(
            "skills:\n"
            "  - name: missing\n"
            "    description: Gone\n"
            "    path: skills/missing\n"
            "  - name: triage\n"
            "    description: Sort incoming mail into buckets\n"
            "    path: skills/triage\n"
        )
    config = AgentConfig.from_path(agent_dir)
    loaded = config.load_skills()
    assert [item["name"] for item in loaded] == ["triage"]
    assert "### missing" not in config.rendered_prompt()
    assert "### triage" in config.rendered_prompt()
    with patch.dict(os.environ, {}, clear=True):
        card = RuntimeAgent(config, agent_dir).get_agent_card()
    assert [item["id"] for item in card["skills"]] == ["triage"]


def test_all_missing_skills_fall_back_to_the_synthetic_card(tmp_path):
    agent_dir = _write_agent(tmp_path, skills_yaml=(
        "skills:\n"
        "  - name: missing\n"
        "    description: Gone\n"
        "    path: skills/missing\n"
    ))
    config = AgentConfig.from_path(agent_dir)
    assert config.load_skills() == []
    assert config.rendered_prompt() == "You are a helpful test agent."
    with patch.dict(os.environ, {}, clear=True):
        card = RuntimeAgent(config, agent_dir).get_agent_card()
    assert card["skills"][0]["id"] == "email-agent-skill"


@patch("cast.agent.runtime.OpenRouterProvider")
@patch("cast.agent.runtime.create_react_agent")
def test_runtime_prompt_includes_skills(mock_create_react_agent, mock_provider_class, tmp_path):
    agent_dir = _write_agent(tmp_path)
    _write_skill(agent_dir, "triage", "Sort incoming mail into buckets", "Sort the mail.")
    with open(os.path.join(agent_dir, "agent.yaml"), "a", encoding="utf-8") as handle:
        handle.write(
            "skills:\n"
            "  - name: triage\n"
            "    description: Sort incoming mail into buckets\n"
            "    path: skills/triage\n"
        )
    mock_provider_class.return_value.create_llm.return_value = MagicMock()
    mock_create_react_agent.return_value = MagicMock()
    with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
        RuntimeAgent(AgentConfig.from_path(agent_dir), agent_dir)
    prompt = mock_create_react_agent.call_args.kwargs["prompt"]
    assert "## Skills" in prompt
    assert "### triage" in prompt
    assert "Sort the mail." in prompt
    assert prompt.startswith("You are a helpful test agent.")
