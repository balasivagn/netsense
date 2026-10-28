"""Independent guardian: owns a pinned group leader, deadline and owner socket.

Only this process signals its child group, before reaping its leader. Owner EOF
and the immutable startup deadline both trigger cleanup without owner polling.
The inherited flock remains held until confirmed group cleanup and durable receipt.
"""

from __future__ import annotations

import json
import os
import selectors
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path


def main() -> None:
    owner = socket.socket(fileno=int(sys.argv[1]))
    owner.set_inheritable(False)
    # Bound even a parent which dies/stalls before delivering startup inputs.
    owner.settimeout(5)
    incoming = bytearray()
    while b"\n" not in incoming:
        data = owner.recv(8192)
        if not data or len(incoming) + len(data) > 65536:
            return
        incoming.extend(data)
    config = json.loads(incoming)
    deadline = config["deadline"]
    a, b = socket.socketpair()
    process = subprocess.Popen(
        [sys.executable, "-I", str(Path(__file__).with_name("_local_group.py")), str(b.fileno())],
        env={},
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        pass_fds=(b.fileno(),),
    )
    b.close()
    result = -signal.SIGKILL
    reason = "orchestrator"
    try:
        a.sendall(json.dumps({"command": config["command"], "env": config["env"]}).encode() + b"\n")
        selector = selectors.DefaultSelector()
        selector.register(owner, selectors.EVENT_READ)
        selector.register(a, selectors.EVENT_READ)
        buffer = b""
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                reason = "timeout"
                break
            events = selector.select(min(remaining, 0.1))
            stop = False
            for key, _ in events:
                if key.fileobj is owner:
                    owner.recv(4096)  # stop message or EOF: both revoke ownership.
                    stop = True
                    break
                data = a.recv(4096)
                if not data:
                    stop = True
                    break
                buffer += data
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    if line.startswith(b"exit "):
                        result = int(line[5:])
                    try:
                        owner.sendall(line + b"\n")
                    except OSError:
                        stop = True
            if stop:
                break
    finally:
        # Keep the child identity pinned across retryable cleanup failures.
        # No release receipt (or lock release) until final KILL and reap succeed.
        signalled = False
        while True:
            try:
                if not signalled:
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    time.sleep(0.2)
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    signalled = True
                process.wait(timeout=2)
                break
            except (OSError, subprocess.TimeoutExpired):
                time.sleep(0.1)
        receipt = Path(config["receipt"])
        temporary = receipt.with_suffix(".pending")
        while True:
            try:
                with temporary.open("w") as output:
                    json.dump(
                        {"sandboxId": config["id"], "exitCode": result, "terminatedBy": reason},
                        output,
                    )
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary, receipt)
                fd = os.open(receipt.parent, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
                break
            except OSError:
                time.sleep(0.1)  # Retain the ownership lock until durable proof exists.
        a.close()
        owner.close()
        os.close(config["lockFd"])


if __name__ == "__main__":
    main()
