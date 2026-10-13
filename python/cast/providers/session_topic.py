"""One-line session topics from the agent's own model.

The completion sits next to the provider registry so tests can pass a
fake provider. A missing key, a model that fails to build, or a call
error returns None. Callers must not persist that.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Optional, Sequence

from .registry import get_provider

TOPIC_CHAR_LIMIT = 60
TRANSCRIPT_CHAR_BUDGET = 4000
EARLY_TURNS = 4
LATE_TURNS = 4

TOPIC_SYSTEM_PROMPT = (
    "Label this conversation with a short topic.\n"
    "Reply with one line only, about 60 characters.\n"
    "No markdown, no quotes, and do not start with \"Topic:\".\n"
    "Name the subject. Do not recap the exchange."
)

_TOPIC_PREFIX = re.compile(r"^topic\s*:\s*", re.IGNORECASE)


def _collapse(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def sanitize_topic(raw: Any, limit: int = TOPIC_CHAR_LIMIT) -> str:
    """Collapse whitespace, strip a leading 'Topic:', cut to about 60 characters."""
    if not isinstance(raw, str):
        return ""
    text = _collapse(raw)
    while True:
        stripped = _TOPIC_PREFIX.sub("", text, count=1).strip()
        if stripped == text:
            break
        text = stripped
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'":
        text = text[1:-1].strip()
        text = _TOPIC_PREFIX.sub("", text, count=1).strip()
    if len(text) > limit:
        return text[: limit - 1] + "…"
    return text


def preview_line(text: Optional[str], limit: int = TOPIC_CHAR_LIMIT) -> str:
    """Collapse whitespace and cut. Does not strip a 'Topic:' prefix."""
    if not isinstance(text, str):
        return ""
    one = _collapse(text)
    if len(one) > limit:
        return one[: limit - 1] + "…"
    return one


def session_display_title(
    *,
    name: Optional[str] = None,
    topic: Optional[str] = None,
    first_user_message: Optional[str] = None,
) -> str:
    """name, then stored topic, then the first user message, then (untitled)."""
    if isinstance(name, str) and name.strip():
        return name.strip()
    topic_line = preview_line(topic)
    if topic_line:
        return topic_line
    first = preview_line(first_user_message)
    if first:
        return first
    return "(untitled)"


def topic_is_fresh(
    topic: Optional[str],
    topic_message_count: Optional[int],
    message_count: Optional[int],
) -> bool:
    """Fresh when the topic is non-empty and was taken at this message_count."""
    if not isinstance(topic, str) or not topic.strip():
        return False
    if topic_message_count is None or message_count is None:
        return False
    try:
        return int(topic_message_count) == int(message_count)
    except (TypeError, ValueError):
        return False


def _turn(message: Any) -> tuple[str, str]:
    if isinstance(message, dict):
        role = str(message.get("role") or "")
        text = message.get("text") or ""
    else:
        role = str(getattr(message, "role", "") or "")
        text = getattr(message, "text", "") or ""
    if not isinstance(text, str):
        text = str(text)
    label = "User" if role == "user" else "Assistant"
    return label, _collapse(text)


def bounded_transcript(
    messages: Sequence[Any],
    *,
    budget: int = TRANSCRIPT_CHAR_BUDGET,
    early: int = EARLY_TURNS,
    late: int = LATE_TURNS,
) -> str:
    """Early turns plus the latest turns, kept under a character budget."""
    turns = []
    for message in messages:
        label, text = _turn(message)
        if text:
            turns.append((label, text))
    if not turns or budget < 1:
        return ""
    gap_at = None
    omitted = 0
    if late > 0 and len(turns) > early + late:
        selected = turns[:early] + turns[-late:]
        gap_at = early
        omitted = len(turns) - early - late
    else:
        selected = turns

    def render(max_each: int) -> str:
        lines = []
        for index, (label, text) in enumerate(selected):
            if gap_at is not None and index == gap_at:
                lines.append(f"... {omitted} earlier turns omitted ...")
            if len(text) > max_each:
                text = text[: max(1, max_each - 1)] + "…"
            lines.append(f"{label}: {text}")
        return "\n".join(lines)

    # Largest per-turn cap that still fits. Short chats stay uncut.
    best = None
    lo, hi = 1, max(1, budget)
    while lo <= hi:
        mid = (lo + hi) // 2
        rendered = render(mid)
        if len(rendered) <= budget:
            best = rendered
            lo = mid + 1
        else:
            hi = mid - 1
    if best is not None:
        return best
    clipped = render(1)
    if len(clipped) <= budget:
        return clipped
    return clipped[:budget]


def resolve_agent_model(agent_name: str, agents_dir: Path) -> Optional[str]:
    """brain.model from ~/.cast/agents/<name>/agent.yaml. Missing dir or file skips."""
    if not isinstance(agent_name, str):
        return None
    name = agent_name.strip()
    if not name or name in {".", ".."} or "/" in name or "\\" in name:
        return None
    root = Path(agents_dir).resolve()
    agent_dir = (root / name).resolve()
    try:
        agent_dir.relative_to(root)
    except ValueError:
        return None
    yaml_path = agent_dir / "agent.yaml"
    if not agent_dir.is_dir() or not yaml_path.is_file():
        return None
    try:
        from cast.agent.base import AgentConfig
        model = AgentConfig(str(agent_dir)).model
    except Exception:
        return None
    if not isinstance(model, str) or not model.strip():
        return None
    return model.strip()


def _message_text(response: Any) -> str:
    content = getattr(response, "content", response)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                text = block.get("text") or block.get("content") or ""
                if isinstance(text, str):
                    parts.append(text)
        return " ".join(parts)
    if content is None:
        return ""
    return str(content)


def complete_session_topic(
    model: str,
    transcript: str,
    *,
    provider: Any = None,
) -> Optional[str]:
    """One completion, no tools. None when the provider or the call cannot be used.

    ``provider`` is the registry record (or a fake with the same two methods).
    When it is omitted, ``get_provider(model)`` selects the agent's model.
    A missing key leaves the LLM unset and this returns None.
    """
    if not isinstance(model, str) or not model.strip():
        return None
    if not isinstance(transcript, str) or not transcript.strip():
        return None
    try:
        record = provider if provider is not None else get_provider(model)
    except Exception:
        return None
    if record is None or not record.is_available():
        return None
    try:
        llm = record.create_llm(model=model)
    except Exception:
        return None
    if llm is None:
        return None
    try:
        from langchain_core.messages import HumanMessage, SystemMessage
        response = llm.invoke([
            SystemMessage(content=TOPIC_SYSTEM_PROMPT),
            HumanMessage(content=transcript),
        ])
    except Exception:
        return None
    topic = sanitize_topic(_message_text(response))
    return topic or None
