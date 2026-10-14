# cursor_opus_hack

让 Cursor 桌面端的模型选择器重新出现 Claude Opus 5.5、Sonnet 5.5、Opus 5、Opus 4.8。

出口在香港等地区时，Cursor 后端返回的模型列表会去掉全部 Anthropic 模型：`agent` CLI 里能用 Opus 5.5，桌面端却选不到。这个项目在本地把缺失的模型补回模型列表，不改代理，也不改 `/Applications/Cursor.app`。

## 原因

- 桌面端约每 5 分钟通过 `aiserver.v1.AiService/AvailableModels`（`api2.cursor.sh`）拉一次模型列表，缓存在 `state.vscdb` 的 `availableDefaultModels2`。
- 香港出口下这个接口只返回 30 个模型，没有任何 Claude 模型。
- `agent` CLI 走的是另一个接口，不受影响；后端也照常接受 Claude 的推理请求。被过滤的只是桌面端的模型目录。

## 原理

`AvailableModels` 请求不是界面直接发的，而是经过内置扩展 `anysphere.cursor-always-local` 用 `vscode.cursor.registerConnectTransportProvider` 注册的 transport。

`install.sh` 在 `~/.cursor/extensions/` 里放一份**同名、版本号更高**的 `anysphere.cursor-always-local`（内置是 `0.0.1` 就装 `0.0.2`）。用户目录里版本更高的同名扩展会替换内置版本，并继承内置扩展的权限。

- **必须沿用这个 ID。** Cursor 3 的 Agents（glass）窗口只加载白名单里的扩展（`workbench.glass.main.js` 里的 `A1b()` 和 `VPo` 列表），换一个新 ID 的扩展在那个窗口里根本不会运行。
- 覆盖目录是内置扩展的原样拷贝，只改了 `package.json` 的 `version` 和 `main`。`main` 指向 `node_modules/hook/dist/main.js`：它先给 `vscode.cursor.registerConnectTransportProvider` 套一层，再加载原版 `dist/main.js`，所以这个扩展原有的功能都还在。
- 每次 `AvailableModels` 响应回来，用响应自带的 protobuf 类构造缺失的 Claude 模型插进列表。服务端已经返回的模型不会重复添加。
- Cursor 加载这个扩展之前，会按内置的 SHA-256 表校验 `dist/main.js`、`dist/915.js`、`dist/gitWorker.js`，`node_modules` 不在校验范围内。这三个文件是从当前安装的 Cursor 拷来的，所以能通过校验。

## 注入的模型

| 模型 ID | 可选参数 | 默认出现在选择器里 |
| --- | --- | --- |
| `claude-opus-5-5` | Context 300K / 1M，Effort Low–Max，Fast | 是 |
| `claude-sonnet-5-5` | Context 200K / 1M，Effort Low–Max | 是 |
| `claude-opus-5` | Thinking，Context 300K / 1M，Effort Low–Max，Fast | 否，需在 Settings → Models 里打开 |
| `claude-opus-4-8` | 同 `claude-opus-5` | 否，需在 Settings → Models 里打开 |

Cursor 把每个模型最后一次用的参数存在 `state.vscdb` 的 `aiSettings.modelParameterPreferences` 里，这个项目不读写它。模型回到列表后，选择器会自动用回之前的组合，例如 `claude-opus-5-5` 的 `1M · Max · Fast`。

## 安装

要求 macOS，Cursor 装在 `/Applications/Cursor.app`（其他位置用 `CURSOR_APP=/path/to/Cursor.app ./install.sh`）。脚本用 Cursor 自带的 Node 运行，不需要另装 Node。

```bash
cd ~/Projects/cursor_opus_hack
./install.sh
```

然后在 Cursor 里按 `Cmd+Shift+P` 执行 `Developer: Reload Window`（或重启 Cursor），再运行 `./doctor.sh` 确认生效。

`install.sh` 会：

1. 读取内置 `cursor-always-local` 的版本号，算出更高的版本（`0.0.1` → `0.0.2`）。
2. 把内置扩展整个拷到 `~/.cursor/extensions/anysphere.cursor-always-local-<版本>`，改写 `package.json`，放入 `override/` 里的 hook。
3. 删除旧的覆盖目录，更新 `~/.cursor/extensions/extensions.json`（原文件备份在 `backups/extensions.json.bak`），并删除扩展缓存 `extensions.user.cache`，让 Cursor 重新扫描。

重复运行没有副作用。

## Cursor 升级后要重新运行 install.sh

Cursor 每次升级都会换掉内置扩展的 `dist/*.js` 和对应的哈希表。覆盖目录里还是旧文件的话，Cursor 会拒绝加载 `cursor-always-local`。这时不只是 Claude 模型消失，这个扩展负责的功能（包括模型列表请求所走的那条通道）都会失效。

所以 Cursor 升级之后，先运行：

```bash
./install.sh
```

再 Reload Window。脚本会重新拷贝当前版本的文件；如果内置版本号也变了，会自动换成更高的版本号。不确定要不要重装时，运行 `./doctor.sh`，它会检查覆盖目录里的文件和当前 Cursor 是否一致。

如果升级把内置版本号提高到不低于覆盖版本，Cursor 会直接用内置版本：功能都正常，只是 Claude 模型不见了，重新运行 `./install.sh` 即可。

## 检查是否生效

```bash
./doctor.sh
```

下面是重载窗口之前的输出示例：

```text
✓ Cursor 3.24.18，内置 anysphere.cursor-always-local 0.0.1
✓ 覆盖 0.0.2 已安装（/Users/yezhisheng/.cursor/extensions/anysphere.cursor-always-local-0.0.2）
✓ 覆盖里的 dist 文件与当前 Cursor 一致，能通过文件校验
✓ 注入的 4 个模型在当前 Cursor 的 AvailableModelsResponse 里字段完整
! 当前 Cursor 会话里还没有 hook 日志：在 Cursor 里按 Cmd+Shift+P，执行 Developer: Reload Window（或重启 Cursor）
✓ 模型列表缓存（共 34 个）包含 claude-opus-5-5（20 个变体）、claude-sonnet-5-5（10 个变体）、claude-opus-5（40 个变体）、claude-opus-4-8（40 个变体）
    claude-opus-5-5 上次使用的参数：context=1m, effort=max, fast=true
```

重载之后，带 `!` 的那一行会变成 hook 日志里最近一次注入的结果。在 Cursor 的 Output 面板里选择 `Cursor Opus Hack`，也能看到同样的日志：

```text
[info] Patched vscode.cursor.registerConnectTransportProvider
[info] Wrapped the connect transport provider
[info] AvailableModels: server returned 30 models; injected claude-opus-5-5, claude-sonnet-5-5, claude-opus-5, claude-opus-4-8
```

## 卸载

```bash
./uninstall.sh
```

删除覆盖目录和 `extensions.json` 里的记录，Reload Window 后恢复为 Cursor 内置的 `cursor-always-local`。Claude 模型会随下一次模型列表刷新（最多约 5 分钟）从选择器里消失。

## 修改模型

模型定义在 `override/models.js` 的 `MODEL_SPECS` 里。改完先运行 `./scripts/test.sh`，再运行 `./install.sh`，然后 Reload Window。

protobuf 类遇到不认识的字段会直接丢掉，不会报错。所以测试会从已安装的 Cursor 里取出真实的 `AvailableModelsResponse` 类，把这些定义编解码一遍，确认没有字段丢失。`install.sh` 和 `doctor.sh` 也会做同样的检查。

## 目录结构

```text
install.sh / uninstall.sh / doctor.sh   入口脚本
override/
  hook.js      覆盖扩展的入口（安装为 node_modules/hook/dist/main.js）
  inject.js    包装 transport、往 AvailableModels 响应里注入模型
  models.js    注入的模型定义
scripts/
  manage.js        install / uninstall / doctor 的实现
  cursor-proto.js  从 Cursor 自带的扩展里取出真实的 protobuf 类，用于测试和检查
  run-node.sh      用 Cursor 自带的 Node 运行脚本
  test.sh          运行测试
test/              node:test 测试
```

## 局限

- 依赖 Cursor 的内部实现：glass 窗口的扩展白名单、用户目录覆盖内置扩展的规则、`vscode.cursor.registerConnectTransportProvider` 和 `AvailableModels` 方法名。Cursor 改动其中任何一项，这个办法都可能失效，`./doctor.sh` 能帮助定位。
- 只补客户端的模型目录，不绕过鉴权或计费。如果后端开始按地区拒绝 Claude 的推理请求，这个办法帮不上忙。
- 只支持 macOS 桌面端。
