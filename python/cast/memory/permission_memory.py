"""Drop memories that restate an old harness.permissions level.

A session with bash set to deny can store a boundary such as
"The bash tool is currently set to deny". After
`cast update --permission bash=always-allow` and a restart, that row
must not be injected into the prompt. The live level wins.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from functools import lru_cache
from typing import Any

from ..harness.permissions import (
    ALWAYS_ALLOW,
    ASK,
    BUILTIN_TOOL_NAMES,
    DENY,
    WILDCARD_SCOPE,
    PermissionGate,
)

# Longer tokens first so "always-allow" is not cut short.
_LEVEL_RE = r"always-allow|always\s+allow|disabled|denied|blocked|deny|ask"

_LEVELS = {
    "always-allow": ALWAYS_ALLOW,
    "always allow": ALWAYS_ALLOW,
    "ask": ASK,
    "deny": DENY,
    "denied": DENY,
    "disabled": DENY,
    "blocked": DENY,
}

# Model-facing names that share a harness.permissions key.
_ALIASES = {
    "bash": ("bash_tool",),
    "read": ("read_tool",),
    "glob": ("glob_tool",),
}

_DENY_RESULT = re.compile(
    r"Permission denied for (?P<tool>[A-Za-z0-9_]+)\.\s+This tool is set to deny\b",
    re.IGNORECASE,
)
_ASK_RESULT = re.compile(
    r"Permission denied for (?P<tool>[A-Za-z0-9_]+)\.\s+Approval is required\b",
    re.IGNORECASE,
)


def _canonical_level(raw: str) -> str | None:
    key = re.sub(r"\s+", " ", raw.strip().lower())
    return _LEVELS.get(key)


def _effective_level(gate: PermissionGate, tool: str) -> str:
    """Level the gate enforces. An unknown configured value fails closed."""
    level = gate.action_for(tool)
    if level is None:
        return DENY
    return level


def _catalog(gate: PermissionGate) -> list[tuple[str, tuple[str, ...]]]:
    keys: list[str] = []
    for name in sorted(BUILTIN_TOOL_NAMES):
        keys.append(name)
    for key in gate.permissions:
        if isinstance(key, str) and key and key != WILDCARD_SCOPE and key not in keys:
            keys.append(key)
    catalog: list[tuple[str, tuple[str, ...]]] = []
    for key in keys:
        names = [key]
        for alias in _ALIASES.get(key, ()):
            if alias not in names:
                names.append(alias)
        catalog.append((key, tuple(names)))
    return catalog


def _canonical_tool(name: str, catalog: list[tuple[str, tuple[str, ...]]]) -> str | None:
    lowered = name.lower()
    for tool, aliases in catalog:
        if lowered == tool.lower() or any(lowered == alias.lower() for alias in aliases):
            return tool
    return None


@lru_cache(maxsize=128)
def _patterns(aliases: tuple[str, ...]) -> tuple[tuple[re.Pattern[str], str | None], ...]:
    """Patterns that bind one tool name to a permission level.

    The fixed level is set when the wording does not contain the level
    word, as in the ask-tool result ("Approval is required").
    """
    ordered = sorted(aliases, key=len, reverse=True)
    alias_re = "|".join(re.escape(alias) for alias in ordered)
    ref = rf"(?:{alias_re})(?:\s+tool)?"
    level = rf"(?P<level>{_LEVEL_RE})"
    raw: list[tuple[str, str | None]] = [
        (
            rf"\b(?:the\s+)?{ref}\b\s+(?:is|was)(?:\s+currently)?(?:\s+set\s+to)?\s+{level}\b",
            None,
        ),
        (
            rf"\b(?:the\s+)?{ref}\b\s+currently\s+{level}\b",
            None,
        ),
        (
            # "The bash tool, which is currently set to deny"
            rf"\b(?:the\s+)?{ref}\b(?:\s*,\s*which)?\s+(?:is\s+|was\s+)?(?:currently\s+)?set\s+to\s+{level}\b",
            None,
        ),
        (
            rf"\bset(?:ting)?\s+(?:the\s+)?{ref}\s+to\s+{level}\b",
            None,
        ),
        (
            # "bash=deny" or "bash: deny", not "read: deny this request".
            rf"\b{ref}\s*[=:]\s*{level}\b(?!\s+[A-Za-z])",
            None,
        ),
        (
            rf"\bpermissions?\s+(?:for\s+|of\s+)(?:the\s+)?{ref}\b"
            rf"(?:\s+\w+){{0,4}}?\s+(?:is|are|=|:)\s+(?:currently\s+)?(?:set\s+to\s+)?{level}\b",
            None,
        ),
        (
            rf"\b{ref}\s+permissions?(?:\s+level)?\s+(?:is|are|=|:)\s+"
            rf"(?:currently\s+)?(?:set\s+to\s+)?{level}\b",
            None,
        ),
        (
            rf"\bPermission denied for {ref}\.\s+This tool is set to (?P<level>deny)\b",
            None,
        ),
        (
            rf"\bPermission denied for {ref}\.\s+Approval is required\b",
            ASK,
        ),
    ]
    return tuple((re.compile(pattern, re.IGNORECASE), fixed) for pattern, fixed in raw)


def permission_claims(text: str, gate: PermissionGate) -> list[tuple[str, str]]:
    """Tool and level pairs this text states as the current permission."""
    if not text:
        return []
    catalog = _catalog(gate)
    found: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()

    def add(tool: str, level: str) -> None:
        item = (tool, level)
        if item not in seen:
            seen.add(item)
            found.append(item)

    for tool, aliases in catalog:
        for pattern, fixed in _patterns(aliases):
            for match in pattern.finditer(text):
                if fixed is not None:
                    level = fixed
                else:
                    parsed = _canonical_level(match.group("level"))
                    if parsed is None:
                        continue
                    level = parsed
                add(tool, level)

    for pattern, fixed_level in ((_DENY_RESULT, DENY), (_ASK_RESULT, ASK)):
        for match in pattern.finditer(text):
            named = _canonical_tool(match.group("tool"), catalog)
            if named is None:
                continue
            add(named, fixed_level)
    return found


def _conflicts(text: str, gate: PermissionGate) -> bool:
    for tool, level in permission_claims(text, gate):
        if _effective_level(gate, tool) != level:
            return True
    return False


def _boilerplate(sentence: str, tool: str) -> bool:
    """Sentences from permission_denied_message for this tool."""
    name = re.escape(tool)
    patterns = (
        rf"^(?:Error:\s*)?Permission denied for {name}\.?$",
        r"^This tool is set to deny\b.*$",
        r"^Approval is required\b.*$",
    )
    return any(re.match(pattern, sentence, re.IGNORECASE) for pattern in patterns)


def without_stale_permission_claims(content: str, gate: PermissionGate) -> str | None:
    """Return content with stale permission sentences removed.

    None means the highlight should be deleted. The original string is
    returned when nothing contradicts the live gate.
    """
    if not content or not content.strip():
        return content

    catalog = _catalog(gate)
    stale_tools: set[str] = set()
    for pattern, level in ((_DENY_RESULT, DENY), (_ASK_RESULT, ASK)):
        for match in pattern.finditer(content):
            tool = _canonical_tool(match.group("tool"), catalog)
            if tool is None:
                continue
            if _effective_level(gate, tool) != level:
                stale_tools.add(tool)

    parts = re.split(r"(?<=[.!?])\s+|\n+", content.strip())
    kept: list[str] = []
    removed = False
    for part in parts:
        text = part.strip()
        if not text:
            continue
        if _conflicts(text, gate) or any(_boilerplate(text, tool) for tool in stale_tools):
            removed = True
            continue
        kept.append(text)
    if not removed:
        return content
    if not kept:
        return None
    return " ".join(kept)


def format_current_levels(permissions: Any) -> str:
    """One sentence listing live harness.permissions, or empty when unset."""
    if not isinstance(permissions, Mapping) or not permissions:
        return ""
    gate = PermissionGate(permissions)
    parts: list[str] = []
    for tool in permissions:
        if not isinstance(tool, str) or not tool.strip():
            continue
        level = gate.action_for(tool) or DENY
        parts.append(f"{tool}={level}")
    if not parts:
        return ""
    return "Current levels: " + ", ".join(parts) + "."
