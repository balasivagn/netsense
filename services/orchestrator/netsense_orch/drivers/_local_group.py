"""Pinned group leader: never reap before the supervisor's final group signal."""

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
    channel.set_inheritable(False)
    config = json.loads(channel.makefile("rb").readline())
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
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()
