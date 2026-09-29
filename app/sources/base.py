"""来源适配器接口。

每个适配器实现：
- key / name：唯一标识与展示名
- fetch_categories() -> [{"name": "..."}]
- fetch_videos(category, limit=20) -> [{"title","url","thumbnail"}]
  url 为可直接下载的媒体直链（无扩展名时按 Content-Type 推断扩展名）。
- fetch_page(category, page, limit) -> {"videos","has_more","page"}（可选覆盖）

适配器应尊重 settings 中的代理、User-Agent 与礼貌延时。
新增来源：在 sources/ 下新建一个继承 SourceAdapter 的模块，
并在 sources/__init__.py 的 REGISTRY 中注册即可。
"""
from abc import ABC, abstractmethod


class SourceAdapter(ABC):
    key = "base"
    name = "Base"

    @abstractmethod
    def fetch_categories(self):
        ...

    @abstractmethod
    def fetch_videos(self, category, limit=20):
        ...

    def fetch_page(self, category, page=1, limit=20):
        """分页拉取。默认实现退化为单页（无更多）。子类应覆盖以支持真分页。

        返回: {"videos": [...], "has_more": bool, "page": page}
        """
        return {
            "videos": self.fetch_videos(category, limit=limit),
            "has_more": False,
            "page": page,
        }
