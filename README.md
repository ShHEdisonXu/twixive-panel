# TwiXive Panel · 视频下载管理面板

一个自托管的视频下载管理面板：**分类选择 → 勾选视频 → 一键/自动下载**，支持
**代理**、**Docker** 部署。架构为可插拔「来源适配器」，TwiXive 作为一个适配器接入。

> ⚠️ TwiXive 为 X/Twitter 成人视频聚合站（18+）。本工具仅做下载自动化，不绕过访问控制、
> 默认带礼貌限速；请仅下载你有权访问的内容，并遵守所在地区法律与站点条款。

## 功能
- 🎛️ 深色面板：控制台 / 分类下载 / 下载任务 / 设置 四个视图
- 🗂️ 两个来源大 tab（TwiXive / TwiVideo），分类按站点真实导航分组，勾选视频批量入队
- 📡 分类监控：点亮分类上的 📡，出现新视频自动入队下载（按地址去重，绝不重复下）
- ⚡ 断点续传 + 失败自动重试 N 次 + 单文件大小上限过滤
- 🌐 代理配置：HTTP / HTTPS / SOCKS5（由地址前缀决定），抓取与下载均走代理
- 🐳 Docker：一键 `docker compose up -d`，数据持久化到 `./data`，默认端口 **6523**
- 🔌 可插拔来源：`app/sources/` 下新增适配器并在 `REGISTRY` 注册即可

## 快速开始（Docker，推荐）
```bash
git clone <repo> && cd twixive-panel
docker compose up -d --build
# 打开 http://<宿主机IP>:6523
```
启动后：设置页填入代理 → 回到「分类下载」选择站点与分类 → 拉取并勾选下载。

## 部署到 NAS（端口 6523）
本服务已默认映射到宿主机 **6523** 端口（`docker-compose.yml` 中 `6523:8000`）。

**方式 A：把整个文件夹拷到 NAS 后用 Compose（群晖 Container Manager / QNAP Container Station / 威联通 均支持）**
1. 将 `twixive-panel/` 整目录上传到 NAS 任意共享文件夹（如 `/volume1/docker/twixive-panel`）。
2. 进入该目录即可用（默认无口令，直接访问；compose 已改为使用本地镜像 `twixive-panel:latest`，不再重新 build）。
3. 用 Container Manager 的「项目 / 导入 docker-compose」导入该目录，或 SSH 进 NAS 执行：
   ```bash
   cd /volume1/docker/twixive-panel
   docker compose up -d
   ```
4. 浏览器打开 `http://<NAS局域网IP>:6523` 直接访问。

**方式 B：单条 docker run（任意支持 Docker 的 NAS / 服务器）**
```bash
docker run -d --name twixive-panel \
  -p 6523:8000 \
  -e TZ=Asia/Shanghai \
  -v /volume1/docker/twixive-panel/data:/data \
  --restart unless-stopped \
  ghcr.io/<your>/twixive-panel:latest
```
> 说明：本仓库提供的是源码构建（`build: .`）。若你的 NAS 无法直接访问源码目录，
> 可先在本机/CI 执行 `docker build -t twixive-panel .` 并推送到镜像仓库（如 Docker Hub / 群晖自带 Registry），
> 再把上面 `build: .` 换成 `image: 你的镜像地址`。

**反向代理 / HTTPS（可选）**：如需用域名 + HTTPS，在 Nginx / Caddy / 群晖「反向代理」中把
`https://your.domain` 转发到 `http://127.0.0.1:6523` 即可；注意转发时要带上 `/static` 与 cookie。

## 本地运行（开发）
```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export DATA_DIR=./data
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

## 配置说明（设置页）
| 项 | 说明 |
|----|------|
| 代理地址 | `http://127.0.0.1:7890` 或 `socks5://127.0.0.1:1080`，留空直连 |
| 并发下载数 | 同时下载的任务数（1–10） |
| 礼貌延时 | 每次请求间隔秒数，避免对站点造成压力 |
| 失败自动重试次数 | 配合断点续传，失败后从已下载部分继续（0 = 不重试） |
| 单文件大小上限(MB) | 超过则跳过不下载并标记「已跳过」，0 = 不限制 |
| 自动下载 | 总开关 + 巡检间隔(分钟)；分类上的 📡 监控独立于总开关生效 |
| 来源 | 在「分类下载」页顶部大 tab 切换 TwiXive / TwiVideo |

## 接入 TwiXive 真实结构
`app/sources/twixive.py` 顶部的**可配置常量**决定解析方式：
- `AGE_COOKIE`：成年验证 cookie（按站点实际值调整）
- `CATEGORY_LINK_SEL` / `VIDEO_CARD_SEL` / `THUMB_SEL` / `DIRECT_VIDEO_SEL`：CSS 选择器
- `DEFAULT_CATEGORIES`：抓取失败时的兜底分类

打开浏览器开发者工具，对照实际 DOM 调整上述选择器即可。解析失败不会崩溃，只会返回空列表。

## 目录结构
```
twixive-panel/
├── Dockerfile / docker-compose.yml   # 容器化
├── requirements.txt
└── app/
    ├── main.py        # FastAPI 路由
    ├── db.py          # SQLite 持久化
    ├── config.py      # 代理 / session
    ├── downloader.py  # 下载引擎（代理/并发/断点续传/大小上限）
    ├── scheduler.py   # 跨来源巡检 + 自动入队
    ├── errors.py      # 报错中文化
    ├── sources/       # 来源适配器（twixive / twivideo）
    └── static/        # 前端面板 (index.html/css/js)
```
