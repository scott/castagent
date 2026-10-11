import hashlib

from cast.runtime import request_auth_error


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def test_cast_header_wins_over_authorization():
    headers = {
        "authorization": "Bearer digitalocean-token",
        "x-cast-authorization": "Bearer agent-token",
    }
    assert request_auth_error(_hash("agent-token"), headers) is None


def test_wrong_cast_header_is_rejected_even_if_authorization_matches():
    headers = {
        "Authorization": "Bearer agent-token",
        "X-Cast-Authorization": "Bearer wrong",
    }
    assert request_auth_error(_hash("agent-token"), headers) == "Invalid auth token"


def test_authorization_is_used_when_cast_header_is_absent():
    headers = {"Authorization": "Bearer agent-token"}
    assert request_auth_error(_hash("agent-token"), headers) is None
    assert request_auth_error(_hash("agent-token"), {"Authorization": "Bearer other"}) == "Invalid auth token"


def test_missing_token_is_unauthorized_and_local_mode_is_open():
    assert request_auth_error(_hash("agent-token"), {}) == "Authentication required"
    assert request_auth_error(None, {}) is None
