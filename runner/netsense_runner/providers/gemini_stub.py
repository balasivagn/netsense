"""G1 default is disabled; implementation belongs to optional X7."""

from __future__ import annotations


class NotConfigured(RuntimeError):
    pass


class GeminiStub:
    name = "gemini"

    def complete(self, *args: object, **kwargs: object) -> object:
        del args, kwargs
        raise NotConfigured("GEMINI_NOT_CONFIGURED")
