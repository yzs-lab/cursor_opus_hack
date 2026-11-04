# cursor_opus_hack

让 Anthropic 的 Claude 模型显示在 Cursor 桌面端的模型选择器中。

支持 Claude Opus 5.5、Claude Sonnet 5.5、Claude Opus 5 和 Claude Opus 4.8，包含上下文长度、Effort、Thinking 和 Fast 等参数配置。各模型的参数选项由 `hook.js` 中的定义提供。

本项目在本地扩展中管理模型列表，不修改代理设置或 Cursor 应用本体。

## 实现方式

- `install.sh` 将内置扩展 `anysphere.cursor-always-local` 复制到用户扩展目录 `~/.cursor/extensions/`，安装版本的补丁号加 1，并将入口设置为 `hook.js`。
- `hook.js` 包装 `vscode.cursor.registerConnectTransportProvider`，随后加载原版扩展代码，在 `aiserver.v1.AiService.AvailableModels` 响应中添加尚未包含的 Claude 模型条目。
- 沿用原扩展 ID，内置扩展的 `dist` 文件保持原样；hook 和生成的模型 schema 位于 `node_modules/hook/dist/`。
- 保留已有模型条目、参数配置和响应中的其他字段，不处理 Tab 补全使用的 `CppService.AvailableModels`。

## 安装与使用

```bash
./install.sh
```

在 Cursor 中按 `Cmd+Shift+P`，执行 `Developer: Reload Window`，或重启 Cursor。

Cursor 安装在其他位置时，可以指定应用路径：

```bash
CURSOR_APP=/path/to/Cursor.app ./install.sh
```

打开输入框中的当前模型菜单即可查看模型列表。新版界面先显示设置菜单，点击其中的 `Model` 可展开模型列表。

Cursor 会沿用每个模型上次保存的参数，例如 Opus 5.5 的 `1M · Max · Fast`。

## 升级后自动同步

`install.sh` 会注册 LaunchAgent，由它运行 `watch.sh`，在 Cursor 更新后同步本地扩展与模型 schema。

- 应用所在目录发生变化时进行检查，另外每 5 分钟检查一次。
- 比较内置扩展与本地副本的 `dist` 文件，并核对生成模型 schema 的 Cursor 版本。
- 文件和版本一致时直接退出；需要同步时重新安装、生成 schema，并发送系统通知。

收到同步通知后，如果 Cursor 已打开，执行一次 `Developer: Reload Window` 即可加载当前版本。

LaunchAgent 配置位于 `~/Library/LaunchAgents/com.yzs-lab.cursor-opus-hack.plist`，同步日志位于 `~/Library/Logs/cursor_opus_hack.log`。查看运行状态：

```bash
launchctl print gui/$(id -u)/com.yzs-lab.cursor-opus-hack
```

移动项目目录后，重新运行 `./install.sh` 更新 LaunchAgent 中的项目路径。

## 响应格式兼容

支持对象响应和原始 protobuf 字节响应。hook 使用服务提供的模型 schema，或加载安装时生成的 schema；字节响应处理完成后保留原有消息封装格式。

`install.sh` 调用 `schema.js`，从当前 Cursor 的生成代码中提取 `AvailableModelsResponse` 及其依赖定义，使用 Cursor 自带 protobuf 运行时校验二进制往返，并写入 `node_modules/hook/dist/available-models.js`。这一过程只加载模型 schema，不启动应用 bundle。

schema 校验在替换本地扩展前完成；未通过校验时保留现有安装。自动同步会为当前 Cursor 版本生成对应的 schema。

## 卸载

```bash
./uninstall.sh
```

卸载会删除 LaunchAgent 和本项目安装的本地扩展。执行 `Developer: Reload Window` 后使用 Cursor 内置扩展。

## 日志

在 Cursor 的 Output 面板中选择 `Cursor Opus Hack`，或查看 `~/Library/Application Support/Cursor/logs/<会话>/window*/exthost/anysphere.cursor-always-local/Cursor Opus Hack.*.log`。

模型列表更新的日志示例：

```text
[info] Patched vscode.cursor.registerConnectTransportProvider
[info] Wrapped the connect transport provider
[info] AvailableModels: server returned 30 models; injected claude-opus-5-5, claude-sonnet-5-5, claude-opus-5, claude-opus-4-8
```

## 测试与配置

在安装了 Cursor 和 Node.js 的 macOS 上运行：

```bash
node --test tests/hook.test.js
```

测试使用当前 Cursor 的 protobuf 定义和自带运行时，无需安装额外依赖、启动 Cursor 或联网。覆盖对象与字节响应、不同服务描述符、重复刷新、未知字段保留、RPC 隔离、错误透传和 schema 校验。Cursor 位于其他路径时，可设置 `CURSOR_APP`。

模型配置位于 `hook.js` 的 `MODEL_SPECS`。调整配置后，重新运行 `./install.sh` 并执行 `Developer: Reload Window`。字段名应与当前 Cursor 的 protobuf 定义一致。
