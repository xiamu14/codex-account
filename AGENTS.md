# Codex Account 源码使用说明

## 定位

这是一个只能从源码目录运行的 Bun/TypeScript 本机工具，不提供 npm 包，不提供全局 `cxa` bin。

所有命令都必须在 `codex-account` 目录里执行：

```bash
bun cli <command>
```

## 常用命令

```bash
bun cli install
bun cli start
bun cli stop
bun cli uninstall

bun cli save
bun cli login
bun cli export
bun cli import
bun cli list
bun cli active [alias]
bun cli deactive
bun cli delete [alias]
bun cli call
bun cli call --select
bun cli quota
bun cli quota --select
bun cli quota --start
bun cli quota --stop
bun cli quota --status
bun cli refresh [alias]
bun cli refresh --auto
bun cli refresh --auto --dryRun
```

`install/start/stop/uninstall` 使用 macOS launchd 管理后台服务。

`start` 会启动：

- Web UI + portless 友好访问地址
- quota 后台服务

启动后访问：

```text
http://codexaccount.localhost:1355
```

`bun cli refresh --auto` 只自动刷新 token 已标记失效的账号。它读取
`~/.codex-account/refresh-auto.json`，通过 Roxy 浏览器窗口完成登录。前置检查只读取
Clash controller 的当前代理模式和 RoxyBrowser profile 里的代理国家，不访问 auth.openai.com 或 IP 查询服务。
不要让它修改 ClashVerge 或 Roxy 代理配置；如果 Clash 当前代理模式不是全局，或 Roxy 代理国家不符合配置，应让用户先手动修正。

`bun cli refresh --auto --dryRun` 用于调试前置条件，会跳过 invalid token 过滤，
选择任意账号，只检查 Roxy 窗口、Clash 当前代理模式和 Roxy 代理国家，不打开 OpenAI 登录页，也不替换 token。

## 给 AI 的安装和使用 Prompt

当需要在新设备或新工作区部署这个项目时，把下面这段 prompt 交给 AI 执行：

```text
请在本机从源码部署 Codex Account。不要使用 npm 全局安装，不要使用 cxa 命令，不要使用 Docker。

操作步骤：
1. 进入 codex-account 源码目录。
2. 运行 bun install 安装依赖。
3. 运行 bun cli install 安装 macOS 后台服务。
4. 运行 bun cli start 启动后台服务。
5. 启动完成后只需要告诉我：
   Web UI:
     http://codexaccount.localhost:1355

   CLI:
     bun cli list
     bun cli active
     bun cli quota
     bun cli quota --start
     bun cli quota --stop

注意：
- 不要手动编辑 launchd plist。
- 不要使用 Docker。
- 不要安装或调用全局 cxa。
- 如果需要完整能力，继续使用 bun cli 命令。
- 如果要停止后台服务，运行 bun cli stop。
- 如果要卸载后台服务，运行 bun cli uninstall。
```

## 工程约束

- 使用 Bun 作为包管理工具和测试运行工具。
- 使用 TypeScript 实现。
- 严格通过 TypeScript type check。
- 不允许新增不必要的全局 CLI bin。
- 构建产物不进入 Git：`src/web/dist/` 和 `src/web/static/alignui.css` 都由构建生成。

## 本地数据目录

默认目录：

```text
~/.codex-account/
```

账号数据保存在：

```text
~/.codex-account/accounts/<alias>/
```

只删除或修改本工具自己的数据，不主动删除用户的账号记录。
