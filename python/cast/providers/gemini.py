"""Google Gemini on the shared OpenAI-compatible class.

Gemini 3 and 4 put ``thought_signature`` under ``extra_content`` on each
tool call and reject the next request unless that object is echoed.
langchain-openai 1.7.2 drops the field (upstream langchain#37356). This
subclass writes the object onto the assistant message and reads it back
in ``_get_request_payload``. Nothing is stored on the client, so
concurrent streams on one instance keep their own signatures. It does
not invent a signature.
"""

from __future__ import annotations

import copy
from typing import Any

from langchain_core.messages import AIMessage
from langchain_openai import ChatOpenAI

from .openai_compatible import OpenAICompatibleProvider

# Stream chunks key this by tool-call index. A finished response keys it
# by tool-call id. Chunk merge keeps both next to the tool-call ids.
_EXTRA_KEY = "gemini_tool_call_extra"
# Index to id, recorded on the chunk that carried the id. The merged
# message still has it after tool-call chunks are dropped.
_INDEX_KEY = "gemini_tool_call_index"
_SKIP_SIGNATURE = "skip_thought_signature_validator"


def chat_cls():
    """Gemini chat class, looked up at call time so tests can patch it."""
    return GeminiChatOpenAI


def _usable_extra(extra: Any) -> dict | None:
    if not isinstance(extra, dict) or not extra:
        return None
    signature = (extra.get("google") or {}).get("thought_signature")
    if signature == _SKIP_SIGNATURE:
        return None
    return copy.deepcopy(extra)


def _index_key(index: Any) -> str | None:
    if isinstance(index, bool) or not isinstance(index, int):
        return None
    return str(index)


def _stream_maps(chunk: dict) -> tuple[dict, dict]:
    """Extras and ids from one stream chunk. Neither map needs the other."""
    extras: dict[str, dict] = {}
    indexes: dict[str, dict] = {}
    for choice in chunk.get("choices") or []:
        delta = (choice or {}).get("delta") or {}
        if not isinstance(delta, dict):
            continue
        for tool_call in delta.get("tool_calls") or []:
            if not isinstance(tool_call, dict):
                continue
            key = _index_key(tool_call.get("index"))
            tool_id = tool_call.get("id") or None
            extra = _usable_extra(tool_call.get("extra_content"))
            if key is not None and isinstance(tool_id, str) and tool_id:
                indexes[key] = {"id": tool_id}
            if extra is None:
                continue
            if key is not None:
                extras[key] = extra
            elif isinstance(tool_id, str) and tool_id:
                extras[tool_id] = extra
    return extras, indexes


def _response_extras(response: Any) -> list[dict[str, dict]]:
    """One id-keyed map per choice. Order matches ``_create_chat_result``."""
    if isinstance(response, dict):
        data = response
    elif hasattr(response, "model_dump"):
        data = response.model_dump()
    else:
        return []
    found = []
    for choice in data.get("choices") or []:
        extras: dict[str, dict] = {}
        message = (choice or {}).get("message") or {}
        for tool_call in message.get("tool_calls") or []:
            if not isinstance(tool_call, dict):
                continue
            extra = _usable_extra(tool_call.get("extra_content"))
            tool_id = tool_call.get("id")
            if extra is not None and isinstance(tool_id, str) and tool_id:
                extras[tool_id] = extra
        found.append(extras)
    return found


def _put_map(message: Any, key: str, value: dict) -> None:
    if not value:
        return
    current = message.additional_kwargs.get(key)
    if isinstance(current, dict):
        current.update(value)
    else:
        message.additional_kwargs[key] = dict(value)


def _extras_by_tool_id(message: AIMessage) -> dict[str, dict]:
    """Join signatures stored on the message to tool-call ids."""
    raw = message.additional_kwargs.get(_EXTRA_KEY) or {}
    if not isinstance(raw, dict):
        return {}
    call_ids = [
        tool_call.get("id")
        for tool_call in (message.tool_calls or [])
        if isinstance(tool_call, dict) and tool_call.get("id")
    ]
    known_ids = set(call_ids)
    found: dict[str, dict] = {}
    by_index: dict[int, dict] = {}
    for key, extra in raw.items():
        usable = extra if isinstance(extra, dict) else None
        if _usable_extra(usable) is None:
            continue
        if isinstance(key, str) and key in known_ids:
            found[key] = usable
            continue
        if isinstance(key, int):
            by_index[key] = usable
            continue
        if isinstance(key, str) and key.isdigit():
            by_index[int(key)] = usable
            continue
        if isinstance(key, str):
            found[key] = usable

    index_to_id: dict[int, str] = {}
    for tool_chunk in getattr(message, "tool_call_chunks", None) or []:
        if not isinstance(tool_chunk, dict):
            continue
        key = _index_key(tool_chunk.get("index"))
        tool_id = tool_chunk.get("id")
        if key is not None and isinstance(tool_id, str) and tool_id:
            index_to_id[int(key)] = tool_id
    raw_index = message.additional_kwargs.get(_INDEX_KEY) or {}
    if isinstance(raw_index, dict):
        for key, value in raw_index.items():
            tool_id = value.get("id") if isinstance(value, dict) else value
            if not isinstance(tool_id, str) or not tool_id:
                continue
            try:
                index_to_id[int(key)] = tool_id
            except (TypeError, ValueError):
                continue
    for index, extra in by_index.items():
        tool_id = index_to_id.get(index)
        if tool_id is None and 0 <= index < len(call_ids):
            tool_id = call_ids[index]
        if isinstance(tool_id, str) and tool_id:
            found.setdefault(tool_id, extra)
    return found


class GeminiChatOpenAI(ChatOpenAI):
    """ChatOpenAI that replays Gemini ``extra_content`` from the message."""

    def _convert_chunk_to_generation_chunk(
        self,
        chunk: dict,
        default_chunk_class: type,
        base_generation_info: dict | None,
    ):
        generation = super()._convert_chunk_to_generation_chunk(
            chunk, default_chunk_class, base_generation_info
        )
        if generation is None or not isinstance(chunk, dict):
            return generation
        extras, indexes = _stream_maps(chunk)
        _put_map(generation.message, _EXTRA_KEY, extras)
        _put_map(generation.message, _INDEX_KEY, indexes)
        return generation

    def _create_chat_result(self, response, generation_info=None):
        result = super()._create_chat_result(response, generation_info)
        for generation, extras in zip(result.generations, _response_extras(response)):
            _put_map(generation.message, _EXTRA_KEY, extras)
        return result

    def _get_request_payload(self, input_, *, stop=None, **kwargs):
        source = self._convert_input(input_).to_messages()
        payload = super()._get_request_payload(input_, stop=stop, **kwargs)
        outgoing = payload.get("messages")
        if not isinstance(outgoing, list) or len(outgoing) != len(source):
            return payload
        for message, encoded in zip(source, outgoing):
            if not isinstance(message, AIMessage) or not isinstance(encoded, dict):
                continue
            if encoded.get("role") != "assistant":
                continue
            extras = _extras_by_tool_id(message)
            for tool_call in encoded.get("tool_calls") or []:
                if not isinstance(tool_call, dict):
                    continue
                extra = extras.get(tool_call.get("id"))
                if extra:
                    tool_call["extra_content"] = copy.deepcopy(extra)
        return payload


class GeminiProvider(OpenAICompatibleProvider):
    """Inference-provider object for the ``gemini/`` prefix."""

    def __init__(self):
        super().__init__("gemini", chat_factory=chat_cls)


provider = GeminiProvider()
