<img src="public/favicon.png" alt="ExPDF 图标" width="80" height="80" />

# ExPDF

[English](README.md) | **简体中文**

一款接入现有 Codex 订阅的轻量 PDF 阅读器。

ExPDF 将 PDF 阅读、批注和 Codex 问答放在同一个窗口。沿用本机 Codex 的登录和订阅，选中段落就能解释、翻译、概括，也可以直接提问、查找文中的相关内容。

[下载 macOS 版](https://github.com/2020-qqtcg/ExPDF/releases/download/v1.0.0/ExPDF-1.0.0-arm64.dmg) · [v1.0.0 发布说明](https://github.com/2020-qqtcg/ExPDF/releases/tag/v1.0.0) · [更新记录](CHANGELOG.md)

![ExPDF 界面：左侧页面缩略图、中间 PDF 阅读与高亮、右侧 Codex 问答](assets/screenshots/reader.jpg)

图中的 PDF 与问答均为演示内容。

## 用 Codex 读 PDF

点击阅读工具栏中的 AI 图标即可提问。选中文字后，也可以在浮动工具条中点击“问 Codex”，带着引用继续聊。

- 解释段落、翻译、概括要点，结合当前页内容继续追问。
- 搜索文档、读取相关页面、跳转到原文，还可以让助手添加高亮和便签。
- 为同一份 PDF 新建多场聊天，随时切回历史会话。
- 在输入框底部选择模型和思考深度，拖动侧栏边缘调整阅读宽度。
- 回答中直接阅读表格、公式和代码，复制代码或打开生成的文档。

助手还可调用本机 Codex 已配置的工具进行联网检索、终端计算和文件处理。执行记录、需要确认的操作和补充问题会显示在侧栏中。

## 阅读与批注

- **多文档阅读**：一次打开或拖入多份 PDF，通过标签切换。切换时，各文档保留自己的阅读位置、缩放、搜索和聊天草稿；重启后可继续阅读。
- **快速定位**：通过缩略图、目录、页码、全文搜索和书签找到内容，支持连续滚动、适合宽度、旋转和拖动阅读。
- **常用批注**：选中文字后直接高亮、添加下划线、删除线或波浪线，也可添加便签和自由绘制。标注可以编辑、移动、删除、撤销和重做。
- **添加文字**：点击页面输入文字，调整字体、字号、颜色、粗体、斜体、对齐和行距，支持本机字体及导入字体。

阅读记录与批注会自动保存在本机。“保存”将标注写入当前 PDF，“另存为”可保存一份新文件。最近阅读中可以重新打开之前的文档。

页面默认适合宽度，调整窗口或展开侧栏时会跟随适配。也可以用触控板捏合或 Ctrl + 鼠标滚轮缩放。

## 安装

适用于 **macOS 13 或更新版本，Apple silicon（arm64）**。

1. 下载并打开 `ExPDF-1.0.0-arm64.dmg`。
2. 将 `ExPDF.app` 拖入“应用程序”。
3. 启动 ExPDF，打开或拖入 PDF。

使用 AI 助手前，按 [Codex CLI 安装说明](https://learn.chatgpt.com/docs/codex/cli)安装 Codex，并用 ChatGPT 账户登录：

```bash
codex login
```

ExPDF 会使用本机 Codex 已有的登录和订阅，无需在应用中另行配置 API Key。已经登录 Codex 的用户可以直接开始提问。

## 从源码运行

需要 **Node.js 22.13+**，推荐 Node.js 24 LTS。

```bash
git clone https://github.com/2020-qqtcg/ExPDF.git
cd ExPDF
npm ci
npm run desktop
```

构建 macOS Apple silicon 安装包：

```bash
npm run package:mac
```

产物为 `release/1.0.0/ExPDF-1.0.0-arm64.dmg`，应用目录为 `release/1.0.0/mac-arm64/ExPDF.app`。

在浏览器中开发或预览：

```bash
npm run dev
# 生产构建与预览
npm run build
npm run preview
```

打开终端显示的本地地址。

## 常用快捷键

| 操作 | 快捷键 |
| --- | --- |
| 打开 PDF | ⌘/Ctrl + O |
| 搜索文档 | ⌘/Ctrl + F |
| 保存 / 另存为 | ⌘/Ctrl + S / ⌘/Ctrl + Shift + S |
| 关闭当前标签 | ⌘/Ctrl + W |
| 下一个 / 上一个标签 | Ctrl + Tab / Ctrl + Shift + Tab |
| 撤销 / 重做 | ⌘/Ctrl + Z / ⌘/Ctrl + Shift + Z |
| 选择文字 / 拖动阅读 | V / H |
| 完成便签或页面文字 | ⌘/Ctrl + Enter |
| 发送问题 / 换行 | Enter / Shift + Enter |
| 取消当前编辑 | Escape |
