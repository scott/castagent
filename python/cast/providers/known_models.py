"""Print known model ids for each loaded inference provider.

This is for ``cast model`` and ``/model``. The deploy catalog stays free
of ``knownModels``.
"""

import json
import sys

from .registry import load_registry


def main() -> int:
    try:
        registry = load_registry()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1
    payload = {provider.key: list(provider.known_models) for provider in registry.providers}
    json.dump(payload, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
