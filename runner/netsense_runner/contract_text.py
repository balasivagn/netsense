"""JSON TextSpan offsets are UTF-16 code units, not Python code point indexes."""


def slice_coach_span(text: str, start: int, end: int) -> str:
    encoded = text.encode("utf-16-le")
    if type(start) is not int or type(end) is not int or start < 0 or end <= start:
        raise ValueError("INVALID_SPAN")
    if end * 2 > len(encoded):
        raise ValueError("INVALID_SPAN")
    try:
        return encoded[start * 2 : end * 2].decode("utf-16-le")
    except UnicodeDecodeError as exc:
        raise ValueError("INVALID_SPAN") from exc
