<img src="public/favicon.png" alt="ExPDF icon" width="80" height="80" />

# ExPDF

A lightweight PDF reader that connects to your local Codex CLI and existing subscription for AI-powered reading.

Reuse your existing ChatGPT sign-in and eligible subscription access without configuring a separate API key in ExPDF. [About Codex authentication](https://learn.chatgpt.com/docs/auth).

PDF reading and annotation run locally. AI requests connect to the model service configured in Codex; ExPDF is not an offline model runtime.

**让你的 Codex 订阅，直接参与阅读。**

ExPDF 将多标签 PDF 阅读、批注和 Codex 助手放在同一个界面中。选中段落即可解释、翻译、概括，也可直接提问、继续追问，让助手按需检索当前 PDF、计算或处理文件。

[下载 macOS Apple silicon 版](https://github.com/2020-qqtcg/ExPDF/releases/download/v1.0.0/ExPDF-1.0.0-arm64.dmg) · [v1.0.0 Release](https://github.com/2020-qqtcg/ExPDF/releases/tag/v1.0.0) · [SHA-256 校验值](https://github.com/2020-qqtcg/ExPDF/releases/download/v1.0.0/SHA256SUMS.txt) · [更新记录](CHANGELOG.md)

## 安装

当前提供 **macOS 13 或更新版本的 Apple silicon（arm64）** 应用。

1. 下载 `ExPDF-1.0.0-arm64.dmg`，双击打开。
2. 将 `ExPDF.app` 拖入“应用程序”。
3. 启动 ExPDF，打开或拖入 PDF。

安装后无需手动启动终端、Vite 或额外服务。PDF.js、中文字体和本地接口随应用运行。当前构建未使用 Apple Developer ID 签名，也未公证。

阅读与批注不要求安装 Codex；AI 功能需要另外安装并登录本机 Codex CLI。

## 连接 Codex

按 [OpenAI 官方 CLI 安装说明](https://learn.chatgpt.com/docs/codex/cli)安装 Codex，然后在终端完成登录：

```bash
codex login
codex login status
```

使用 ChatGPT 账户登录后，ExPDF 复用本机 Codex 的登录及订阅内可用额度，无需在应用中另填 API Key。模型、工具和额度以当前账户及 Codex 实际状态为准；API Key 登录使用相应的 API 计费方式。[OpenAI 官方登录说明](https://learn.chatgpt.com/docs/auth)。

在阅读工具栏点击 AI 图标，直接输入问题，或选中文字后点击“问 Codex”。输入框底部可选择当前账户可用的模型与思考深度。回答支持 Markdown、表格、LaTeX 公式和带复制按钮的代码块。

每个 PDF 可创建多个独立会话，并切换回历史聊天。会话、草稿和执行记录保存在本机；切换文档、切换聊天或停止生成会中断当前任务。侧栏左侧边缘可拖动调宽。

助手通过 [Codex App Server](https://learn.chatgpt.com/docs/app-server)接入本机能力：

- 按需读取、搜索当前 PDF，查看标注、跳转页面、准确高亮原文或添加便签。
- 执行终端计算、代码与文件处理、联网检索，以及当前 CLI 可提供的技能、MCP、插件、连接应用和其他工具。
- 显示流式回答与执行记录，将命令、文件变更、额外权限及补充问题呈现为可交互请求。需要批准的操作由用户确认；普通沙箱内操作遵循 Codex 的审批规则。

实际能力取决于本机 CLI、账户、已安装工具及连接状态，可在“工具与连接”中查看。桌面控制关闭，不提供屏幕、键鼠或其他原生应用自动化，也不继承 Codex 桌面应用专属的宿主能力。任务使用各聊天独立的工作目录；桌面版可打开该目录及助手生成的受支持文档。

## 阅读与批注

- **多 PDF 标签页**：支持多选打开、批量拖入和最近阅读。切换时保留文档位置、缩放、旋转、搜索、标注、撤销记录和聊天草稿；重启恢复打开的标签、页码、标注与聊天。
- **阅读导航**：连续滚动、缩略图、原生目录、页码跳转、全文搜索、页面书签、适合宽度、旋转与拖动阅读。
- **常用标注**：高亮、下划线、删除线、波浪线、便签与自由绘制，支持编辑、移动、删除及撤销、重做。
- **文字标注**：在页面输入多行文字，调整字体、字号、颜色、粗体、斜体、下划线、对齐和行距；支持本机字体与导入字体，导出时嵌入所用字体。
- **原生 PDF 导出**：保存原生 PDF 标注及外观流，支持中文便签，保留原文档内容与已有标注。桌面版可保存到当前文件或另存为，网页版导出新文件。

顶部“+”打开 PDF，标签上的“×”关闭对应文档；最近阅读可以重新打开。选择工具（V）拖选文字后，在浮动工具条中添加高亮、划线、便签或复制。文字工具（T）点击页面后输入；便签和页面文字可用 ⌘/Ctrl + Enter 完成、Escape 取消。

默认按纸张宽度适配。开关侧栏、调整窗口或旋转页面时自动适配；手动缩放后保持固定比例。阅读区支持触控板捏合和 Ctrl + 鼠标滚轮围绕光标缩放，普通双指滑动用于滚动。

**自动保存的是本机阅读记录。** 将标注写入磁盘 PDF 仍需使用“保存”或“另存为”。无原文件关联的文档首次保存时会选择目标位置。

## 数据与限制

PDF 阅读、批注、字体读取与缓存在本机处理。AI 提问会将当前页文字、可选摘录和会话上下文经 Codex 发送给所配置的模型服务；助手还可按需读取或搜索更多页面，使用的联网工具也会连接相应服务。

桌面版数据保存在当前用户的应用数据目录。由 Folio 升级为 ExPDF 时沿用原有数据，保留阅读历史、标注、字体缓存和聊天。网页版数据属于当前浏览器与地址，与桌面版相互独立；清理网站数据会清除对应本机记录。重要标注请及时保存或导出。

- 扫描 PDF 可阅读、绘制、添加便签和文字；搜索、原文划线及助手全文读取需要 PDF 具有可选择的文字层，当前不提供 OCR。
- 支持添加文字，不提供修改 PDF 原有文字、PDF 转 Word、数字签名或云端同步。
- 形状、测量、附件、贴纸、图章、签名，以及选区工具条中的编辑、书签和朗读图标为禁用展示，尚无对应功能。
- 保留外部 PDF 已有标注，但本应用的标注面板只管理在本机添加的标注，暂不支持导入编辑外部标注。
- 加密 PDF 可输入密码阅读，导出可能受到加密或编辑权限限制。
- 部分系统字体无法由浏览器或 PDF 引擎解析。中文 CID CFF 字体为保证显示完整嵌入，可能增大导出文件。

## 从源码运行

需要 **Node.js 22.13+**，推荐 Node.js 24 LTS。桌面运行与当前打包脚本面向 macOS，DMG 目标为 arm64。

```bash
git clone https://github.com/2020-qqtcg/ExPDF.git
cd ExPDF
npm ci
npm run desktop
```

`npm run desktop` 会构建并启动 Electron 应用。仅使用阅读与批注时无需 Codex；AI 功能仍需本机已登录的 Codex CLI。

打包：

```bash
npm run package:mac      # 构建 arm64 DMG
npm run package:mac:dir  # 仅构建应用目录
```

1.0.0 产物位于：

```text
release/1.0.0/ExPDF-1.0.0-arm64.dmg
release/1.0.0/mac-arm64/ExPDF.app
```

网页版开发与预览：

```bash
npm run dev
# 或生产构建后预览
npm run build
npm run preview
```

打开终端显示的本地地址。PDF.js 的字库、CMap、WASM 和 Worker 随构建部署，网页版需通过 HTTP 服务运行。AI 与本机字体接口由本地开发/预览服务提供，单独部署静态文件时不包含这些本机接口。

验证命令：

```bash
npm test
npx playwright install chromium  # 首次运行浏览器测试
npm run test:e2e
npm run test:desktop
npm run build
```

## 快捷键

| 操作 | 快捷键 |
| --- | --- |
| 打开 / 搜索 / 保存或导出 | ⌘/Ctrl + O / F / S |
| 另存为 PDF（桌面版） | ⌘/Ctrl + Shift + S |
| 关闭当前标签 / 关闭桌面窗口 | ⌘/Ctrl + W / Shift + W |
| 下一个 / 上一个 PDF 标签 | Ctrl + Tab / Ctrl + Shift + Tab |
| 撤销 / 重做 | ⌘/Ctrl + Z / Shift + Z |
| 选择 / 拖动 | V / H |
| 高亮 / 下划线 / 删除线 | A / U / S |
| 文字 / 便签 / 画笔 | T / N / D |
| 上一页 / 下一页 | ← / → 或 PageUp / PageDown |
| 删除选中标注 | Delete / Backspace |
| 完成便签或页面文字 | ⌘/Ctrl + Enter |
| 发送助手问题 / 换行 | Enter 或 ⌘/Ctrl + Enter / Shift + Enter |
| 取消当前编辑或回到选择工具 | Escape |

## 技术与资源

React、TypeScript、Vite、PDF.js、pdf-lib；桌面应用采用 Electron 44 与 electron-builder 26。

内置 Noto Sans CJK SC 使用 SIL Open Font License，见 [字体许可](public/fonts/OFL.txt)。PDF.js 随附资源的许可保留在各资源目录中。
