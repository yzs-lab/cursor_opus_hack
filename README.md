# cursor_opus_hack

让 Cursor 桌面端的模型选择器重新出现 Claude Opus 5.5、Sonnet 5.5、Opus 5、Opus 4.8。

出口在香港等地区时，Cursor 返回的模型列表（`AvailableModels`）会去掉全部 Anthropic 模型，但后端仍然接受 Claude 的请求，所以 `agent` CLI 能用。这个项目只在本地把缺失的模型补回列表，不改代理，也不改 `/Applications/Cursor.app`。

## 原理

- 模型列表请求经过内置扩展 `anysphere.cursor-always-local` 用 `vscode.cursor.registerConnectTransportProvider` 注册的 transport。
- `install.sh` 把这个内置扩展原样拷到 `~/.cursor/extensions/`，版本号加 1（内置 `0.0.1` 就装 `0.0.2`），入口改成 `hook.js`。用户目录里版本更高的同名扩展会替换内置版本。
- `hook.js` 先包装 `registerConnectTransportProvider`，再加载原版 `dist/main.js`。每次 `AvailableModels` 响应回来，就把服务端没返回的 Claude 模型插进列表。
- 必须沿用这个扩展 ID：Agents（glass）窗口只加载白名单里的扩展，新 ID 的扩展不会运行。
- Cursor 加载这个扩展前会校验 `dist/*.js` 的哈希，所以这些文件必须和当前 Cursor 完全一致；hook 放在 `node_modules/hook/dist/main.js`，这个目录不校验。

## 安装

```bash
./install.sh
```

然后在 Cursor 里按 `Cmd+Shift+P` 执行 `Developer: Reload Window`（或重启 Cursor）。Cursor 不在 `/Applications/Cursor.app` 时，用 `CURSOR_APP=/path/to/Cursor.app ./install.sh`。

Cursor 会记住每个模型上次用的参数（例如 Opus 5.5 的 `1M · Max · Fast`），模型回到列表后自动沿用。

## Cursor 升级后自动重装

Cursor 每次升级都会换掉内置扩展的 `dist/*.js`，例如 3.25.6 多了一个 `dist/254.js`。覆盖目录里的旧拷贝因此校验失败，而 Cursor 不会退回内置版本，`cursor-always-local` 直接不加载，模型请求就没有通道可走（远端窗口里表现为 `No Connect transport provider registered`，请求一直卡住）。

所以 `install.sh` 会顺带注册一个 LaunchAgent（`~/Library/LaunchAgents/com.yzs-lab.cursor-opus-hack.plist`），由它运行 `watch.sh`：

- **触发时机：** `/Applications` 目录一有变化就触发，另外每 5 分钟检查一次。Cursor 升级时，ShipIt 会把新的 `Cursor.app` 整个换进 `/Applications`，这一步正好会触发。
- **检查内容：** 比较内置扩展和覆盖目录的 `dist`。两边一致就直接退出，不一致就重新运行 `install.sh`，并弹一条系统通知。

ShipIt 换完应用后大约 4 秒会重新打开 Cursor，大约 10 秒后 Cursor 才会校验这个扩展，而重装只要 1 秒左右，通常赶得上。如果没赶上（比如通知弹出时 Cursor 已经打开，模型却用不了），执行一次 `Developer: Reload Window` 即可。

只有重装时才会写日志，日志在 `~/Library/Logs/cursor_opus_hack.log`。查看 LaunchAgent 的状态：

```bash
launchctl print gui/$(id -u)/com.yzs-lab.cursor-opus-hack
```

LaunchAgent 里记的是项目目录的绝对路径，移动项目目录后要重新运行一次 `./install.sh`。

## 卸载

```bash
./uninstall.sh
```

会删除 LaunchAgent 和覆盖目录。Reload Window 后恢复为内置版本。

## 日志

在 Cursor 的 Output 面板里选 `Cursor Opus Hack`，或者查看 `~/Library/Application Support/Cursor/logs/<会话>/window*/exthost/anysphere.cursor-always-local/Cursor Opus Hack.*.log`。正常情况下是：

```text
[info] Patched vscode.cursor.registerConnectTransportProvider
[info] Wrapped the connect transport provider
[info] AvailableModels: server returned 30 models; injected claude-opus-5-5, claude-sonnet-5-5, claude-opus-5, claude-opus-4-8
```

## 新版响应兼容

Cursor 3.26.13 的扩展桥接把 `method.I/O` 替换成 `RawBytesPreEncodedMessage`，响应不再直接暴露 `models`。旧 hook 因此会静默跳过注入，即使扩展校验通过、transport 正常注册，Claude 也不会显示。

hook 现在从 `service.methods` 找到真实的 protobuf 输出类型，仅解码 `aiserver.v1.AiService.AvailableModels`，注入后再封装回原始字节类型。旧版对象响应仍然支持，服务端配置与未知 protobuf 字段保留。`CppService.AvailableModels` 属于 Tab 补全，不注入 Claude。

## 测试

在安装了 Cursor 和 Node.js 的 macOS 上运行：

```bash
node --test tests/hook.test.js
```

测试直接读取当前 Cursor 的真实 protobuf 定义和自带运行时，无需安装依赖、启动 Cursor 或联网，覆盖对象/字节响应、重复刷新、未知字段保留、同名 RPC 隔离及失败透传。Cursor 不在默认位置时可设置 `CURSOR_APP`。

## 修改模型

改 `hook.js` 里的 `MODEL_SPECS`，然后重新运行 `./install.sh` 并 Reload Window。字段名必须和 Cursor 的 protobuf 定义一致，写错的字段会被静默丢弃。
