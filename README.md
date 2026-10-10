# magpie × APIMart 生图

一个仓库，两个入口，**不改 magpie 一行代码**：

| 入口 | 是什么 | 谁用得上 |
|---|---|---|
| `index.mjs` | **provider 插件**（magpie 的 OpenCode v1 插件形状） | magpie 的 gateway：`/v1/images/generations`、内置的 `magpie mcp image`、任何 OpenAI 客户端 |
| `mcp.mjs` | **stdio MCP server** | 各 agent 的 `generate_image` 工具；**随 magpie 的 WebDAV library 同步，多台机器零手动** |
| `core.mjs` | 共用逻辑：异步提交+轮询、尺寸/档位换算、线路与版本 | 上面两个都 import 它 |

## 为什么需要它

APIMart 的**所有**生图模型都是异步的：`POST /v1/images/generations` 只回一个任务（官方线 `data[0].task_id`，Ext 线 `data.id`），图片要再 `GET /v1/tasks/<id>` 轮询。而 magpie 的 gateway 按 OpenAI 的形状读上游（`data[].b64_json | url`），直接把 APIMart 当普通 provider 加进去只会得到 `502 … answered with no image`。

- `index.mjs` 卡在 gateway 与 APIMart 之间做转换（magpie 会把 images 请求交给插件 provider 的 `fetch`：`gateway/draw.go` → `provider.Do` → `Account.transport` → `pluginFetch` → 插件的 `loader.fetch`）；
- `mcp.mjs` 则干脆自己做完整轮询，把图片落成项目里的文件。

## 一、MCP 入口：跨机同步（推荐）

magpie 的 WebDAV/S3 同步只搬 5 个部分：`providers` / `settings` / `profiles` / `agents` / **`library`**。`library` 里带着共享说明、MCP servers（含 env）和 skills（含文件）—— 所以把能力做成 library 里的 MCP server，就能跟着同步走，**插件本身和 Bun 运行时都不会同步**。

在一台机器上注册一次（key 写在 env 里，随密封备份同步）：

```sh
magpie library mcp add apimart-image npx -y -p github:liuyf5231/magpie_apimart magpie-apimart-mcp agents=pi,dsh
```

仓库是 public，所以 `npx github:` 在别的机器上**不需要任何凭据**（npm 走 git 拉取，公开仓库匿名即可）。

`magpie library mcp add` 不能设 env，所以 key 要写进 `~/.config/magpie/library.json` 里该条目的 `env`：

```json
{
  "name": "apimart-image",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "-p", "github:liuyf5231/magpie_apimart", "magpie-apimart-mcp"],
  "env": { "APIMART_API_KEY": "sk-…" },
  "agents": ["pi", "dsh"]
}
```

然后 `magpie library sync` 把它写进各 agent 的 MCP 配置，下一次同步就带到别的机器（`sync.json` 里 `keys: true` 时 env 的值随备份走）。

**环境变量**（都可在 `env` 里设）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `APIMART_API_KEY` | — | key；不设时回落到 macOS Keychain 的 `APIMART_API_KEY` 条目 |
| `APIMART_IMAGE_MODEL` | `gpt-image-2.5-flare` | 默认模型（`gpt-image-2.5-ext` 更省，但慢一倍） |
| `APIMART_IMAGE_SIZE` | `1024x1024` | `WIDTHxHEIGHT`、比例名或 `auto` |
| `APIMART_IMAGE_QUALITY` | `medium` | `low/medium/high/xhigh/max`（官方线按档涨价；`auto` 会按最高档预留额度） |
| `APIMART_BASE_URL` | `https://api.apimart.ai/v1` | 换网关/自建代理时用 |
| `APIMART_ANSWER_WITHIN_MS` | `20000` | 一次调用内联等多久；超时就回一个 id，用 `generation_result` 再取 |
| `APIMART_POLL_MS` | `2500` | 轮询间隔 |
| `APIMART_NO_PROXY` | — | `1` 表示不走代理 |

**代理**：Node 的 `fetch` 不认代理，而 APIMart 在部分网络下必须走代理。所以 `core.mjs` 在需要时改用 `curl`：优先环境变量（`HTTPS_PROXY`/`ALL_PROXY`/`HTTP_PROXY`），否则读 macOS 的系统代理（`scutil --proxy`，即代理 App 设的那个），都取不到才直连。

## 二、插件入口：gateway 级能力（每台机器两条命令）

插件不在同步范围里（`plugins.json`、插件文件夹、Bun 运行时都不同步），所以每台机器要装一次：

```sh
magpie plugin add github:liuyf5231/magpie_apimart
magpie plugin login apimart          # 填 sk-…（没有就只装插件）
```

仓库里的 `install.sh` 把这两步（加上从 Keychain 取 key）串起来，并处理"仓库又变回 private"的情况（那时 `github:` 会被 Bun 以无凭据的 tarball 请求拒掉，脚本自动改成 `git clone` + 按路径装）：

```sh
curl -fsSL https://raw.githubusercontent.com/liuyf5231/magpie_apimart/main/install.sh | bash
```

更新已装好的插件：`magpie plugin update`。

之后任何客户端都能点名出图：

```sh
curl -s http://127.0.0.1:3425/v1/images/generations \
  -H 'Authorization: Bearer magpie' -H 'Content-Type: application/json' \
  -d '{"model":"apimart/gpt-image-2.5-ext","prompt":"雨夜重庆小面摊，霓虹招牌写着“重庆小面”","size":"2880x2880"}'
```

**一处限制**：magpie 的 `gateway/draw.go` 里 `Drawers(p)` 对**任何带账号的 provider 直接返回空**（插件 provider 必有账号），所以它不会出现在 `Settings → Images` 的下拉里，`AutoDrawer()` 也不会自动选它。显式点名 `apimart/<模型>` 正常出图；想让内置的 `magpie mcp image`（schema 里没有 model 参数）也走 APIMart，就把 `~/.config/magpie/settings.json` 的 `imageGen` 设成 `apimart/gpt-image-2.5-flare`（校验本来就要求 `provider/model` 形式）。注意 `settings` 属于同步部分，这个值会同步到别的机器——那边没装插件时会显示"选定的出图模型已失效"。

## 三、模型、线路与尺寸

默认只暴露 APIMart 的 GPT Image 2.5 与 Nano Banana 2.1，两条线都在。**线路就是模型 id**（APIMart 没有单独的线路开关）：

| 模型 id | 线路 | 计费 |
|---|---|---|
| `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst` | 官方线 | 按 token（1K 低约 $0.005 → 最高约 $0.17） |
| `gpt-image-2.5-ext` | Ext 线 | 按张固定（1K $0.0085 / 2K $0.014 / 4K $0.021） |
| `gemini-nano-banana-2.1` | 官方线 | 按 token |
| `gemini-nano-banana-2.1-ext` | Ext 线 | 按张固定（1K $0.02 / 2K $0.025 / 4K $0.03） |

Ext 线是「一个 model id + `version` 字段」：插件默认发 `sunburst`（Ext 线上 flare 与 sunburst **同价**，sunburst 的编辑精度更好）。插件的 `versions` / `extVersion` 选项可以改；带 `-flare`/`-sunburst` 后缀的 id 表示该 Ext 模型的指定版本（例如列表里同时放 `gpt-image-2.5-ext-flare` 与 `gpt-image-2.5-ext-sunburst`）。

**尺寸**：只有 GPT Image **官方线**收精确像素；Ext 线与 Nano Banana 只收比例名（给像素会被 400）。所以两个入口都把 `WIDTHxHEIGHT` 翻译成「比例 + 1K/2K/4K 档位」：

| 你给 | 实际发出 | 含义 |
|---|---|---|
| `1024x1024` | `size=1:1`, `resolution=1k` | 1K |
| `2048x2048` | `size=1:1`, `resolution=2k` | 2K |
| `2880x2880` | `size=1:1`, `resolution=4k` | 4K |
| `1536x1024`、`3840x2160` | `3:2`、`16:9` + 对应档 | 按官方映射表取最近 |
| `16:9`、`auto`、不填 | 原样 / 不传 | 档位由 APIMart 定 |

⚠️ **Ext 线只按档位出图，实际像素由 APIMart 决定**：实测 1:1 的 `1k` 是 1254×1254、`4k` 是 3840×3840（官方线 `1k` 才是 1024×1024）。要精确像素只能用官方线。

## 四、测试

```sh
node test.mjs        # 插件与 core：桩 fetch，不花钱
node test-mcp.mjs    # MCP server：本地假 APIMart，不花钱
```

`test.mjs` 覆盖：provider 声明与模型清单、线路/版本解析（含 `-flare`/`-sunburst` 后缀与 `versions`/`extVersion` 优先级）、像素→比例+档位换算、loader、两种 submit 形状、轮询到完成、多图、失败任务透传原因、图片模型在 chat 上被 405 转到 images API、模型清单（开关 discover 两种）、余额窗口。

`test-mcp.mjs` 覆盖：`initialize` / `tools/list` / `tools/call`、`generate_image` 落盘的文件与字节、请求体里的模型/版本/尺寸/鉴权、慢任务先回 id 再用 `generation_result` 取回、以及与 `APIMART_API_KEY` 缺省时回落到 Keychain 的行为。

## 六、不要提交密钥（仓库是公开的）

密钥只活在配置里，不在这个仓库里：`~/.config/magpie/library.json` 的 MCP 条目 `env` 存着 `APIMART_API_KEY`，magpie 的 library 同步又把它明文写进各 agent 的 `mcp.json`。仓库这边有两层防呆：

1. **`.gitignore`** 挡住 magpie 自己的凭证文件：
   `library.json`、`mcp.json`、`plugin-auth.json`、`logins.json`、`sync.json`（含 WebDAV 账号/密码/备份口令）、`*.magpie-backup`、`.env*`。
2. **`githooks/pre-commit`** 挡住内容（名字规则挡不住的那种：key 被贴进某个 `.mjs`/README/测试，或 `git add -f`）。每次 clone 后启用一次：

```sh
git config core.hooksPath githooks
```

它会扫**暂存区的内容**（不是工作区），匹配 `sk-…`（≥20 字符）、`sk-ant-`、`ghp_`/`gho_`/`github_pat_`、`AKIA`/`ASIA`、`xox*-`、JWT、`BEGIN … PRIVATE KEY`、以及 `password = "…"` 这类 24 字符以上的赋值；命中就拦下提交，并且**只打印掩码后的片段**（钩子自己不会把密钥写进终端或日志）。占位符 `sk-…`、测试假值 `sk-test` / `sk-test-key` 不会误报。确实需要跳过：`git commit --no-verify`。

钩子不能由仓库自己安装（git 的设计如此），所以换机器/重新 clone 后要重跑那一条 `git config`。

## 五、已知边界

- **只做文生图**：APIMart 要参考图用公网 URL，或走它自己的上传接口（`POST /v1/uploads/images`），尚未接入。
- 仓库是 public：`magpie plugin add github:…` 与 `npx -p github:…` 都不需要凭据。若哪天改回 private，`magpie plugin add github:…` 会失败（Bun 的 tarball 请求不带凭据，`install.sh` 会自动回退到 clone + 路径），而 `npx` 仍可用但要各机 git 有凭据。
- 单张最长等 4 分钟（插件 `waitMs` / MCP 的一次调用 20 秒内联 + `generation_result` 续等）。magpie 自己的 drawTimeout 是 5 分钟。
- 图片 URL 完成后 **72 小时**失效：MCP 入口会把图落成项目文件，插件入口把 URL 交给调用方，及时转存。
- 参数非法时 APIMart 不会同步 4xx，而是提交成功、轮询到 `failed` 才报错；失败的生成全额退款。
- 别把 `apimart` 手工加成普通 provider：magpie 的 `PluginID()` 会把插件那条改名成 `apimart-plugin`，两套配置打架。
