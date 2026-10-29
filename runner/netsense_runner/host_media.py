"""Owned bounded media transport. No redirects, proxy env, credentials or raw errors."""

from __future__ import annotations

import http.client
import json
import sys
from urllib.parse import urlsplit


def main() -> None:
    connection: http.client.HTTPConnection | None = None
    try:
        url, method, path, content_type, timeout, limit = json.load(sys.stdin)
        parsed = urlsplit(url)
        cls = (
            http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
        )
        connection = cls(parsed.hostname, parsed.port, timeout=timeout)
        target = parsed.path + ("?" + parsed.query if parsed.query else "")
        if method == "PUT":
            with open(path, "rb") as source:
                import os

                size = os.fstat(source.fileno()).st_size
                if size > limit:
                    raise ValueError
                connection.request(
                    method,
                    target,
                    body=source,
                    headers={
                        "Content-Type": content_type,
                        "Content-Length": str(size),
                    },
                )
        else:
            connection.request(method, target)
        with connection.getresponse() as response:
            if response.status == 404:
                print("MISSING")
                return
            if not 200 <= response.status < 300:
                raise ValueError
            total = 0
            with open(path, "wb") if method == "GET" else open("/dev/null", "wb") as output:
                while True:
                    chunk = response.read1(min(65536, limit + 1 - total))
                    total += len(chunk)
                    if total > limit:
                        raise ValueError
                    if not chunk:
                        if response.length not in {None, 0}:
                            raise ValueError
                        break
                    output.write(chunk)
        print("OK")
    except Exception:
        print("MEDIA_FAILED")
    finally:
        if connection is not None:
            connection.close()


if __name__ == "__main__":
    main()
