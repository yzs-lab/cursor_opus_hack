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

**Cursor 每次升级后都要重新运行 `./install.sh`。** 升级会换掉内置扩展的 `dist/*.js`，覆盖目录里的旧拷贝会校验失败，Cursor 就不会加载 `cursor-always-local`，它的功能（包括模型列表的请求通道）都会失效。

## 卸载

```bash
./uninstall.sh
```

Reload Window 后恢复为内置版本。

## 日志

在 Cursor 的 Output 面板里选 `Cursor Opus Hack`，或者查看 `~/Library/Application Support/Cursor/logs/<会话>/window*/exthost/anysphere.cursor-always-local/Cursor Opus Hack.*.log`。正常情况下是：

```text
[info] Patched vscode.cursor.registerConnectTransportProvider
[info] Wrapped the connect transport provider
[info] AvailableModels: server returned 30 models; injected claude-opus-5-5, claude-sonnet-5-5, claude-opus-5, claude-opus-4-8
```

## 修改模型

改 `hook.js` 里的 `MODEL_SPECS`，然后重新运行 `./install.sh` 并 Reload Window。字段名必须和 Cursor 的 protobuf 定义一致，写错的字段会被静默丢弃。
