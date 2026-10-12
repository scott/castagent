"""Per-session model context. A connection id starts empty; resume seeds once."""

import asyncio
import os
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from langchain_core.messages import AIMessage, AIMessageChunk

from cast.agent.base import AgentConfig
from cast.agent.runtime import RuntimeAgent
from cast.runtime import A2AServer


@pytest.fixture
def temp_agent_dir(tmp_path):
    agent_dir = tmp_path / "demo-agent"
    agent_dir.mkdir()
    (agent_dir / "agent.yaml").write_text("""
name: test-agent
version: "1.0"
description: "A test agent"

brain:
  model: openrouter/anthropic/claude-3-7-sonnet
  instructions_file: instructions.md

harness:
  permissions:
    bash: always-allow
    read: always-allow
    glob: always-allow

tools:
  builtin:
    - bash
    - read
    - glob
  mcp: []
  custom: []
""")
    (agent_dir / "instructions.md").write_text("You are a helpful test agent.")
    return str(agent_dir)


def snapshot(messages):
    shot = []
    for message in messages:
        content = getattr(message, "content", "")
        if not isinstance(content, str):
            content = str(content)
        shot.append((type(message).__name__, content))
    return shot


def human_texts(shot):
    return [text for kind, text in shot if kind == "HumanMessage"]


@pytest.fixture
def llm_runtime(temp_agent_dir):
    calls = {"invoke": [], "stream": []}

    async def ainvoke(payload):
        shot = snapshot(payload["messages"])
        calls["invoke"].append(shot)
        messages = list(payload["messages"])
        messages.append(AIMessage(content="saw:" + " | ".join(text for _kind, text in shot)))
        return {"messages": messages}

    async def astream(payload, stream_mode=None):
        shot = snapshot(payload["messages"])
        calls["stream"].append(shot)
        text = "saw:" + " | ".join(text for _kind, text in shot)
        yield AIMessageChunk(content=text), {}

    with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}):
        with patch("cast.agent.runtime.OpenRouterProvider") as provider_cls, patch(
            "cast.agent.runtime.create_react_agent"
        ) as create_graph:
            provider = MagicMock()
            provider.create_llm.return_value = MagicMock()
            provider_cls.return_value = provider
            provider_cls.is_available.return_value = True
            graph = MagicMock()
            graph.ainvoke = ainvoke
            graph.astream = astream
            create_graph.return_value = graph
            config = AgentConfig.from_path(temp_agent_dir)
            agent = RuntimeAgent(config, agent_path=temp_agent_dir)
            agent.memory.format_memories = MagicMock(return_value="")
            agent.memory.record = AsyncMock(return_value=None)
            yield agent, calls


def message_request(text, session_id=None, history=None, request_id="1"):
    metadata = {}
    if session_id is not None:
        metadata["sessionId"] = session_id
    if history is not None:
        metadata["history"] = history
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "message/send",
        "params": {
            "message": {
                "role": "user",
                "parts": [{"kind": "text", "text": text}],
                "messageId": request_id,
            },
            "metadata": metadata,
        },
    }


class TestPerSessionHistory:
    @pytest.mark.asyncio
    async def test_second_connection_sees_empty_model_context(self, llm_runtime):
        """A follow-up that only makes sense after another connection is not answered from it."""
        agent, calls = llm_runtime
        await agent.process_message("my favorite color is blue", session_id="conn-a")
        response = await agent.process_message("what did I just ask?", session_id="conn-b")

        first, second = calls["invoke"]
        assert any("my favorite color is blue" in text for text in human_texts(first))
        assert all("my favorite color is blue" not in text for text in human_texts(second))
        assert any("what did I just ask?" in text for text in human_texts(second))
        assert "my favorite color is blue" not in response

    @pytest.mark.asyncio
    async def test_turns_in_one_session_accumulate(self, llm_runtime):
        agent, calls = llm_runtime
        await agent.process_message("the code word is papaya", session_id="conn-a")
        await agent.process_message("what is the code word?", session_id="conn-a")

        humans = human_texts(calls["invoke"][1])
        assert any("the code word is papaya" in text for text in humans)
        assert any("what is the code word?" in text for text in humans)

    @pytest.mark.asyncio
    async def test_two_connections_do_not_share_turns(self, llm_runtime):
        agent, calls = llm_runtime
        await agent.process_message("alpha secret", session_id="conn-a")
        await agent.process_message("beta secret", session_id="conn-b")
        await agent.process_message("what did we say?", session_id="conn-a")

        follow = human_texts(calls["invoke"][2])
        assert any("alpha secret" in text for text in follow)
        assert all("beta secret" not in text for text in follow)
        beta = human_texts(calls["invoke"][1])
        assert all("alpha secret" not in text for text in beta)

    @pytest.mark.asyncio
    async def test_resumed_session_sees_its_transcript(self, llm_runtime):
        agent, calls = llm_runtime
        transcript = [
            {"role": "user", "text": "the code is 42"},
            {"role": "agent", "text": "I will remember 42"},
        ]
        await agent.process_message(
            "what was the code?",
            session_id="resumed",
            history=transcript,
        )
        humans = human_texts(calls["invoke"][0])
        assert humans[0] == "the code is 42"
        assert any("what was the code?" in text for text in humans)
        assert any(kind == "AIMessage" and text == "I will remember 42" for kind, text in calls["invoke"][0])

        await agent.process_message("say it again", session_id="resumed")
        again = human_texts(calls["invoke"][1])
        assert any("the code is 42" in text for text in again)
        assert any("say it again" in text for text in again)
        assert sum(1 for text in again if text == "the code is 42") == 1

    @pytest.mark.asyncio
    async def test_fork_continues_from_the_fork_and_leaves_the_original(self, llm_runtime):
        agent, calls = llm_runtime
        await agent.process_message("original only", session_id="original")
        before = snapshot(agent.session_histories["original"])

        await agent.process_message(
            "what should the fork do?",
            session_id="fork",
            history=[
                {"role": "user", "text": "branch point"},
                {"role": "agent", "text": "copied reply"},
            ],
        )

        assert snapshot(agent.session_histories["original"]) == before
        fork_humans = human_texts(calls["invoke"][1])
        assert any(text == "branch point" for text in fork_humans)
        assert any("what should the fork do?" in text for text in fork_humans)
        assert all("original only" not in text for text in fork_humans)
        assert all("what should the fork do?" not in text for _kind, text in before)

    @pytest.mark.asyncio
    async def test_missing_session_id_keeps_legacy_shared_history(self, llm_runtime):
        """A missing id is not a new session. Old clients still share one history."""
        agent, calls = llm_runtime
        await agent.process_message("shared-alpha")
        await agent.process_message("shared-beta")
        legacy = human_texts(calls["invoke"][1])
        assert any("shared-alpha" in text for text in legacy)
        assert any("shared-beta" in text for text in legacy)

        legacy_stored = snapshot(agent.chat_history)
        await agent.process_message("isolated", session_id="fresh")
        assert snapshot(agent.chat_history) == legacy_stored
        assert all("shared-alpha" not in text for text in human_texts(calls["invoke"][2]))

        await agent.process_message("shared-gamma")
        legacy_again = human_texts(calls["invoke"][3])
        assert any("shared-alpha" in text for text in legacy_again)
        assert all("isolated" not in text for text in legacy_again)

        await agent.process_message("still shared", session_id="   ")
        blank = human_texts(calls["invoke"][4])
        assert any("shared-alpha" in text for text in blank)

    @pytest.mark.asyncio
    async def test_memory_middleware_runs_on_a_fresh_session(self, llm_runtime, temp_agent_dir):
        agent, calls = llm_runtime
        marker = Path(temp_agent_dir) / "memory" / "keep.txt"
        marker.write_text("persist")
        agent.memory.format_memories = MagicMock(return_value="Remember the user likes tea")

        await agent.process_message("what did I just ask?", session_id="fresh-session")
        await asyncio.sleep(0)

        agent.memory.format_memories.assert_called_once_with("what did I just ask?")
        agent.memory.record.assert_called()
        assert marker.read_text() == "persist"
        assert (Path(temp_agent_dir) / "memory" / "memory.db").exists()
        humans = human_texts(calls["invoke"][0])
        assert any(
            "Remember the user likes tea" in text and "what did I just ask?" in text
            for text in humans
        )

    @pytest.mark.asyncio
    async def test_stream_isolates_connections_and_seeds_resume(self, llm_runtime):
        agent, calls = llm_runtime

        async def collect(message, **kwargs):
            chunks = []
            async for chunk in agent.process_message_stream(message, **kwargs):
                chunks.append(chunk)
            return "".join(chunks)

        first = await collect("my favorite color is blue", session_id="conn-a")
        second = await collect("what did I just ask?", session_id="conn-b")
        assert "my favorite color is blue" in first
        assert "my favorite color is blue" not in second

        resumed = await collect(
            "what was the code?",
            session_id="resumed",
            history=[
                {"role": "user", "text": "the code is 42"},
                {"role": "agent", "text": "I will remember 42"},
            ],
        )
        assert "the code is 42" in resumed
        assert "what was the code?" in resumed
        await collect("say it again", session_id="resumed")
        again_humans = human_texts(calls["stream"][-1])
        assert any("the code is 42" in text for text in again_humans)
        assert any("say it again" in text for text in again_humans)
        assert sum(1 for text in again_humans if text == "the code is 42") == 1


class TestA2ASessionMetadata:
    @pytest.mark.asyncio
    async def test_message_send_pairs_session_id_and_transcript(self, llm_runtime):
        agent, calls = llm_runtime
        server = A2AServer(agent, port=0)

        await server.handle_request(message_request("shared-alpha"))
        second = await server.handle_request(message_request("shared-beta", request_id="2"))
        assert "shared-alpha" in second["result"]["parts"][0]["text"]

        fresh = await server.handle_request(
            message_request("what did I just ask?", session_id="conn-b", request_id="3")
        )
        assert "shared-alpha" not in fresh["result"]["parts"][0]["text"]
        assert "what did I just ask?" in fresh["result"]["parts"][0]["text"]

        resumed = await server.handle_request(message_request(
            "what was the code?",
            session_id="resumed",
            history=[
                {"role": "user", "text": "the code is 42"},
                {"role": "agent", "text": "I will remember 42"},
            ],
            request_id="4",
        ))
        body = resumed["result"]["parts"][0]["text"]
        assert "the code is 42" in body
        assert "what was the code?" in body
        assert calls["invoke"]

    @pytest.mark.asyncio
    async def test_streaming_send_pairs_session_id(self, llm_runtime):
        agent, calls = llm_runtime
        server = A2AServer(agent, port=0)

        async def collect(request):
            chunks = []
            async for event in server.handle_streaming_request(request):
                chunks.append(event)
            return "".join(chunks)

        first = await collect(message_request("my favorite color is blue", session_id="conn-a"))
        second = await collect(message_request(
            "what did I just ask?",
            session_id="conn-b",
            request_id="2",
        ))
        assert "my favorite color is blue" in first
        assert "my favorite color is blue" not in second
        assert calls["stream"]
