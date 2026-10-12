"""Print the loaded inference catalog as JSON.

``knownModels`` is omitted. Import failures are written to stderr and do
not drop the built-in providers. A key or prefix collision exits non-zero.
"""

import json
import sys

from .registry import catalog_entries, load_registry


def main() -> int:
    try:
        registry = load_registry()
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1
    # Import errors were already printed while loading. Built-ins stay in the payload.
    json.dump(catalog_entries(registry), sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
