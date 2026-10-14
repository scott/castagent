"""Create one agent from a description on stdin.

``cast new`` runs this when stdin is not a terminal.
"""

import json
import sys

from cast.builder_tools.tools import create_from_description


def main() -> int:
    try:
        info = create_from_description(sys.stdin.read())
    except ValueError as exc:
        sys.stderr.write(f"{exc}\n")
        return 2
    json.dump({"name": info["name"], "path": info["path"]}, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
