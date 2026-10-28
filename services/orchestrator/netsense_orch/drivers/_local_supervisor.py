"""Private POSIX group leader. Never exits voluntarily after command startup.

The owner must send its last group signal BEFORE reaping this process. Even an
unexpected supervisor exit leaves its PID reserved as an unreaped direct child.
Only numeric status/errno travels back; command/env never enter logs or argv.
"""

from __future__ import annotations

import json
import signal
import socket
import subprocess
import sys
import time


def main() -> None:
    channel = socket.socket(fileno=int(sys.argv[1]))
    signal.signal(signal.SIGTERM, lambda _sig, _frame: None)
    # The descriptor is non-inheritable in the command; command stdin is DEVNULL.
    channel.set_inheritable(False)
    with channel.makefile("rb") as incoming:
        config = json.loads(incoming.readline())
    try:
        process = subprocess.Popen(
            config["command"],
            env=config["env"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError as exc:
        channel.sendall(f"error {exc.errno or 5}\n".encode())
    else:
        channel.sendall(b"ready\n")
        result = process.wait()
        channel.sendall(f"exit {result}\n".encode())
    # Do not reap this leader or release its numeric group identity in the owner
    # until the final killpg. Crash/restart sweeping remains separate work.
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()
