"""Google Gemini on the shared OpenAI-compatible class.

Gemini 3 and 4 put ``thought_signature`` under ``extra_content`` on each
tool call and reject the next request unless that object is echoed.
langchain-openai 1.7.2 drops the field (upstream langchain#37356). This
subclass keeps the signature, keyed by tool-call id, and writes it back
onto the matching assistant tool call. It does not invent a signature.
"""

from __future__ import annotations

import copy
from typing import Any

from langchain_openai import ChatOpenAI
from pydantic import PrivateAttr

from .openai_compatible import OpenAICompatibleProvider

_SKIP_SIGNATURE = "skip_thought_signature_validator"


def chat_cls():
    """Gemini chat class, looked up at call time so tests can patch it."""
    return GeminiChatOpenAI


class GeminiChatOpenAI(ChatOpenAI):
    """ChatOpenAI that replays Gemini ``extra_content`` on tool calls."""

    _gemini_extra_content: dict[str, dict] = PrivateAttr(default_factory=dict)
    _gemini_stream_ids: dict[int, str] = PrivateAttr(default_factory=dict)
    _gemini_pending_extra: dict[int, dict] = PrivateAttr(default_factory=dict)
    _gemini_stream_completion_id: str | None = PrivateAttr(default=None)

    def _remember_extra(self, tool_call_id: str | None, extra: Any) -> None:
        if not tool_call_id or not isinstance(extra, dict) or not extra:
            return
        signature = (extra.get("google") or {}).get("thought_signature")
        if signature == _SKIP_SIGNATURE:
            return
        self._gemini_extra_content[tool_call_id] = copy.deepcopy(extra)

    def _capture_response_extra(self, response: Any) -> None:
        if isinstance(response, dict):
            data = response
        elif hasattr(response, "model_dump"):
            data = response.model_dump()
        else:
            return
        for choice in data.get("choices") or []:
            message = (choice or {}).get("message") or {}
            for tool_call in message.get("tool_calls") or []:
                if isinstance(tool_call, dict):
                    self._remember_extra(tool_call.get("id"), tool_call.get("extra_content"))

    def _capture_stream_extra(self, chunk: dict) -> None:
        completion_id = chunk.get("id")
        if completion_id and completion_id != self._gemini_stream_completion_id:
            self._gemini_stream_completion_id = completion_id
            self._gemini_stream_ids.clear()
            self._gemini_pending_extra.clear()
        for choice in chunk.get("choices") or []:
            delta = (choice or {}).get("delta") or {}
            if not isinstance(delta, dict):
                continue
            for tool_call in delta.get("tool_calls") or []:
                if not isinstance(tool_call, dict):
                    continue
                index = tool_call.get("index")
                tool_id = tool_call.get("id") or None
                if tool_id and index is not None:
                    previous = self._gemini_stream_ids.get(index)
                    self._gemini_stream_ids[index] = tool_id
                    if previous == tool_id:
                        pending = self._gemini_pending_extra.pop(index, None)
                        if pending:
                            self._remember_extra(tool_id, pending)
                    else:
                        self._gemini_pending_extra.pop(index, None)
                extra = tool_call.get("extra_content")
                if not isinstance(extra, dict) or not extra:
                    continue
                key = tool_id or (self._gemini_stream_ids.get(index) if index is not None else None)
                if key:
                    self._remember_extra(key, extra)
                elif index is not None:
                    self._gemini_pending_extra[index] = copy.deepcopy(extra)

    def _convert_chunk_to_generation_chunk(
        self,
        chunk: dict,
        default_chunk_class: type,
        base_generation_info: dict | None,
    ):
        if isinstance(chunk, dict):
            self._capture_stream_extra(chunk)
        return super()._convert_chunk_to_generation_chunk(
            chunk, default_chunk_class, base_generation_info
        )

    def _create_chat_result(self, response, generation_info=None):
        self._capture_response_extra(response)
        return super()._create_chat_result(response, generation_info)

    def _get_request_payload(self, input_, *, stop=None, **kwargs):
        payload = super()._get_request_payload(input_, stop=stop, **kwargs)
        messages = payload.get("messages")
        if not isinstance(messages, list):
            return payload
        for message in messages:
            if not isinstance(message, dict) or message.get("role") != "assistant":
                continue
            for tool_call in message.get("tool_calls") or []:
                if not isinstance(tool_call, dict):
                    continue
                extra = self._gemini_extra_content.get(tool_call.get("id"))
                if extra:
                    tool_call["extra_content"] = copy.deepcopy(extra)
        return payload


class GeminiProvider(OpenAICompatibleProvider):
    """Inference-provider object for the ``gemini/`` prefix."""

    def __init__(self):
        super().__init__("gemini", chat_factory=chat_cls)


provider = GeminiProvider()
