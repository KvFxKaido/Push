#!/usr/bin/env python3
"""Deprecated one-off helper for the parity plan.

The Web-CLI parity plan is maintained directly in
`docs/runbooks/Web-CLI Parity Plan.md`.
"""

from pathlib import Path


def main() -> None:
    plan_path = Path("docs/runbooks/Web-CLI Parity Plan.md")
    if not plan_path.exists():
        raise SystemExit(f"Missing plan: {plan_path}")

    raise SystemExit(
        "update.py is deprecated. Edit "
        f"{plan_path} directly instead."
    )


if __name__ == "__main__":
    main()
