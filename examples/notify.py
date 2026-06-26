#!/usr/bin/env python3
"""Example Terminator notification command.

Terminator runs the command configured in Settings → notifications on each
notification, through your shell. It passes the event as JSON on stdin and also
as TERMINATOR_* environment variables, so you can branch on the notification
type and do whatever you like — play a sound, post to Slack, send a phone push.

Configure it in the app's settings.json, e.g.:

    "notifications": {
        "command": "python3 ~/path/to/notify.py",
        "triggerOn": ["waiting", "error", "finished"],
        "perType": {}
    }

Notification types: "waiting" (Claude needs your input), "finished" (a turn
completed), "error" (a session errored), "exited" (process exited).
"""
import json
import shutil
import subprocess
import sys


def desktop_notify(title: str, body: str) -> None:
    """Best-effort native desktop notification, per-OS. Optional."""
    if shutil.which("notify-send"):  # Linux
        subprocess.run(["notify-send", title, body], check=False)
    elif shutil.which("osascript"):  # macOS
        script = f'display notification "{body}" with title "{title}"'
        subprocess.run(["osascript", "-e", script], check=False)
    # On Windows you might use a PowerShell toast here.


def main() -> None:
    try:
        event = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        event = {}

    kind = event.get("type", "?")
    name = event.get("name", "session")
    project = event.get("project", "")
    message = event.get("message", "")

    icons = {"waiting": "🔔", "error": "❌", "finished": "✅", "exited": "⏹"}
    icon = icons.get(kind, "•")

    # Differentiate behaviour by type:
    if kind == "waiting":
        desktop_notify(f"{icon} {name} needs you", message or f"{project}: waiting for input")
    elif kind == "error":
        desktop_notify(f"{icon} {name} errored", message or project)
    elif kind == "finished":
        desktop_notify(f"{icon} {name} finished", message or project)
    else:
        desktop_notify(f"{icon} {name}", message or project)

    # Whatever you print goes to Terminator's notifications.log on a non-zero exit.
    print(f"{icon} [{kind}] {name} — {message}")


if __name__ == "__main__":
    main()
