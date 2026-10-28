"""Owned HTTP subprocess: no proxies, redirects, retries, or raw error output.

The parent kills/reaps this process at its monotonic deadline, including during
platform DNS resolution. Secrets travel over stdin, never process arguments.
"""
from __future__ import annotations

import http.client
import json
import sys
from urllib.parse import urlsplit


def main() -> None:
    connection: http.client.HTTPConnection | None = None
    try:
        origin, token, method, path, body, timeout, limit = json.load(sys.stdin)
        parsed = urlsplit(origin)
        cls = (
            http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
        )
        connection = cls(parsed.hostname, parsed.port, timeout=timeout)
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        connection.request(method, path, body=body, headers=headers)
        with connection.getresponse() as response:
            if 300 <= response.status < 400:
                sys.stdout.buffer.write(b"REDIRECT_REJECTED\n")
                return
            if not 200 <= response.status < 300:
                sys.stdout.buffer.write(b"HTTP_STATUS\n")
                return
            if response.status == 204:
                sys.stdout.buffer.write(b"OK\nnull")
                return
            data = bytearray()
            while True:
                # read1 returns available bytes rather than waiting to fill a buffer.
                chunk = response.read1(min(8192, limit + 1 - len(data)))
                data.extend(chunk)
                if len(data) > limit:
                    sys.stdout.buffer.write(b"RESPONSE_TOO_LARGE\n")
                    return
                if not chunk:
                    if response.length not in {None, 0}:
                        raise http.client.HTTPException
                    break
            sys.stdout.buffer.write(b"OK\n" + data)
    except TimeoutError:
        sys.stdout.buffer.write(b"TIMEOUT\n")
    except Exception:
        # Never serialize transport exceptions: invalid headers may contain tokens.
        sys.stdout.buffer.write(b"TRANSPORT_FAILED\n")
    finally:
        if connection is not None:
            connection.close()


if __name__ == "__main__":
    main()
