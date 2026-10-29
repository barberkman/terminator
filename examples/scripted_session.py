#!/usr/bin/env python3
"""Drive a Terminator Claude session from Python, the way you would by hand.

It asks, waits for the answer, takes the reply, switches the model and effort, and
asks a follow-up built from that reply in the same session. Every step is the
`terminator` command (README -> Scripting) with --json, so Terminator has to be
running with Settings -> SCRIPTING on, and the command has to be on PATH (or named
by TERMINATOR_CMD).

    python3 scripted_session.py ~/code/my-project

The session is a real one: it shows in the sidebar while this runs, and you can open
it and watch. If Claude asks something in its terminal (a permission, a question),
the script says so and waits for you to answer it there.
"""
import json
import os
import subprocess
import sys

TERMINATOR = os.environ.get("TERMINATOR_CMD", "terminator")


def terminator(*args):
    """One command, answered as JSON. Raises with the app's reason when it fails."""
    r = subprocess.run([TERMINATOR, "--json", *args], capture_output=True, text=True, encoding="utf-8")
    try:
        out = json.loads(r.stdout)
    except ValueError:
        raise RuntimeError(f"terminator {args[0]}: {r.stderr.strip() or r.stdout.strip()}")
    if not out.get("ok"):
        raise RuntimeError(f"terminator {args[0]}: {out.get('error')}")
    return out


def ask(session, prompt, timeout="10m"):
    """Send a prompt, wait for its turn to finish, and return the reply as markdown."""
    terminator("send", session, prompt)
    status = terminator("wait", session, "idle", "waiting", "error", "--timeout", timeout)["status"]
    if status == "waiting":
        print("Claude is asking something in its terminal - answer it there.", file=sys.stderr)
        status = terminator("wait", session, "idle", "error")["status"]
    if status == "error":
        raise RuntimeError("the turn ended in an error")
    return terminator("reply", session)["markdown"]


def main():
    project = sys.argv[1] if len(sys.argv) > 1 else "."
    session = terminator(
        "new", "claude", "--project", project, "--name", "scripted", "--model", "haiku", "--effort", "low"
    )["id"]
    print(f"session {session}")

    first = ask(session, "Name the one file in this folder worth reading first. Reply with only its name.")
    print(f"haiku: {first}")

    print(terminator("model", session, "sonnet")["message"])
    print(terminator("effort", session, "high")["message"])

    second = ask(session, f"You picked {first.strip()}. In two sentences, what is it for?")
    print(f"sonnet: {second}")

    terminator("stop", session)
    terminator("remove", session)


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as e:
        sys.exit(str(e))
