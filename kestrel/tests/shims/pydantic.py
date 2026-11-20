"""Minimal stand-in for pydantic (tests only)."""


def Field(default=None, description=""):
    return default


class BaseModel:
    def __init__(self, **kw):
        for k in dir(type(self)):
            if not k.startswith("_"):
                v = getattr(type(self), k)
                if not callable(v):
                    setattr(self, k, kw.get(k, v))
