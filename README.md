# cursor_opus_hack

让 Anthropic 的 Claude 模型显示在 Cursor 桌面端的模型选择器中。

支持 Claude Opus 5.5、Claude Sonnet 5.5、Claude Opus 5 和 Claude Opus 4.8，包含上下文长度、Effort、Thinking 和 Fast 等参数配置。各模型的参数选项由 `hook.js` 中的定义提供。

本项目在本地扩展中管理模型列表，不修改代理设置或 Cursor 应用本体。安装时只为本项目扩展添加加载签名例外，不关闭全局签名验证。

## 实现方式

- `install.sh` 将内置扩展 `anysphere.cursor-always-local` 复制到用户扩展目录 `~/.cursor/extensions/`，安装版本的补丁号加 1，并将入口设置为 `hook.js`。
- `hook.js` 包装 `vscode.cursor.registerConnectTransportProvider`，随后加载原版扩展代码，在 `aiserver.v1.AiService.AvailableModels` 响应中添加尚未包含的 Claude 模型条目。
- 沿用原扩展 ID，内置扩展的 `dist` 文件保持原样；hook 和生成的模型 schema 位于 `node_modules/hook/dist/`。
- 保留已有模型条目、参数配置和响应中的其他字段，不处理 Tab 补全使用的 `CppService.AvailableModels`。

## 安装与使用

需要 macOS、已安装且至少启动过一次的 Cursor，以及带标准库 `sqlite3` 的 Python 3；无需安装第三方 Python 包。扩展安装和 schema 提取使用 Cursor 自带的 Node.js。

首次安装前，请完整退出 Cursor（`Cmd+Q`），再运行：

```bash
./install.sh
```

重新启动 Cursor 后生效。签名例外已经就绪时，重复安装不会写应用数据库，可以在 Cursor 运行期间同步扩展；同步后按 `Cmd+Shift+P` 执行 `Developer: Reload Window`。

Cursor 安装在其他位置时，可以指定应用路径：

```bash
CURSOR_APP=/path/to/Cursor.app ./install.sh
```

打开输入框中的当前模型菜单即可查看模型列表。新版界面先显示设置菜单，点击其中的 `Model` 可展开模型列表。

Cursor 会沿用每个模型上次保存的参数，例如 Opus 5.5 的 `1M · Max · Fast`。

## 加载签名例外

在本机 Cursor `3.31.15` 中确认，用户目录内的 Anysphere 扩展会接受加载签名检查；本地修改过的覆盖扩展无法通过官方包签名验证。这不表示该检查首次引入于此版本。

安装和卸载共享 `signature-overrides.py`，管理 Cursor 应用级内部存储中的以下键值，而不是普通的 `settings.json` 配置：

```json
{
  "cursor.extensions.anysphereSignatureOverrides": [
    "anysphere.cursor-always-local"
  ]
}
```

- 只添加本项目的扩展 ID，保留其他扩展的已有例外，并设置该键的机器级存储目标。
- 例外按扩展 ID 生效，不是只信任当前版本或当前文件的哈希；该 ID 后续安装的代码也会被放行。
- 在当前 Cursor 的工作台代码中检测例外机制；不包含该机制的旧版不会新增此配置。
- 需要写数据库时，先检查 Cursor 已完全退出，再定向备份并使用 SQLite 事务。不会强制停止应用，也不会复制整个应用数据库。
- 签名例外已就绪时只读检查，支持在 Cursor 运行期间重复安装和自动同步。
- 发现不认识的配置格式时停止操作，不重置用户已有数据；schema 校验失败时也不修改签名例外。

数据库位于 `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`。每次实际修改前的定向备份位于同目录的 `cursor-opus-hack-backups/`，只记录本次配置项及其原存储目标，不记录其他设置。备份文件权限为 `0600`，保留供人工恢复。

## 升级后自动同步

`install.sh` 会注册 LaunchAgent，由它运行 `watch.sh`，在 Cursor 更新后同步本地扩展与模型 schema。

- 应用所在目录发生变化时进行检查，另外每 5 分钟检查一次。
- 比较内置扩展与本地副本的 `dist` 文件，核对生成模型 schema 的 Cursor 版本，并只读检查签名例外是否就绪。
- 文件、版本和签名例外一致时直接退出；需要同步时重新安装、生成 schema，并发送系统通知。

收到同步通知后，如果 Cursor 已打开，执行一次 `Developer: Reload Window` 即可加载当前版本。若升级后首次需要添加签名例外且 Cursor 仍在运行，同步会安全失败并记录原因；完整退出 Cursor 后可运行 `./install.sh`，或等待下一次自动检查。

LaunchAgent 配置位于 `~/Library/LaunchAgents/com.yzs-lab.cursor-opus-hack.plist`，同步日志位于 `~/Library/Logs/cursor_opus_hack.log`。查看运行状态：

```bash
launchctl print gui/$(id -u)/com.yzs-lab.cursor-opus-hack
```

移动项目目录后，重新运行 `./install.sh` 更新 LaunchAgent 中的项目路径。

## 响应格式兼容

支持对象响应和原始 protobuf 字节响应。hook 使用服务提供的模型 schema，或加载安装时生成的 schema；字节响应处理完成后保留原有消息封装格式。

`install.sh` 调用 `schema.js`，从当前 Cursor 的生成代码中提取 `AvailableModelsResponse` 及其依赖定义，使用 Cursor 自带 protobuf 运行时校验二进制往返，并写入 `node_modules/hook/dist/available-models.js`。这一过程只加载模型 schema，不启动应用 bundle。

schema 校验在替换本地扩展和修改签名例外前完成；未通过校验时保留现有安装。自动同步会为当前 Cursor 版本生成对应的 schema。

## 卸载

先完整退出 Cursor（`Cmd+Q`），再运行：

```bash
./uninstall.sh
```

卸载会撤销 `anysphere.cursor-always-local` 的签名例外，保留其他扩展的例外和存储目标，并删除 LaunchAgent 与本项目安装的本地扩展。若它是最后一个例外，则同时删除例外配置键及其存储目标条目。重新启动后使用 Cursor 内置扩展。

即使已经降级到不含例外机制的 Cursor，卸载仍会清理本项目的已有例外。需要撤销例外而 Cursor 仍在运行时，卸载会拒绝操作，不先删除扩展或关闭自动同步。

## 日志

在 Cursor 的 Output 面板中选择 `Cursor Opus Hack`，或查看 `~/Library/Application Support/Cursor/logs/<会话>/window*/exthost/anysphere.cursor-always-local/Cursor Opus Hack.*.log`。

模型列表更新的日志示例：

```text
[info] Patched vscode.cursor.registerConnectTransportProvider
[info] Wrapped the connect transport provider
[info] AvailableModels: server returned 30 models; injected claude-opus-5-5, claude-sonnet-5-5, claude-opus-5, claude-opus-4-8
```

## 测试与配置

在安装了 Cursor、Node.js 和 Python 3 的 macOS 上运行：

```bash
node --test tests/hook.test.js
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p '*_test.py' -v
bash -n install.sh uninstall.sh watch.sh
```

模型测试使用当前 Cursor 的 protobuf 定义和自带运行时，无需安装额外依赖、启动 Cursor 或联网。覆盖对象与字节响应、不同服务描述符、重复刷新、未知字段保留、RPC 隔离、错误透传和 schema 校验。Cursor 位于其他路径时，可设置 `CURSOR_APP`。

签名测试使用工作区内的临时 HOME 和模拟的 Cursor 应用，覆盖新增与撤销例外、重复安装、其他 ID 与 TEXT/BLOB 格式保留、机器级存储目标、运行中保护、备份失败回滚、旧版兼容，以及实际安装、卸载和自动同步脚本。不会修改真实 Cursor 配置、LaunchAgent 或发送系统通知。

模型配置位于 `hook.js` 的 `MODEL_SPECS`。调整配置后，重新运行 `./install.sh` 并执行 `Developer: Reload Window`。字段名应与当前 Cursor 的 protobuf 定义一致。
