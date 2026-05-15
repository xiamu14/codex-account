# Codex Account

## AI 快速自动安装与启动

把下面这段发给 AI，让它在本机自动完成安装和启动：

```text
请在本机从源码部署 Codex Account。不要使用 Docker，不要使用 npm 全局安装，不要使用 cxa 命令。

操作步骤：
1. 进入 codex-account 源码目录。
2. 运行 bun install 安装依赖。
3. 运行 bun cli install 安装 Web UI 与定时任务。
4. 运行 bun cli start 启动 Web UI 与定时任务。
5. 启动完成后，只需要告诉我：
   Web UI:
     http://codexaccount.localhost:1355

   CLI:
     bun cli --help

注意：
- 所有命令都必须在 codex-account 源码目录里执行。
- 不要手动编辑 launchd 配置。
- 如果要停止，运行 bun cli stop。
- 如果要卸载，运行 bun cli uninstall。
```

手动执行时也一样：

```bash
bun install
bun cli install
bun cli start
```

启动后访问：

```text
http://codexaccount.localhost:1355
```

## 使用方式

这个工具只从源码目录运行，不提供 npm 包，也不提供全局 `cxa` 命令。

```bash
bun cli --help
```

`bun cli start` 会同时启动：

- Web UI
- 额度定时刷新任务

## 添加多账号

多账号的核心方式是：先让 Codex 登录到某个账号，再把这个账号保存到 Codex Account。

### 保存当前已登录账号

如果你当前 Codex 已经登录了一个账号，运行：

```bash
bun cli save
```

这个账号会保存到本地账号列表中。

### 登录并保存新账号

如果要添加另一个账号，运行：

```bash
bun cli login
```

按提示完成登录后，这个账号会保存到本地。

重复执行 `bun cli login`，就可以继续添加更多账号。

## 管理账号

打开 Web UI 后，可以直接查看账号、额度、失败记录，也可以切换激活账号：

```text
http://codexaccount.localhost:1355
```

也可以继续使用命令行：

```bash
bun cli deactive
bun cli delete
bun cli refresh
bun cli subscription
```

常用含义：

- `bun cli deactive`：退出当前激活账号
- `bun cli delete`：删除保存的账号
- `bun cli refresh`：刷新账号 token
- `bun cli subscription`：更新订阅到期时间

## 额度刷新

手动刷新额度：

```bash
bun cli quota
```

选择账号刷新额度：

```bash
bun cli quota --select
```

停止自动刷新：

```bash
bun cli quota --stop
```

## 停止和卸载

停止 Web UI 与定时任务：

```bash
bun cli stop
```

卸载 Web UI 与定时任务：

```bash
bun cli uninstall
```

