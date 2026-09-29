"""来源适配器注册表。新增来源只需在此注册。"""
from . import twixive, twivideo

REGISTRY = {
    "twixive": twixive.adapter,
    "twivideo": twivideo.adapter,
}

DEFAULT_SOURCE = "twixive"


def get_adapter(key=None):
    from .. import db
    key = key or db.get_settings().get("source") or DEFAULT_SOURCE
    factory = REGISTRY.get(key) or REGISTRY[DEFAULT_SOURCE]
    return factory()
