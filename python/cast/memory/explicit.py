"""Facts the user asked to store, without an extra model call.

Reflection can skip a preference such as a favorite fruit. A message
that starts with "remember:" or "remember that" is an explicit request
and is stored as written.
"""

import re
from typing import Optional


_EXPLICIT_REMEMBER = re.compile(
    r"(?is)^\s*(?:please\s+)?remember\b\s*(?::|that)\s+(.+?)\s*$"
)


def explicit_remember_fact(user_message: str) -> Optional[str]:
    """Return the fact from an explicit remember request, else None."""
    if not isinstance(user_message, str):
        return None
    match = _EXPLICIT_REMEMBER.match(user_message.strip())
    if not match:
        return None
    fact = " ".join(match.group(1).split())
    return fact or None
