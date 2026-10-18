"""The public agent card is what a Fly health check fetches."""

from starlette.testclient import TestClient

from cast.runtime import A2AServer


class _CardAgent:
    def get_agent_card(self):
        return {"name": "demo", "protocolVersion": "0.2.9"}


def test_agent_card_is_public_and_jsonrpc_stays_authenticated():
    server = A2AServer(_CardAgent(), host="127.0.0.1", port=9)
    server.set_auth_token("secret-token-value")
    client = TestClient(server.build_starlette_app())

    card = client.get("/.well-known/agent.json")
    assert card.status_code == 200
    assert card.json()["name"] == "demo"

    denied = client.post(
        "/",
        json={"jsonrpc": "2.0", "id": 1, "method": "agent/card"},
    )
    assert denied.status_code == 401
