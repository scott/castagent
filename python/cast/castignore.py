"""Match agent paths against a .castignore file.

The rules follow gitignore closely enough for release snapshots:
blank lines and comments are skipped, "!" negates a pattern, a trailing
slash matches directories only, a pattern with no slash matches in any
directory, and a pattern that contains a slash is relative to the agent
root. A file inside an ignored directory stays ignored.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass(frozen=True)
class IgnoreRule:
    regex: re.Pattern[str]
    directory_only: bool
    negated: bool


def load_rules(agent_path: Path) -> list[IgnoreRule]:
    """Return rules from <agent>/.castignore. A missing file ignores nothing."""
    path = agent_path / ".castignore"
    if not path.is_file():
        return []
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return []
    return parse_rules(text)


def parse_rules(text: str) -> list[IgnoreRule]:
    rules: list[IgnoreRule] = []
    for raw in text.splitlines():
        line = _clean_line(raw)
        if line is None:
            continue
        negated = line.startswith("!")
        body = line[1:] if negated else line
        if not body:
            continue
        directory_only = body.endswith("/")
        if directory_only:
            body = body[:-1]
        anchored = body.startswith("/") or _has_unescaped_slash(body)
        if body.startswith("/"):
            body = body[1:]
        body = _unescape(body)
        if not body:
            continue
        rules.append(IgnoreRule(
            regex=_glob_to_regex(body, anchored),
            directory_only=directory_only,
            negated=negated,
        ))
    return rules


def is_ignored(rel: str, is_dir: bool, rules: list[IgnoreRule]) -> bool:
    """True when rel (posix, no leading slash) matches the ignore rules."""
    if not rules:
        return False
    rel = rel.replace("\\", "/").lstrip("/")
    if not rel or rel == ".":
        return False
    parts = [part for part in rel.split("/") if part not in ("", ".")]
    if not parts or ".." in parts:
        return False
    rel = "/".join(parts)
    for index in range(1, len(parts)):
        parent = "/".join(parts[:index])
        if _last_match(parent, True, rules) is True:
            return True
    return _last_match(rel, is_dir, rules) is True


def _last_match(rel: str, is_dir: bool, rules: list[IgnoreRule]) -> Optional[bool]:
    matched: Optional[bool] = None
    for rule in rules:
        if rule.directory_only and not is_dir:
            continue
        if rule.regex.match(rel):
            matched = not rule.negated
    return matched


def _clean_line(line: str) -> Optional[str]:
    if line.startswith("\ufeff"):
        line = line[1:]
    line = _rstrip_trailing_space(line)
    if not line or line.startswith("#"):
        return None
    return line


def _rstrip_trailing_space(line: str) -> str:
    while line.endswith(" ") and not line.endswith("\\ "):
        line = line[:-1]
    if line.endswith("\\ "):
        line = line[:-2] + " "
    return line


def _has_unescaped_slash(text: str) -> bool:
    index = 0
    while index < len(text):
        if text[index] == "\\" and index + 1 < len(text):
            index += 2
            continue
        if text[index] == "/":
            return True
        index += 1
    return False


def _unescape(text: str) -> str:
    chars: list[str] = []
    index = 0
    while index < len(text):
        if text[index] == "\\" and index + 1 < len(text):
            chars.append(text[index + 1])
            index += 2
            continue
        chars.append(text[index])
        index += 1
    return "".join(chars)


def _glob_to_regex(pattern: str, anchored: bool) -> re.Pattern[str]:
    parts = ["^"]
    if not anchored:
        # A pattern with no slash matches in any directory.
        parts.append("(?:.*/)?")
    index = 0
    while index < len(pattern):
        if pattern.startswith("**/", index):
            parts.append("(?:.*/)?")
            index += 3
            continue
        if pattern.startswith("**", index):
            parts.append(".*")
            index += 2
            continue
        char = pattern[index]
        if char == "*":
            parts.append("[^/]*")
        elif char == "?":
            parts.append("[^/]")
        elif char == "[":
            end = pattern.find("]", index + 1)
            if end == -1:
                parts.append(re.escape(char))
            else:
                body = pattern[index + 1:end]
                if body.startswith("!"):
                    body = "^" + body[1:]
                elif body.startswith("^"):
                    body = "\\^" + body[1:]
                parts.append("[" + body + "]")
                index = end + 1
                continue
        else:
            parts.append(re.escape(char))
        index += 1
    parts.append("$")
    return re.compile("".join(parts))
