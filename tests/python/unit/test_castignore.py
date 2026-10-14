"""Tests for .castignore matching used by release snapshots."""

from cast.castignore import is_ignored, parse_rules


DEFAULT = """\
.cast/versions/
cast.db
*.log
.env
__pycache__/
memory/memory.db
memory/memory.db-journal
memory/memory.db-wal
memory/memory.db-shm
/Dockerfile
/docker-compose.yml
/requirements.txt
/.cast-runtime/
"""


def _ignored(text: str, rel: str, is_dir: bool = False) -> bool:
    return is_ignored(rel, is_dir, parse_rules(text))


def test_default_rules_skip_runtime_state():
    assert _ignored(DEFAULT, "debug.log")
    assert _ignored(DEFAULT, "tools/debug.log")
    assert _ignored(DEFAULT, ".env")
    assert _ignored(DEFAULT, "nested/.env")
    assert _ignored(DEFAULT, "cast.db")
    assert _ignored(DEFAULT, "memory/memory.db")
    assert _ignored(DEFAULT, "memory/memory.db-wal")
    assert _ignored(DEFAULT, ".cast/versions", is_dir=True)
    assert _ignored(DEFAULT, ".cast/versions/001.tar.gz")
    assert _ignored(DEFAULT, "pkg/__pycache__", is_dir=True)
    assert _ignored(DEFAULT, "pkg/__pycache__/x.pyc")


def test_default_rules_skip_docker_deploy_artifacts():
    assert _ignored(DEFAULT, "Dockerfile")
    assert _ignored(DEFAULT, "docker-compose.yml")
    assert _ignored(DEFAULT, "requirements.txt")
    assert _ignored(DEFAULT, ".cast-runtime", is_dir=True)
    assert _ignored(DEFAULT, ".cast-runtime/cast/runtime.py")
    assert not _ignored(DEFAULT, "tools/requirements.txt")
    assert not _ignored(DEFAULT, "tools/Dockerfile")
    assert not _ignored(DEFAULT, "pkg/docker-compose.yml")


def test_default_rules_keep_project_files():
    assert not _ignored(DEFAULT, "bb-prompt.md")
    assert not _ignored(DEFAULT, "instructions.md")
    assert not _ignored(DEFAULT, "agent.yaml")
    assert not _ignored(DEFAULT, "skills/triage/SKILL.md")
    assert not _ignored(DEFAULT, "tools/bb.py")
    assert not _ignored(DEFAULT, "memory/user.md")
    assert not _ignored(DEFAULT, "memory/memory.db.bak")
    assert not _ignored(DEFAULT, ".castignore")
    assert not _ignored(DEFAULT, "pkg/keep.py")
    # A file named __pycache__ is not the directory pattern.
    assert not _ignored(DEFAULT, "__pycache__", is_dir=False)


def test_comments_and_blank_lines_are_skipped():
    rules = parse_rules("# comment\n\n*.log\n")
    assert is_ignored("a.log", False, rules)
    assert not is_ignored("a.txt", False, rules)


def test_negation_reincludes_a_file():
    text = "*.log\n!keep.log\n"
    assert _ignored(text, "debug.log")
    assert not _ignored(text, "keep.log")
    assert not _ignored(text, "dir/keep.log")


def test_parent_directory_exclusion_wins():
    text = "__pycache__/\n!__pycache__/keep.py\n"
    assert _ignored(text, "__pycache__", is_dir=True)
    assert _ignored(text, "__pycache__/keep.py")


def test_double_star_matches_nested_files():
    text = "secrets/**\n"
    assert _ignored(text, "secrets/token")
    assert _ignored(text, "secrets/nested/token")
    assert not _ignored(text, "other/token")


def test_anchored_pattern_does_not_match_elsewhere():
    text = "/secret.txt\n"
    assert _ignored(text, "secret.txt")
    assert not _ignored(text, "nested/secret.txt")


def test_empty_rules_ignore_nothing():
    assert not is_ignored("memory/memory.db", False, [])
    assert not is_ignored(".env", False, parse_rules(""))
