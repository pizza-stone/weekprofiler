# 自托管周谱云同步

这套部署适合一个人在多台设备间同步。Cloudflare Worker 提供网页和同步接口，D1 保存这套实例的日程和登录会话。Google 验证登录者的身份，只有你在 Worker 中指定的邮箱可以访问日程。每个使用者都可以用自己的账号和数据库部署一份。

## 1. 准备工具和账号

准备 Node.js 24 LTS、pnpm、一个可以创建 Worker 和 D1 的 Cloudflare 账号，以及一个可以创建 Google OAuth 客户端的 Google Cloud 项目。在 Cloudflare 控制台确认账号所用套餐。使用 `workers.dev` 地址可以省去购买域名的步骤。可用额度随账号与套餐而定。[Cloudflare 的 workers.dev 说明](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)

在周谱项目根目录安装锁文件中指定的部署工具，并登录 Cloudflare 账号。

```sh
pnpm install --frozen-lockfile
node scripts/cloudflare.mjs login
node scripts/cloudflare.mjs whoami
```

在浏览器完成授权，核对显示的 Cloudflare 账号。若这台电脑无法接收浏览器回调，可以改用 `node scripts/cloudflare.mjs login --device`，按终端提示输入设备码。

## 2. 创建数据库和部署配置

默认的 Worker 和数据库名称都是 `weekprofiler`。如果你的 Cloudflare 账号已有同名应用，先把仓库中的 `wrangler.example.jsonc` 另存为 `wrangler.jsonc`，在本机副本中为 `name` 和 `d1_databases[0].database_name` 选择新名称。数据库绑定名请保留 `DB`。

```sh
node scripts/cloudflare.mjs create-db
```

记下命令返回的数据库 UUID。运行配置命令前，将引号内文字换成实际 UUID。

```sh
node scripts/cloudflare.mjs configure --database-id "你的数据库UUID"
```

部署助手根据模板或现有本机配置生成带数据库绑定的 `wrangler.jsonc`，此文件被 Git 忽略。[Cloudflare D1 创建与绑定说明](https://developers.cloudflare.com/d1/get-started/)

## 3. 首次部署，取得自己的网址

```sh
node scripts/cloudflare.mjs migrate
node build.mjs
node scripts/cloudflare.mjs dry-run
node scripts/cloudflare.mjs deploy
```

`migrate` 对配置指定的远程 D1 应用仓库中的数据库迁移。首次发布时，如果 Wrangler 提示启用账号的 `workers.dev` 子域名，按提示选定即可。记下部署完成后输出的 HTTPS 网址，下一步需要它。此时静态页面可以加载，数据接口要等登录配置完成后才开放。

## 4. 创建 Google 登录客户端

1. 在 Google Cloud 的目标项目中打开 **Google Auth Platform**，设置应用显示名、支持邮箱和受众，按控制台提示完成同意屏幕配置。个人 Gmail 使用外部受众。项目若处于测试状态，请把准备登录周谱的邮箱加入测试用户。
2. 在 **Clients（客户端）** 创建 **Web application（Web 应用）** 类型的 OAuth 客户端。
3. 在 **Authorized redirect URIs（已获授权的重定向 URI）** 填写刚部署的 HTTPS 网址，在末尾加上 `/api/auth/callback`。例如 Worker 名为 `weekprofiler`，账号子域为 `your-subdomain`，回调应为 `https://weekprofiler.your-subdomain.workers.dev/api/auth/callback`。请使用自己的实际域名，结尾没有斜杠。
4. 保存 Google 返回的 **Client ID** 和 **Client secret**，下一步会用到。周谱申请 `openid email` 两个身份范围。[Google Web 应用 OAuth 配置说明](https://developers.google.com/identity/protocols/oauth2/web-server)

## 5. 绑定允许的邮箱

逐条执行命令，在 Wrangler 随后的输入框中分别粘贴客户端 ID、客户端密钥和你允许登录的完整 Google 邮箱。命令行只填写变量名。[Cloudflare Worker Secrets 文档](https://developers.cloudflare.com/workers/configuration/secrets/)

```sh
node scripts/cloudflare.mjs secret GOOGLE_CLIENT_ID
node scripts/cloudflare.mjs secret GOOGLE_CLIENT_SECRET
node scripts/cloudflare.mjs secret ALLOWED_EMAIL
```

`ALLOWED_EMAIL` 接受一个邮箱。**更改它会把这套实例现有日程的访问权交给新的邮箱。** 给另一人部署时，应为对方创建独立实例和数据库。

## 6. 在电脑和手机上验证

1. 打开刚部署的网址，使用允许的 Google 邮箱登录。新建一个示例任务，再用手机打开同一网址并登录，检查能否看到它。
2. 在电脑上给示例任务开始计时，在手机上结束，检查两端同步后的执行记录。手机端可通过浏览器的「添加到主屏幕」或「添加至桌面」入口保存这个网址。
3. 等页面首次在线加载、登录和缓存完成后，断网编辑一项任务，再联网确认同步。两端同时改了同一项时，按界面的冲突提示处理。待同步的修改留在设备上。
4. 已在独立 HTML 中使用周谱的用户，可以从原页面的「日历导出与备份」导出完整 JSON，再到云端页面的「设置 → 从 JSON 备份恢复」导入。导入会替换云端已有内容，先保留目标端的备份。成功后，其他设备通过同一账号同步即可。

## 后续更新

在保存有本机 `wrangler.jsonc` 的项目目录更新源码，运行 `pnpm install --frozen-lockfile`，再依次执行第 3 步的迁移、构建和部署命令。刷新两端的周谱页面即可使用新版。打开已安装的手机应用后若仍看到旧界面，可关闭此前打开的周谱页面和应用窗口，再重新打开。

若 Google 提示 `redirect_uri_mismatch`，核对登录时浏览器地址与客户端登记的协议、主机名、回调路径。若周谱提示账号无权访问，核对当前 Google 账号与 `ALLOWED_EMAIL`。若提示数据库尚未准备好，检查本机配置中的数据库 UUID，并在该配置下执行 `node scripts/cloudflare.mjs migrate`。
