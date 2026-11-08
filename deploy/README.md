# deploy — 本部署的私有运行资产

这里放**跑起来必需、但不属于上游 OpenMAIC 的**东西。放在 `deploy/` 而不是 `docs/`，
是因为仓库根 `.gitignore:77` 把整个 `/docs` 忽略了 —— 放在那儿换机器就丢，
而它又不是文档，是构建上下文。

```
deploy/
├── tutorial-video/
│   ├── docker-compose.override.yml   # 3100 端口 / TTS shim / workflow·brand 挂载 / 渲染超时
│   └── piper-tts/                    # 一个镜像、两个后端（piper :8090 · edge :8091）
│       ├── Dockerfile
│       ├── server.py
│       └── voices/                   # 语音模型（*.onnx 不进 git）
└── deliver-sidecar/                  # 导出交付包 → 阿里云盘上传 + 建分享链接
    ├── Dockerfile
    ├── server.mjs
    └── bin/aliyunpan                 # Linux amd64 CLI（不进 git）
```

## 启动

```bash
docker compose --profile video-export up -d
# → http://localhost:3100
```

> `docker-compose.override.yml` 与 `docker-compose.yml` 同在仓库根，compose **自动合并**，
> 不需要 `-f`。别把它挪进子目录 —— 文件名一旦离开根目录的自动加载位，就得每次手写
> `-f` 记住路径，换台机器必漏（2026-11-03 之前它散在 `docs/tutorial-video/` 和
> `deploy/tutorial-video/` 两处，就是这么丢的）。
>
> 要单独起可选档（离线 TTS 兜底）：`docker compose --profile tts-fallback up -d piper-tts`。

## 新机部署清单

目标：一台全新机器，从 `git clone` 到「能生成课堂、有旁白、能导出 MP4、能自动配图」。
按 §1 → §6 走。跳步的典型症状是**容器都起来了，但某块功能静默失败**。

代码来源是**交付用的 fork**，不是上游。交付链路、白标、AIGC 标识、PPTX 相对链接、
piper 可选档都在 fork 上；clone 上游得到的是没有这些功能的上游版本，后面每一步都会对不上。

```bash
git clone https://github.com/voidvec/OpenMAIC.git    # 或 git@github.com:voidvec/OpenMAIC.git
cd OpenMAIC
```

两份深度手册在 `.workbuddy/docs/`，**不在 git 里**（`.git/info/exclude` 忽略 `.workbuddy/`），
换机器要单独拷：

| 主题 | 文件 | 什么时候看 |
|---|---|---|
| 自动配图 | `2026-11-03-comfyui-setup-guide.md` | 要从零装 ComfyUI + SDXL |
| 旁白 TTS | `2026-11-03-edge-tts-setup-guide.md` | 没声音、换音色、要真离线 |

### 1. 宿主必须有的

| 项 | 要求 | 依据 |
|---|---|---|
| Docker | Desktop（Win/Mac，**必须 WSL2 backend**）或 Engine 24+，且是 compose v2（`docker compose`） | `render-service` 的 iptables 出站封锁需要 `NET_ADMIN` |
| 资源 | **16 GB 内存 / 8 核 / 40 GB 空闲盘** | `render-service` 单容器 `mem_limit: 8g` + `shm_size: 2gb`；五个镜像合计 ≈ 4.8 GB（app 990 MB、render 2.21 GB、postgres 642 MB、tts-shim 619 MB、sidecar 365 MB），首次构建中间层另需 10 GB+ |
| 出网（构建期） | npm registry / PyPI / Alpine / `m.daocloud.io` / HuggingFace | 国内用 `ALPINE_MIRROR`、`NPM_REGISTRY`、`PIP_INDEX_URL` 三个构建参数加速 |
| 出网（运行期） | LLM 端点、`speech.platform.bing.com:443`、搜索 API | 缺哪个就哪块功能失败 |
| 浏览器 | Chrome / Edge | 导出 PPTX/HTML 由前端完成 |

三条自检，全绿再往下：

```bash
docker --version && docker compose version
# 404/401/403/200 都算通，超时或 000 才是网络问题
curl -sI -m 10 https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list \
  -o /dev/null -w "%{http_code}\n"
# 无输出 = 端口干净（PowerShell: Get-NetTCPConnection -State Listen |
#   Where-Object LocalPort -in 3100,8090,8091,8099,8188）
lsof -iTCP -sTCP:LISTEN -P -n | grep -E ':(3100|8090|8091|8099|8188)\b'
```

### 2. 必须补的文件（不进 git）

`git clone` 只拿到代码。下面 4 项缺一样，就缺一块功能：

| 路径 | 怎么来 | 缺了会怎样 |
|---|---|---|
| `openmaic.yml` | 拷旧机，或从 `openmaic.example.yml` 改 | provider 全没；更糟的是 override 的挂载源不存在时 Docker 会建**同名目录**，容器内 `EISDIR` 启动失败 |
| `.env` | 拷旧机后按新机账号改 | `openmaic.yml` 的 `${VAR}` 取不到值 ⇒ **启动直接失败**（该语法无默认值） |
| `deploy/tutorial-video/piper-tts/voices/zh_CN-huayan-medium.onnx` | 见下节「两个不进 git 的大文件」 | 只影响 piper 容器，构建不中断，edge 后端不受影响 |
| `deploy/deliver-sidecar/bin/aliyunpan` | 同上 | `--profile video-export` 下 sidecar **构建直接失败** |

### 3. 按功能选装

| 功能 | 宿主要装什么 | 说明 |
|---|---|---|
| 生成课堂（必有） | 不用装 | 只要一个 OpenAI 兼容端点 + key（`CUSTOM_LLM_*`）；本地 ollama/vLLM 也行 |
| 课堂旁白 | 不用装 | TTS 在容器内（`openmaic-tts-shim`）。**edge 后端不下载模型**，只要求能连微软端点（国内实测 10/10 直连可通） |
| 真·离线旁白 | 61 MB onnx | 见下节；要手动把 `slots.tts` 切到 piper 才生效，手册 §5.4 |
| 自动配图 | ComfyUI + SDXL | 手册 §2–§6：ComfyUI Desktop + RealVisXL V5.0 + Lightning LoRA，约 13 GB 盘，**NVIDIA 6 GB 显存起**（8 GB 舒适）。没显卡就别配 `slots.image` |
| 交付包上云 | 阿里云盘登录态 | 宿主 `aliyunpan login` 扫码一次，`aliyunpan_config.json` 放进 `.workbuddy/deliver/aliyunpan-config/`；分享用 `-mode 1`（私密码），**上传目标必须是资源库** |
| 交付完成通知 | 飞书机器人 | `FEISHU_WEBHOOK_URL` + `FEISHU_WEBHOOK_SECRET`，不配不推 |

### 4. 必改的 5 处

| 位置 | 默认值 | 新机怎么处理 |
|---|---|---|
| override → `EDGE_TTS_PROXY` | `http://host.docker.internal:7897` | 本机 Clash 的遗留端口。新机没跑 7897 就**删掉或改成实际端口**；直连可用，但留着这条死代理会卡 `--list-voices`（手册 §8.1） |
| override → `ports` | `3100` | 上游默认 `3000:3000`，本机被 new-api 占了才改。新机 3000 空闲可整段删 |
| `.env` → `ALLOW_LOCAL_NETWORKS` | 空 | **必须 `true`**，否则容器访问宿主 ComfyUI 报 403 `Unsafe network target`，极易误判成 ComfyUI 没起 |
| `.env` → `CUSTOM_LLM_*` / `DELIVER_SIDECAR_TOKEN` / `AIGC_CONTENT_ID` | — | 按新机账号重填；`AIGC_CONTENT_ID` 是 GB 45438-2025 标识位，一机一号 |
| Linux 宿主 | Desktop 自带 `host.docker.internal` | 给 `openmaic` 加 `extra_hosts: ["host.docker.internal:host-gateway"]`，否则代理与 ComfyUI 都连不上 |

`openmaic.yml` 里其余项（`preset`、`models`、workflow 文件名、`slots`）**一律不用动**。

### 5. 启动

```bash
# 首次先 build：失败信息比 up 清楚
docker compose \
  --profile video-export build
docker compose \
  --profile video-export up -d
```

本机实测：全量首次构建 **17.5 分钟**（依赖层全失效时），只改 Next 源码再构建约 **2.5 分钟**。
`--profile video-export` 只决定要不要 `render-service`；不带它就没有 MP4 导出，会降级成下载 ZIP。

### 6. 验收（一层不过别往下走）

| # | 检查 | 期望 |
|---|---|---|
| 1 | `curl -o /dev/null -w "%{http_code}" localhost:3100/` | `200` |
| 2 | `curl localhost:3100/api/health` | `status: ok`；`videoGeneration: false` 属正常（指没配视频**生成** provider，不影响 MP4 渲染） |
| 3 | 容器内三个配套服务 | `render-service:9000/health` ok + accepting、`deliver-sidecar:8099/health` 200、`edge-tts:8091/health` 200 |
| 4 | `docker exec openmaic-openmaic-1 wc -c /app/openmaic.yml` | 与宿主字节数一致（`/openmaic.yml` 被 `.dockerignore` 排除，只能靠挂载） |
| 5 | 设置页「测试连接」（配图） | 通过；失败先查 `ALLOW_LOCAL_NETWORKS` |
| 6 | 生成一节课 → 导出 MP4 | 有成片、有解说音轨、有 AIGC 标识 |
| 7 | `docker logs openmaic-openmaic-1 2>&1 \| grep -c "\[ERROR\]"` | `0` |

### 7. 明确**不用**在宿主装

Node / pnpm、Chrome / Chromium / Playwright、FFmpeg、PostgreSQL、Python、中文字体 —— 全在镜像里：
`render-service` 自带 `chromium-headless-shell` + `ffmpeg` + `fonts-noto-cjk`，`postgres:16` 由
compose 提供，TTS shim 是 `python:3.13-slim`。宿主再装一份只会版本打架。

### 8. 已知缺口（部署前要跟客户说明）

- **piper 不会自动兜底，而且默认不启动**：它是 `profiles: [tts-fallback]` 可选档，常规
  `up -d` 不会拉起它。即便手工起了也不会被调用 —— `scene-tts` 的 failover 候选只来自 legacy
  provider 列表，`openmaic.yml` 里声明的 `piper` 进不了候选；主链路 `/api/generate/tts` 更是
  只认 `slots.tts` 一个 provider。要真用它，得改 `slots.tts` 再重启。
- **TTS 是单点**：`slots.tts` 指向 edge-tts 时，edge 不可用 = 整个课堂没有旁白，不会有人接手。
  它是非官方端点（微软 consumer 接口），随时可能改。真要容灾就配一个云 TTS provider 写进
  `slots.tts`，别指望 piper —— 它的中文 G2P 会把 `BM25` 念成「LM25」，那种旁白交不出去。
- **交付包超过 400 MB** 会切 ZIP 变体，而 `assembleDeliveryBundle` 只收 `.pptx` / `.html`，
  页面会静默丢。大媒体课件要在这条线之前先验。

## 两个不进 git 的大文件

仓库只存代码，二进制按需下载后放回原位。

**1. `tutorial-video/piper-tts/voices/zh_CN-huayan-medium.onnx`（61 MB）**

piper 后端的离线中文女声模型。**只有 `--backend piper` 用得到**；服务端默认走 edge，
edge 后端完全不加载它。

```bash
cd deploy/tutorial-video/piper-tts/voices
curl -LO https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx
```

同目录的 `zh_CN-huayan-medium.onnx.json`（4.8 KB）**已进 git**，不用下。

**2. `deliver-sidecar/bin/aliyunpan`（17 MB，Linux amd64）**

阿里云盘 CLI，Dockerfile 直接 COPY 进镜像（构建时不联网，规避国内直连 GitHub 失败）。
从 [tickstep/aliyunpan releases](https://github.com/tickstep/aliyunpan/releases) 取
`aliyunpan-linux-amd64`，重命名为 `bin/aliyunpan` 即可。

不做「导出交付包 + 上云」这条线的话，这两个文件都可以不准备 —— 但 `deploy/tutorial-video/`
里的 TTS 服务是课堂旁白必需的，而它与 piper 共用一个镜像，所以 **onnx 缺失不会中断构建**
（Dockerfile 只打 WARN），只是 piper 容器起不来。

## 与 `.workbuddy/` 的分工

| 位置 | 内容 | 进 git |
|---|---|---|
| `docker-compose.override.yml`（仓库根） | 端口、挂载、TTS / 渲染 / 交付的本地接线 | ✅ |
| `deploy/`（本目录） | 跑起来必需、且换机器要能复现的资产：TTS shim 源码、交付 sidecar | ✅ |
| `.workbuddy/runbooks/tutorial-video/` | 内部台账（`runbook.md` / `deploy-changes.md`）、脚本（`tools/`）、诊断探针（`tools/probes/`）、输入样本 | ❌ |
| `.workbuddy/xianyu-kejian/` | 卖课件那条线：文案、清单图、样例、QA | ❌ |
| `.workbuddy/docs/` | 技术分析、选型调研、实施复盘 | ❌ |

判断规则一句话：**「怎么装、怎么跑」→ `deploy/`（进 git）；「为什么这么做、这单怎么交」→ `.workbuddy/`。**
