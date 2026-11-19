# 周谱 · weekprofiler 3

以每周循环为核心的个人日程工具。本版新增 04:00 分日、按当前分组创建任务、使用 Codex 订阅的 AI 对话排程。

## 打开与升级

普通排程：解压后双击 `weekprofiler-preview.html`，不需要联网或安装依赖。

旧版升级：先在旧版「导出与备份」导出 JSON，再在新版「设置 → 从 JSON 备份恢复」导入。不同浏览器、文件路径和本机网址的数据互不保证共用；确认导入成功前，请保留旧文件和备份。新版本仍支持 V1/V2 备份。

原来的 `dayloom-preview.html` 和 `start-dayloom.cmd` / `.ps1` 继续保留兼容，打开后的界面也已更名为「周谱 · weekprofiler」。已有用户可以继续使用原来的 HTML 文件路径；若改用 `weekprofiler-preview.html`，请先从原页面导出 JSON，再在新页面导入。浏览器存储键保持不变，避免仅因品牌更名丢失原路径下的数据。

数据只保存在当前浏览器中，不会跨设备自动同步。请定期导出 JSON。

## 本地数据保存在哪里

日常使用的独立 HTML 和 `start-weekprofiler.cmd` 本机服务，都把任务、模板、日程和设置保存在当前浏览器的 `localStorage` 中。修改后会自动保存；数据不会写回 HTML 文件，也不会自动生成项目目录中的 JSON 文件。本机 AI 服务只提供网页和 AI 接口，不另存一份日程数据库。

| 打开方式 | 保存位置 |
| --- | --- |
| 双击 `weekprofiler-preview.html`（或兼容入口 `dayloom-preview.html`） | 该文件在当前浏览器、当前用户配置中的本地存储 |
| `start-weekprofiler.cmd`、`start-weekprofiler.ps1`、兼容的 `start-dayloom` 脚本、`npm start` 或 `node local-ai-server.mjs` | 本机网址的浏览器本地存储，默认来源为 `http://127.0.0.1:5173` |
| 开发用 `npm run dev` / `node preview.mjs`（需先构建） | 启动工作目录下的 `.sites-runtime/preview.sqlite`，以及浏览器缓存；在项目目录启动时即为项目内该路径 |
| 未来部署的私有在线站点 | 服务端 D1 数据库，按登录用户隔离，并保留浏览器缓存；当前尚未发布 |

日常两种本机模式使用 `dayloom-portable-db` 保存已提交的数据，使用 `dayloom-v1-portable-preview` 保存当前内容、版本与待保存状态。开发预览的浏览器缓存键为 `dayloom-v1-local-preview-owner`；在线模式则为 `dayloom-v1-<用户ID>`。这些键沿用旧名称以保留已有数据。可以在周谱页面的浏览器开发者工具中，打开「应用 / Application → 本地存储 / Local Storage」，查看对应页面来源下的这些键。

浏览器、用户配置、网址协议、主机名和端口不同，存储就会分开。例如 `localhost:5173` 与 `127.0.0.1:5173` 不共用日程；从独立文件切换到本机网址也应通过 JSON 导出、导入迁移。直接打开文件的存储行为由浏览器决定，移动或重命名 HTML 后不能保证仍读取原数据。

Windows 下，浏览器把这些记录放在自己的用户配置目录中。Chrome 的常规目录是 `%LOCALAPPDATA%\Google\Chrome\User Data\<配置目录>`，实际路径可在 `chrome://version` 的「个人资料路径 / Profile Path」查看。Edge 的常规目录是 `%LOCALAPPDATA%\Microsoft\Edge\User Data\<配置目录>`，实际路径可在 `edge://version` 查看。配置目录可能是 `Default`、`Profile 1` 或自定义目录；这里没有读取或确认你当前使用的浏览器配置路径。参见 [Chrome 官方目录说明](https://chromium.googlesource.com/chromium/src/+/main/docs/user_data_dir.md)和 [Edge 官方目录说明](https://learn.microsoft.com/en-us/deployedge/edge-learnmore-create-user-directory-vars)。

需要一份位置明确、可迁移的文件时，点击「导出与备份 → 完整数据备份」，会下载 `weekprofiler-backup-日期.json` 到浏览器的下载位置或你选择的目录。该备份包含任务、模板、日程和设置；可通过「设置 → 从 JSON 备份恢复」恢复，也继续支持原来的 `dayloom-backup-日期.json` 备份。清除浏览器站点数据会移除本机记录，所以升级、换浏览器或清理数据前应先导出备份。

## 一天从 04:00 开始

- 周一指周一 04:00 到周二 04:00。
- 周一页面里的「次日 01:00」实际是周二凌晨 01:00。
- 凌晨 04:00 前点击「今天」，会显示前一个排程日，按照设置中的日程时区判断。
- 日模板、周模板、周循环、拖动、时长调整及 ICS 导出都采用同一边界。
- 旧的具体日期安排按实际发生时间迁移：凌晨安排归入前一排程日；跨 04:00 的安排拆分。原日期例外附近的部分循环可能转为固定日期安排，以保留当时的真实日程。
- 旧日模板的凌晨安排移到模板末尾；周模板/周循环则按真实星期归到前一天。
- 忙碌/空闲统计覆盖完整 24 小时。时间粒度仍为 30 分钟。

在任务分组筛选下新建任务，会默认放进当前分组。周视图或周模板聚焦某个分组时，新增安排也会默认使用该组。已有任务编辑时保留自己的分组。

## AI：使用 Codex 订阅额度

AI 通过你电脑上的官方 Codex CLI 运行，要求使用 ChatGPT 账号登录。不会请求 API Key，也不会在订阅额度不足时切换到付费 API。受你的 Codex 订阅额度、模型权限和频率限制约束。

### 首次准备

1. 安装 Node.js 22 或更新版本，确保终端能运行 node 和 npm。
2. 在终端安装官方 Codex CLI：

    npm install -g @openai/codex

3. 双击 login-codex.cmd，在官方登录流程中用你的 ChatGPT 账号登录。也可以手动运行 codex login，选择 ChatGPT 登录。
4. 双击 `start-weekprofiler.cmd`（PowerShell 也可运行 `start-weekprofiler.ps1`），保持打开的命令窗口运行。
5. 在浏览器打开窗口显示的本机网址，默认 http://127.0.0.1:5173。
6. 若此前使用独立 HTML，在新网址中导入此前导出的 JSON 备份。

已有 Codex 桌面应用不一定意味着 CLI 命令已安装。网页「AI → 检查连接」会显示当前状态。登录凭据由 Codex 自己管理；周谱不读取或复制凭据文件。

需要自定义本机端口时，可在启动前设置环境变量 `WEEKPROFILER_PORT`；需要指定 Codex CLI 可执行文件时，使用 `WEEKPROFILER_CODEX_BIN`。旧的 `DAYLOOM_PORT` 和 `DAYLOOM_CODEX_BIN` 仍可使用；同时设置新旧名称时，以新名称为准。更换端口会切换浏览器存储来源，应先导出原端口的 JSON 备份，再在新端口导入。

### 对话排程

点击右上角「✦ AI」，选择一天/一周、日期和任务分组。例如：

“把学习任务安排在下午，每天最多两小时；晚上留出休息时间。”

会发送选定范围内的已有安排、所选分组的任务及本次对话。每次最多整理 100 个任务，默认保留所有已有安排。模型只能选择已存在的任务，不能随意新增或改名。

生成后显示草案及未安排任务，可以继续对话调整。只有「确认应用」才会写入日程，且支持撤销。确认前会再次检查任务、日期边界和冲突；期间数据变化则要求重新生成。关闭对话或停止生成会取消正在进行的本机请求。

AI 用于具体日期的日程。应用后，可再用「存为日模板/周模板」保存成循环安排。

### 当前限制

- AI 需要电脑开机且本机服务运行；此入口仅允许本机访问，手机不能独立调用电脑上的 Codex。
- 本次已验证模型、迁移、接口模拟及真实浏览器对话流程；未在已登录的 Codex CLI 上验证真实生成，首次使用需在你的电脑上完成连接。
- 现有私有在线站点仍未成功发布，跨设备云同步尚不可用。
- HarmonyOS 4.3.0.208 的真机兼容性仍待验证。

## 周模板与循环

在「模板 → 日模板」安排一天，点击「每周应用」选择周几；也可以在「周模板」配置完整一周。支持按天选择日模板、编辑单个时间块、跨天拖动、复制、保存和应用周模板。

「启用周循环」按每 7 天重复，可设置起止日期。「应用周模板」则生成具体日期的安排。临时改动某一天会保留为例外；在日视图点击「恢复周循环」可移除该例外。

日模板、周模板、循环与具体日期使用独立快照。修改日模板不会自动改动已保存的周安排，需重新选择模板后更新。

## Windows / Outlook 日历

「导出与备份」可以导出一天、本周或从本周起 4 周的 ICS；凌晨事件会落在真实的次日日期。

在 Outlook 网页版「日历 → 添加日历 → 从文件上传」导入，Windows Outlook 使用同一账号查看。建议使用单独的「周谱」日历。

当前为手动导入快照，不会自动更新。重复导入是否去重取决于日历客户端。

ICS 事件的 UID 保留原来的 `@dayloom` 后缀，以维持更名前后同一事件的标识；显示名称使用「周谱」。

## 源代码与检查

项目不需要额外 Node 依赖；Codex CLI 单独安装。

    node build.mjs
    node portable.mjs
    node --test tests/*.test.mjs
    node local-ai-server.mjs

- web/：日/周视图、模板、分组及 AI 对话。
- lib/planner.mjs：验证、迁移、周循环、日期例外及 04:00 边界。
- lib/ai-planner.mjs：AI 上下文、输出约束和方案验证。
- lib/codex-transport.mjs：仅 ChatGPT 登录的 Codex CLI 接入。
- local-ai-server.mjs：只监听本机的 AI 服务，浏览器继续本地保存排程。
- worker/：尚未发布的私有云日程入口，按用户隔离，包含版本冲突处理。
- tests/：迁移、排程、接口、确认应用、并发、取消和身份检查。
- weekprofiler-preview.html：独立 HTML 主入口；dayloom-preview.html 保留为兼容入口。
- start-weekprofiler.cmd / .ps1：本机启动入口；start-dayloom.cmd / .ps1 保留兼容。
- login-codex.cmd：用户主动运行的官方 Codex 登录入口。

如需部署到 Sites，请在本机配置自己的 `.openai/hosting.json`。构建时会将它和数据库迁移一起复制到部署目录。使用本地预览时，运行 `node build.mjs` 后再运行 `node preview.mjs`。
