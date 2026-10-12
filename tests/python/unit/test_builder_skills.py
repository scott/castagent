"""Builder skills are appended to the builder prompt, not copied onto agents."""
import pytest
from langchain_core.messages import SystemMessage

from cast.builder import (
    DEFAULT_SYSTEM_PROMPT,
    BuilderAgent,
    _parse_skill_markdown,
    load_system_prompt,
)

FOLDED_SKILL = """---
name: triage
description: >
  Sort incoming mail into buckets
---

# Triage
"""

LITERAL_SKILL = """---
name: inbox
description: |
  Sort incoming mail into buckets.
  Use when the user asks to triage an inbox.
---

# Inbox
"""


def _skill(directory, name, description, body):
    directory.mkdir(parents=True)
    (directory / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n{body}\n"
    )


def _use_home(monkeypatch, home):
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    return home


class TestParseSkillMarkdown:
    def test_folded_description_is_one_line(self):
        parsed = _parse_skill_markdown(FOLDED_SKILL)
        assert parsed is not None
        assert parsed[0] == "triage"
        assert parsed[1] == "Sort incoming mail into buckets"
        assert "\n" not in parsed[1]

    def test_literal_description_joins_sentences(self):
        parsed = _parse_skill_markdown(LITERAL_SKILL)
        assert parsed is not None
        assert parsed[1] == (
            "Sort incoming mail into buckets. Use when the user asks to triage an inbox."
        )

    def test_one_line_description_is_unchanged(self):
        parsed = _parse_skill_markdown(
            "---\nname: triage\ndescription: Sort incoming mail into buckets\n---\n# Triage\n"
        )
        assert parsed is not None
        assert parsed[1] == "Sort incoming mail into buckets"

    def test_blank_or_missing_description_is_rejected(self):
        assert _parse_skill_markdown("---\nname: triage\ndescription: ''\n---\n# Triage\n") is None
        assert _parse_skill_markdown("---\nname: triage\ndescription: >\n---\n# Triage\n") is None
        assert _parse_skill_markdown('---\nname: triage\ndescription: "   "\n---\n# Triage\n') is None
        assert _parse_skill_markdown("---\nname: triage\n---\n# Triage\n") is None


class TestLoadSystemPromptSkills:
    def test_missing_skills_folder_returns_default_and_creates_nothing(self, monkeypatch, tmp_path):
        home = _use_home(monkeypatch, tmp_path / "home")

        assert load_system_prompt() == DEFAULT_SYSTEM_PROMPT
        assert not (home / ".cast").exists()

    def test_empty_skills_folder_returns_existing_prompt(self, monkeypatch, tmp_path):
        home = _use_home(monkeypatch, tmp_path / "home")
        builder = home / ".cast" / "builder"
        (builder / "skills").mkdir(parents=True)
        (builder / "instructions.md").write_text("Custom system prompt")

        assert load_system_prompt() == "Custom system prompt"
        assert not (home / ".cast" / "agents").exists()

    def test_one_skill_appends_name_description_and_body(self, monkeypatch, tmp_path):
        home = _use_home(monkeypatch, tmp_path / "home")
        _skill(
            home / ".cast" / "builder" / "skills" / "ignored-dir-name",
            "cast-tool-style",
            "How this team writes a Python tool for a Cast agent",
            "When scaffolding a custom tool, keep it small.",
        )

        prompt = load_system_prompt()
        assert prompt.startswith(DEFAULT_SYSTEM_PROMPT.rstrip("\n"))
        assert prompt[len(DEFAULT_SYSTEM_PROMPT.rstrip("\n")):] == (
            "\n\n## Skills\n"
            "\n"
            "Follow these skills while you help the developer create or edit a Cast agent.\n"
            "They describe how you do the work. Do not copy a skill into\n"
            "~/.cast/agents/<name>/ unless the developer asks.\n"
            "\n"
            "### cast-tool-style\n"
            "How this team writes a Python tool for a Cast agent\n"
            "\n"
            "When scaffolding a custom tool, keep it small.\n"
        )
        assert not (home / ".cast" / "agents").exists()

    def test_two_skills_sort_by_frontmatter_name(self, monkeypatch, tmp_path):
        home = _use_home(monkeypatch, tmp_path / "home")
        skills = home / ".cast" / "builder" / "skills"
        _skill(skills / "a-dir", "zeta", "Zeta skill", "Zeta body.")
        _skill(skills / "z-dir", "alpha", "Alpha skill", "Alpha body.")

        prompt = load_system_prompt()
        assert prompt.index("### alpha") < prompt.index("### zeta")
        assert "Alpha body." in prompt
        assert "Zeta body." in prompt

    def test_folded_and_literal_descriptions_load_as_one_line(self, monkeypatch, tmp_path, capsys):
        home = _use_home(monkeypatch, tmp_path / "home")
        skills = home / ".cast" / "builder" / "skills"
        folded = skills / "triage"
        literal = skills / "inbox"
        folded.mkdir(parents=True)
        literal.mkdir(parents=True)
        (folded / "SKILL.md").write_text(FOLDED_SKILL)
        (literal / "SKILL.md").write_text(LITERAL_SKILL)

        prompt = load_system_prompt()
        err = capsys.readouterr().err

        assert "### triage\nSort incoming mail into buckets\n" in prompt
        assert (
            "### inbox\nSort incoming mail into buckets. "
            "Use when the user asks to triage an inbox.\n"
        ) in prompt
        assert "invalid frontmatter" not in err
        assert not (home / ".cast" / "agents").exists()

    def test_blank_description_is_skipped(self, monkeypatch, tmp_path, capsys):
        home = _use_home(monkeypatch, tmp_path / "home")
        skills = home / ".cast" / "builder" / "skills"
        blank = skills / "blank"
        blank.mkdir(parents=True)
        (blank / "SKILL.md").write_text("---\nname: triage\ndescription: ''\n---\nDo not keep this.\n")

        prompt = load_system_prompt()
        err = capsys.readouterr().err

        assert "Do not keep this." not in prompt
        assert "invalid frontmatter" in err
        assert not (home / ".cast" / "agents").exists()

    def test_invalid_frontmatter_is_skipped(self, monkeypatch, tmp_path, capsys):
        home = _use_home(monkeypatch, tmp_path / "home")
        skills = home / ".cast" / "builder" / "skills"
        _skill(skills / "good-skill", "good-skill", "The valid one", "Keep this body.")
        bad = skills / "bad-skill"
        bad.mkdir(parents=True)
        (bad / "SKILL.md").write_text("---\nname: Bad Skill\ndescription: nope\n---\nDo not keep this.\n")
        missing = skills / "missing-skill"
        missing.mkdir()

        prompt = load_system_prompt()
        err = capsys.readouterr().err
        assert "Keep this body." in prompt
        assert "Do not keep this." not in prompt
        assert "bad-skill" in err
        assert "invalid frontmatter" in err
        assert "missing-skill" in err
        assert "SKILL.md is missing" in err
        assert not (home / ".cast" / "agents").exists()

    def test_startup_creates_skills_dir_without_instructions(self, monkeypatch, tmp_path):
        home = _use_home(monkeypatch, tmp_path / "home")

        agent = BuilderAgent()

        assert (home / ".cast" / "builder" / "skills").is_dir()
        assert not (home / ".cast" / "builder" / "instructions.md").exists()
        assert agent.system_prompt == DEFAULT_SYSTEM_PROMPT
        assert not (home / ".cast" / "agents").exists()

    def test_edit_context_follows_the_builder_prompt(self, monkeypatch, tmp_path):
        home = _use_home(monkeypatch, tmp_path / "home")
        _skill(
            home / ".cast" / "builder" / "skills" / "alpha",
            "alpha",
            "Alpha skill",
            "Alpha body.",
        )
        agent = BuilderAgent()

        agent.load_agent_for_editing("builder-skills-test-missing-agent")

        assert isinstance(agent.messages[0], SystemMessage)
        assert "### alpha" in agent.messages[0].content
        assert "Alpha body." in agent.messages[0].content
        assert any(
            isinstance(message, SystemMessage) and "editing the existing agent" in message.content
            for message in agent.messages[1:]
        )
        assert not (home / ".cast" / "agents").exists()

    def test_skill_added_after_startup_is_not_in_that_process(self, monkeypatch, tmp_path):
        home = _use_home(monkeypatch, tmp_path / "home")
        agent = BuilderAgent()
        assert "## Skills" not in agent.system_prompt

        _skill(
            home / ".cast" / "builder" / "skills" / "late",
            "late",
            "Added during the session",
            "Too late for this process.",
        )

        assert "Too late for this process." not in agent.system_prompt
        assert "Too late for this process." in load_system_prompt()

    @pytest.mark.asyncio
    async def test_process_message_sends_the_skill_prompt_first(self, monkeypatch, tmp_path):
        home = _use_home(monkeypatch, tmp_path / "home")
        _skill(
            home / ".cast" / "builder" / "skills" / "alpha",
            "alpha",
            "Alpha skill",
            "Alpha body.",
        )
        agent = BuilderAgent()

        await agent.process_message("hello")

        assert isinstance(agent.messages[0], SystemMessage)
        assert agent.messages[0].content == agent.system_prompt
        assert "Alpha body." in agent.messages[0].content
        assert not (home / ".cast" / "agents").exists()
