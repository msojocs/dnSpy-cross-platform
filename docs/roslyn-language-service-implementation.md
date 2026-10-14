# Roslyn 语言服务的移植说明

对应 `docs/cross-platform-port-status.md` 的 4.15（功能点与状态以那里为准）。本文记的是实现上的取舍。

## 两个宿主

WPF 的 `dnSpy.Roslyn` 有两个使用者，跨平台版照同样的划分：

| 宿主 | WPF 用到的能力 | 跨平台版 |
|---|---|---|
| C# Interactive | 只有 `RoslynClassifier`（`ScriptControlVM.OnCommandUpdatedAsync`）。REPL 缓冲区不是 Roslyn Workspace 里的文档，补全、Quick Info、签名帮助、智能缩进、结构导航都拿不到 Document，于是都不工作 | `script/classify`：输入当作会话的下一次提交编译，画成 dnSpy 主题色；回显保留颜色 |
| Edit Method / Class (C#) 编辑器（4.12 Compiler） | 全部：着色、补全、Quick Info、签名帮助、智能缩进、结构导航、编译诊断 | 后端 `languageService/*` 与前端 `attachRoslynDocument` 都已就绪；编辑器本身未移植，所以还没有界面入口 |

## 后端

- `LanguageServiceHost`：MEF 宿主只组合一次（`MefHostServices.DefaultAssemblies`，含 Features 程序集，补全与 Quick Info 的 provider 在那里）。
- `ReferenceAssemblies`：文档默认引用本机 SDK 留下的 `Microsoft.NETCore.App.Ref` 引用程序集（运行时程序集没有 XML 文档，类型又多在 System.Private.CoreLib 里，文档挂不上），找不到时退回运行时目录；每个引用配上同名 `.xml` 的 `XmlDocumentationProvider`。
- `RoslynLanguageService`：每个文档一个 `AdhocWorkspace`，与 `RoslynLanguageCompiler` 每次编辑会话一个 workspace 相同。
- 这一版 Roslyn 不公开的三样，WPF 是靠 `dnSpy.Roslyn.Internal` 的 IVT 访问的，这里改用公开 API：
  - 签名帮助：`SignatureHelpProvider` 在语义模型上实现调用、对象创建、构造函数初始化器、主构造函数基类型、索引器、特性、泛型名七类。
  - 智能缩进：用格式化器把新行的首个记号（空行时是一个占位标识符）就地格式化，取它的列。
  - 结构导航：记号到根的各层语法节点跨度，作为 Monaco 的选区扩展。

## 前端

- `roslyn-classification.ts`：分类结果画成 `tc-<color>` 内联装饰。主题色在 `styles.css`；只在代码里出现的颜色（注释、字符串、局部变量、参数、预处理、XML 文档注释、灰色说明字）限定在 `.code-colors` 下，树和搜索列表的纯文本与标点不受影响。
- `roslyn-language-service.ts`：provider 为 `csharp` 注册一次，但只回答 `attachRoslynDocument` 绑定过的模型。每个请求先经过同步：模型文本与上次送出的不同就先送 `update`，所以请求永远针对后端已有的文本（后端并发处理请求，顺序靠这条链保证）。
- `monaco.ts` 仍只导入 `monaco-editor/editor/editor.api`。之前那版把它改成整包导入，带进来的 contextmenu 等 contrib 让代码视图右键时光标落错位置（e2e「keeps the caret on what it was right-clicked on」稳定失败），已改回。绑定要用的建议框、悬停、参数提示、智能选区与按键格式化由 `roslyn-editor-contribs.ts` 引入，`roslyn-language-service.ts` 导入它；这些 contrib 要在编辑器创建前加载，所以宿主应在创建编辑器前导入绑定模块。provider 在第一次 `attachRoslynDocument` 时注册。

## 已知差异

见 4.15 表内备注：补全没有按种类过滤的按钮、图标是 Monaco 的；悬停不显示符号图标；参数提示的签名是纯文本；`GetExtentOfWord` 没有对应的扩展点；代码编辑器选项页还没有消费者。
