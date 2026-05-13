# cxa 规划

## 目标

`cxa` 是一个纯 CLI 的 Codex 账号管理器。它只负责管理多个 Codex 登录账号、缓存账号和额度信息、手动激活或退出当前账号。

`cxa` 不接管 Codex 会话，不做额度耗尽后的自动切号，不替代 `codex` 执行任务，也不提供 Desktop App。

## 工程约束

- 使用 Bun 作为包管理工具和测试运行工具。
- 使用 TypeScript 实现。
- 严格通过 TypeScript type check。
- 不允许使用 `any`。
- 必须处理不可信数据时使用 `unknown`，并配套明确的 type guard。
- 源码中不能出现 `.js` 文件。
- CLI bin 名称为 `cxa`。

## 设计取舍

- 放弃 Desktop App，统一走 CLI。
- 放弃自动切号，降低触发手机号验证、风控和登录态异常的风险。
- 账号切换必须由用户手动执行。
- 额度只通过 `cxa quota` 主动刷新。
- 额度读取只走 Codex ACP 协议，失败就报错并提示用户重试，不做 `/status` 文本兜底。
- 不自动填写浏览器账号和密码。
- 删除账号只删除 `cxa` 本地保存的信息，不修改 `~/.codex`。

## 命令

```bash
cxa save
cxa login
cxa list
cxa active [alias]
cxa deactive
cxa delete [alias]
cxa call
cxa call --select
cxa quota
cxa quota --select
cxa refresh [alias]
cxa subscription
```

`active`、`delete` 和 `refresh` 都支持不传账号名。不传时进入选择列表，由用户选择目标账号。`call` 和 `quota` 默认对所有本地账号执行；`--select` 进入多选列表，由用户选择一个或多个账号。

不提供 `cxa current`。当前账号信息由 Codex CLI 或 Codex Desktop 自身显示。

`subscription` 用于手动维护订阅到期日期。多个账号时进入选择列表，随后用输入框填写日期；只有一个账号时直接更新这个账号。

## 本地目录

默认目录：

```text
~/.codex-account/
```

建议结构：

```text
~/.codex-account/
├── accounts.json
├── lock
├── accounts/
│   └── <alias>/
│       ├── auth.json
│       ├── meta.json
│       └── quota.json
└── runs/
```

`alias` 必须由用户在保存账号时输入，且应该是可读性良好的名字，推荐直接使用邮箱，例如：

```bash
cxa save
```

不要自动创建 `default` 这类不明确名称。

## accounts.json

`accounts.json` 只保存账号列表、当前激活账号名和必要的全局状态。

示例：

```json
{
  "version": 1,
  "accounts": ["xxx@gmail.com", "yyy@gmail.com"],
  "activeAccount": "xxx@gmail.com",
  "updatedAt": "2026-05-11T00:00:00.000Z"
}
```

账号详情和额度缓存放在各账号目录下，不塞进一个大文件。

## save 流程

`cxa save` 前置检查：

1. 读取 `accounts.json`。
2. 检查真实 `~/.codex/auth.json` 是否存在；不存在则提示先运行 `cxa login` 并退出。
3. 使用 ACP 读取当前 Codex 账号信息。
4. 如果当前登录账号已经保存，提示已保存并退出。
5. 如果未保存，提示用户输入 alias。
6. 如果 alias 已存在，提示已保存并退出。
7. 保存当前登录信息到 `~/.codex-account/accounts/<alias>/auth.json`，保存账号信息到 `meta.json`，并设为当前 active 账号。

`save` 只保存当前已经登录的账号，不主动发起登录流程。

## login 流程

`cxa login` 负责登录一个新账号并保存为本地账号：

1. 先提示用户输入 alias。
2. 如果 alias 已存在，提示已保存并退出，不发起登录。
3. 使用隔离的临时 `CODEX_HOME` 发起登录，不检查、不读取、不复用真实 `~/.codex` 的当前登录状态。
4. 展示登录链接并等待用户完成登录。
5. 登录完成后从临时目录读取账号信息和 `auth.json`。
6. 如果这个登录账号已按邮箱保存过，提示已保存并退出，不重复创建。
7. 如果未保存，则保存到 `~/.codex-account/accounts/<alias>/`。
8. 登录成功后不设置为当前 active 账号，也不修改真实 `~/.codex`。

新账号添加成功后，不立刻密集请求账号信息和额度。可以延迟约 1 分钟后再用 ACP 拉取 account 和 quota，也可以提示用户稍后执行 `cxa quota`。

## list 流程

`cxa list` 只读本地缓存，不实时请求网络。

显示内容：

- 账号别名
- 是否 active
- 账号邮箱
- 套餐信息
- 订阅到期时间
- 5h limit
- weekly limit
- 缓存更新时间

没有缓存时显示 `unknown`，并提示用户运行：

```bash
cxa quota
```

订阅到期日期由用户手动维护。日期临近到期前 2 天时，`list` 需要突出提示；如果已经过期，也要明显提示。

## active 流程

`cxa active [alias]`：

1. 如果未传 alias，展示本地账号选择列表。
2. 如果目标账号不存在，报错。
3. 获取操作锁，避免和 `quota`、`delete`、`deactive` 并发。
4. 退出 Codex Desktop。
5. 删除真实 `~/.codex/auth.json`，只清掉当前 account 的登录态，不调用 `codex logout`。
6. 使用复用的登录/激活逻辑，让目标账号成为真实 `~/.codex` 的当前账号。
7. 通过 ACP 读取真实 `~/.codex` 当前账号，确认已切到目标账号。
8. 更新 `accounts.json` 的 `activeAccount`。
9. 重新拉起 Codex Desktop。

如果已有本地保存的 `auth.json`，可以复制到真实 `~/.codex/auth.json` 来恢复账号登录态；如果恢复失败，再提示用户重新登录。

## deactive 流程

`cxa deactive`：

1. 获取操作锁。
2. 退出 Codex Desktop。
3. 删除真实 `~/.codex/auth.json`，只退出当前 account，不调用 `codex logout`。
4. 清空 `accounts.json` 的 `activeAccount`。
5. 不删除 `cxa` 本地账号信息。

是否重新拉起 Codex Desktop 可以后续加配置，默认可以不拉起。

## delete 流程

`cxa delete [alias]`：

1. 如果未传 alias，展示本地账号选择列表。
2. 如果目标账号不存在，报错。
3. 如果目标账号正处于 active 状态，提示用户先执行 `cxa deactive`，不直接删除。
4. 只删除 `~/.codex-account/accounts/<alias>/` 和 `accounts.json` 里的记录。
5. 不修改 `~/.codex`，不调用 `codex logout`。

## quota 流程

`cxa quota` 负责刷新所有账号的账号信息和额度信息。`cxa quota --select` 进入多选列表，只刷新选中的一个或多个账号。

每个账号都使用隔离目录执行 ACP：

1. 为账号创建临时 `CODEX_HOME`。
2. 复制该账号的 `auth.json` 到临时目录。
3. 只挂载或复制 ACP 必需的 Codex 配置。
4. 通过 `codex app-server` / ACP 调用：
   - `account/read`
   - `account/rateLimits/read`
5. 成功后写入该账号的 `meta.json` 和 `quota.json`。
6. 失败则记录错误并报告给用户，不做 `/status` 文本兜底。

如果刷新时发现账号套餐已经不是订阅套餐，则把本地订阅到期日期更新为 `unknown`，避免保留过期或错误信息。

这里应异步执行，但要避免多个账号共用同一个可写 `~/.codex`。每个账号必须有自己的隔离运行目录，不能在真实 `~/.codex` 上同步来回切换，否则会和当前 Codex CLI / Desktop 状态互相影响。

可以并发刷新多个账号，但需要控制并发数，例如 2 或 3，避免触发过多请求。

## call 流程

`cxa call` 负责给账号发一条极短消息，用于触发 quota reset 相关状态刷新：

1. 默认对所有本地账号并发执行。
2. 如果传 `--select`，展示多选账号列表，只执行用户选择的账号。
3. 每个账号使用隔离临时 `CODEX_HOME`，复制该账号保存的 `auth.json`。
4. 使用预设 10 条极短消息随机选择一条，执行一次 `codex exec`。
5. 成功时输出 `已 call <alias>`。
6. 单个账号无额度时，只报告这个账号没有可用额度，不影响其他账号。
7. 单个账号 token 过期时，只提示运行 `cxa refresh <alias>`，不 deactive，不修改当前 Codex 登录态，不影响其他账号。
8. 执行结束后清理临时目录。

## refresh 流程

`cxa refresh [alias]` 负责刷新本地保存账号的 token：

1. 如果未传 alias，展示本地账号选择列表。
2. 如果目标账号不存在，报错。
3. 获取操作锁，避免和 `active`、`delete`、`deactive`、`quota` 并发。
4. 创建临时 `CODEX_HOME`，走和 `cxa login` 相同的账号登录流程。
5. 登录完成后读取临时目录里的账号信息和 `auth.json`。
6. 确认本次登录账号和目标账号匹配。
7. 用临时目录里的 `auth.json` 替换目标账号本地保存的 token，并更新 `meta.json`。
8. 清理临时目录。

`refresh` 不读取真实 `~/.codex/auth.json`，不要求当前 Codex 已登录，也不修改当前 Codex 登录态。

## ACP 数据

优先使用结构化 ACP 方法：

- `account/read`：读取账号邮箱、套餐、订阅等信息。
- `account/rateLimits/read`：读取 5h limit 和 weekly limit。

不解析 `/status` 文本。

## 并发和锁

以下命令必须持有全局操作锁：

- `active`
- `deactive`
- `delete`
- `update`

避免同时修改本地账号数据、真实 `~/.codex` 或 Codex Desktop 状态。

`list` 可以不加锁，只读缓存。

## 错误处理原则

- 同名账号：直接报错。
- ACP 失败：报错并提示重试。
- 账号正在 active 时 delete：提示先 deactive。
- 登录完成但没有生成 `auth.json`：报错。
- active 后 ACP 校验账号不匹配：回滚或提示用户重新登录。

## 后续实现优先级

1. 初始化项目和 `cxa` bin。
2. 实现本地目录、`accounts.json`、账号增删查。
3. 实现 `add` 的同名检查和当前登录绑定。
4. 实现隔离 `codex login`。
5. 实现 ACP account/quota 读取。
6. 实现 `list` 缓存展示。
7. 实现 `active`、`deactive`、`delete` 的选择交互和锁。
8. 实现 `update` 的隔离并发刷新。
