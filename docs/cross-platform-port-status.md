# dnSpy 跨平台移植进度（对照 WPF 版）

> 审计日期：2026-10-12；程序集树（4.3）于 2026-10-13 按实现与测试复核，2026-10-14 补齐剩余差距后再次复核；应用壳与通用 UI（4.1）于 2026-10-14 按实现与测试复核；字符串引用窗口（4.11）与 Roslyn 语言服务（4.15）于 2026-10-16 按实现与测试复核；分析器（4.10）于 2026-10-16 补齐剩余差距后按实现与测试复核；搜索窗口（4.9）于 2026-10-16 补齐剩余差距后按实现与测试复核；应用壳与通用 UI（4.1）于 2026-10-17 补齐剩余差距后按实现与测试复核；调试器（4.13）于 2026-10-17 补齐后按实现与测试复核；Hex 编辑器浏览（4.7）于 2026-10-18 按实现与测试复核；程序集编辑（4.12）于 2026-10-18 补齐后按实现与测试复核；命令行版 dnSpy.Console（4.17）于 2026-10-18 补齐后按实现与测试复核
>
> 代码基线：`linux` 分支，提交 `adeb8c1a9`
>
> 对照对象：WPF 版 `dnSpy/dnSpy/`、`Extensions/*`、`dnSpy/Roslyn/`、`dnSpy/dnSpy.Console/`；跨平台版 `CrossPlatform/`

本文按模块逐项对照 WPF 版用户可见功能，记录跨平台版（Electron/React 前端 + .NET 10 后端）的移植状态。结论来自只读代码审计，没有运行构建或测试；标「代码推断」的条目没有实测。4.1（应用壳）、4.3（程序集树）、4.9（搜索窗口）、4.10（分析器）、4.11（字符串引用窗口）、4.7（Hex 编辑器浏览）、4.12（程序集编辑）、4.13（调试器）、4.15（Roslyn 语言服务）与 4.17（命令行版 dnSpy.Console）另有按实现与测试复核的一轮，这几节的结论以本机跑过的单测与 e2e 为准，见表内备注。

## 0. 约定

**状态标记**

| 标记 | 含义 |
|---|---|
| ✅ | 已完成，行为基本对齐 WPF |
| 🟡 | 部分完成：有实现，但缺子功能、做了简化或行为有差异 |
| ❌ | 未实现（包括只有灰显菜单或占位面板的情况） |
| ⛔ | 不适用：Linux 上不存在该能力，或文档、代码中明确决定不做 |

**完成度算法**：✅ 记 1 分，🟡 记 0.5 分，❌ 记 0 分，⛔ 不计入分母。各模块功能点的粒度不完全一致，少数功能点在两个模块里各算了一次，所以百分比只用于比较量级，不是精确指标。

**路径缩写**

| 缩写 | 实际路径 |
|---|---|
| `WPF/` | `dnSpy/dnSpy/` |
| `AE/` | `Extensions/dnSpy.AsmEditor/` |
| `DBG/` | `Extensions/dnSpy.Debugger/` |
| `FE/` | `CrossPlatform/frontend/src/renderer/src/` |
| `MAIN/` | `CrossPlatform/frontend/src/main/` |
| `BE/` | `CrossPlatform/backend/dnSpy.Backend.Core/` |
| `CDS/` | `CrossPlatform/backend/dnSpy.Backend.Debugging.CorDebug/` |

## 1. 总览

### 1.1 各模块完成度

| 模块 | 完成度 | ✅ | 🟡 | ❌ | ⛔ | 一句话现状 |
|---|---|---|---|---|---|---|
| 书签 | 100% | 18 | 0 | 0 | 0 | 完整实现；支持列排序、WPF XML 导入导出、Location 列格式化；功能完全对齐 WPF |
| 分析器 | 100% | 29 | 0 | 0 | 1 | 全部功能点对齐 WPF：行文本随工具栏语言（C#/VB/IL）重写、结果不设上限、IL 视图定位到指令的操作数、程序集树多选与基类型行可分析 |
| 搜索窗口 | 100% | 29 | 0 | 0 | 0 | 全部功能点对齐 WPF：结果文本与提示随工具栏语言（C#/VB/IL）重写而不重搜、提示为各语言的成员签名、「Search For」下拉项带图标、位置作用于整个选区、IL 视图跟随到指令、命令行 `--search*` |
| 应用壳与通用 UI | 100% | 37 | 0 | 0 | 3 | 全部功能点对齐 WPF：读 `.dntheme` 的主题服务（界面与代码视图都按主题资源着色，支持用户主题）、15 种界面语言、按类别与主题的字体页、带 Debug 窗格的 Output 窗口、dnSpy 图标集覆盖菜单与工具窗口、`--settings-file` 与便携模式、`-p`/`-pn` 附加 |
| 程序集树 | 100% | 30 | 0 | 0 | 1 | 全部功能点对齐 WPF：dnSpy 自己的图标集、完整键盘导航与输入查找、单文件最近列表、命令行打开与 `--select`、Reload All 恢复标签、移除程序集进撤销栈、GAC 解析 |
| 调试器 | ~83% | 63 | 16 | 7 | 4 | Roslyn 表达式求值与 func-eval，Locals/Autos/Watch 1–4 可展开、改值、DebuggerDisplay；Set Next Statement、Run to Cursor、模块断点、返回值；Threads/Modules/Processes/Memory/Disassembly 窗口；缺 Mono/Unity 与多进程 |
| 程序集编辑（AsmEditor） | ~82% | 52 | 11 | 7 | 2 | C# 源码编辑（方法、类、类成员、程序集特性、合并）与方法体三页编辑器齐备；资源可新建与编辑；保存有写出选项（含保留 RID、混合模式、PDB）；缺 NetModule 管理、镜像/ImageListStreamer 资源与指令列表剪贴板 |
| C# 交互窗口 | ~98% | 24 | 1 | 0 | 2 | 除 UI 线程与 VB 外完整对齐 WPF：完整性提交、两段 Ctrl+A、前缀历史、实时输出、彩色输出 API、PrintOptions、Resolve、消息框/输入框、保存与右键菜单、REPL 选项页 |
| 元数据/PE 视图与本机反汇编 | ~38% | 7 | 2 | 12 | 0 | PE 头只读文本可看；元数据表子树完全缺失，反汇编未实现 |
| 反编译与语言 | ~44% | 6 | 11 | 9 | 1 | C# 完整；工具栏语言为全局并持久化；IL 格式简化但有定义/引用 span 与逐指令语句表，VB 无 span；GUI 无导出项目（命令行版已支持，见 4.17） |
| 代码编辑器与文档标签 | ~35% | 4 | 13 | 13 | 0 | F12、标签组可用；Monaco contrib 未打包，查找/悬停/折叠都不可用 |
| Hex 编辑器（浏览） | ~84% | 24 | 4 | 3 | 0 | 整文件滚动转储、光标与选区、键入改写、右键菜单、四个对话框与查找；缺结构信息与 F12 |
| Roslyn 语言服务 | ~69% | 3 | 5 | 0 | 0 | C# Interactive 有 WPF 同款语义着色；补全、Quick Info、签名帮助、诊断、智能缩进、选区已做成后端服务与可复用绑定，宿主 Edit Method (C#) 已在 4.12 移植 |
| 字符串引用窗口 | ~95% | 20 | 2 | 0 | 0 | 三类来源、过滤与选项、WPF 的排序语义、列重排与列宽、右键菜单、自动刷新齐备；来源列只按 C# 书写，IL/VB 视图跟随不定位语句 |
| dnSpy.Console 命令行 | ~92% | 11 | 2 | 0 | 0 | 跨平台 CLI 已就位：项目导出（SDK/传统工程、.sln/.slnx、GAC 与程序集解析、资源与 BAML 开关）、单个类型/成员输出（C#/VB/IL/IL with C#）、彩色与 `--spaces` 都对齐 WPF；语言选项是子集，VB 工程由 C# 转换而来 |
| 扩展系统 | 不计 | 1 | 0 | 1 | 9 | 按计划首版不支持第三方扩展；内置功能直接编进程序 |
| 其他杂项 | 不计 | 5 | 1 | 1 | 7 | 多为 WPF/Windows 基础设施；15 种语言与图标库已齐；更新检查缺失 |
| 工程基础设施（新增） | ~83% | 8 | 4 | 0 | 0 | 协议、安全、三平台打包、CI 发布已就绪；CI 不跑前端单测 |

**整体**：除「工程基础设施」外，把上表各模块（含「不计」的两行）逐行相加，合计 ✅ 363 / 🟡 68 / ❌ 53 / ⛔ 30，完成度约 **82%**（2026-10-18 命令行版补齐前按同一张表为 ✅ 352 / 🟡 66 / ❌ 53 / ⛔ 30；更早的审计记录曾写作 ✅ 334 / 🟡 75 / ❌ 74 / ⛔ 30，与当时的表不一致，本次按表重算）。这一行由上表直接求和，不再逐次增减维护。

### 1.2 按工作流看

| 工作流 | 可用程度 | 说明 |
|---|---|---|
| 打开程序集、浏览树、看 C# 代码、F12 跳转 | 日常可用 | 交互模型与 WPF 不同：双击才打开，每个节点一个标签 |
| 看 IL / VB | 能看，不好用 | IL 是简化格式，指令的操作数可以跳转，但不能下断点；VB 不能跳转 |
| 搜索、分析引用 | 日常可用 | 两块是移植最完整的部分 |
| 改名、改元数据、增删成员 | 日常可用 | 五类成员的选项对话框与 WPF 逐页对齐 |
| 改方法体 | 日常可用 | C# 源码编辑（方法、类、类成员、程序集特性、合并）与方法体三页编辑器都在；IL 编辑器可增删局部变量与异常处理器，撤销覆盖导入 |
| 保存 | 日常可用 | 保存选中行所属的模块；写出选项含保留 RID/堆偏移、校验和、MVID 节、PDB、混合模式；Save All 仍无进度与取消 |
| 调试 .NET (CoreCLR) 程序 | 日常可用 | 断点（含完整条件）、单步、Set Next Statement、调用栈；Locals/Autos/Watch 可求值、展开、改值；内存与反汇编窗口；只能调一个 CoreCLR 进程 |
| 元数据表、Hex 修改 | 浏览可用，改写局部可用 | Hex 可滚动浏览、查找、复制、直接改字节并撤销；PE 头仍是只读文本，元数据表视图未实现 |
| 脚本、批处理导出 | 部分可用 | 独立的 `dnSpy.Console` 可以批量导出项目、把单个类型/成员写到 stdout（见 4.17）；REPL 仍不能操作已打开的程序集，GUI 的 Export to Project 菜单仍未接线 |

## 2. 跨模块问题

这些问题不属于某一个模块，但拉低了多个模块的完成度，修一处能同时改善好几块。

1. ~~**仍有一组选项页只保存、不生效。**~~ **已修复（2026-10-14）**：`DecompileRequest` 现在包含 `DecompilerSettingsDto` 字段，前端在调用反编译时会传递用户的 C#、IL 和 BAML 设置，后端通过 `DecompilerSettingsMapper` 应用这些设置。`DecompileFullType` 和 `UseMemoryMappedIO` 现在会被传递给后端。注意：由于使用的是 NuGet 版 `ICSharpCode.Decompiler 11.1`，某些 WPF dnSpy 特有的选项（如 `ShowTokenAndRvaComments`、`SortMembers` 等）在基础 ILSpy 中不存在，暂时被忽略。仍改了没效果的是：
   - 文本编辑器、Hex 编辑器的部分选项（Hex 视图已应用当前行高亮、列分隔线、值/偏移大小写、分组、偏移格式、ASCII 编码与默认每行字节数；高亮当前值、结构高亮与滚动条页仍不生效，Memory 窗口仍只读其中的大小写与分组，见 4.7）、书签语法高亮、REPL；
   - General 的版本号与 PublicKeyToken 等程序集树页选项。

   Output 页的自动换行、行号、时间戳与时间格式（2026-10-17 起）、Environment › Font 页，以及调试器页与 Disassembler / Code Style 页（2026-10-17 起，经 `debug/setOptions` 交给引擎）已生效。

   此外 General 页的 `CheckForUpdatesOnStartup` 没有对应功能（⛔）。

2. **Monaco 的 contrib 没有打包。** `FE/monaco.ts` 只导入 `monaco-editor/editor/editor.api`，构建产物里也找不到 find、hover、folding、wordHighlighter、gotoLine、bracketMatching 等模块。因此所有 Monaco 实例（代码视图、C# Interactive）都没有查找替换、悬停、折叠、括号匹配、转到行、缩放。Edit→Find 已经接线，但 `getAction('actions.find')` 返回 undefined，什么也不做。修法是改为导入 `editor.main`，或按需导入 `contrib/*`。

3. **VB 文档没有 span 与语句表，IL 的只有一部分。** C# 反编译生成引用 span 和语句到 IL 的映射（`BE/StatementIlRanges.cs`）。IL 视图（含 IL with C#）有逐指令的语句表、成员声明处的定义 span，以及（2026-10-16 起）每条指令操作数所指成员的引用 span，所以 IL 里可以跳转、书签可以挂到指令上、分析器的「显示方法内的引用」会落到操作数上；但断点仍只按 C# 的语句表下。VB 是 C# 文本的转换，没有任何 span 与语句表（方法文档还会变成空壳类），因此 VB 视图里不能跳转、不能下断点，搜索和分析器结果只打开方法。IL 输出由自写的简化 `ILFormatter` 生成（没有 `.try`、`.custom` 等），改用 ICSharpCode 的 `ReflectionDisassembler` 可以解决格式。

4. ~~**菜单上标了快捷键却没有绑定。**~~ 2026-10-14 已修：菜单上标出的快捷键都接上了——Ctrl+Alt+L、Alt+2、Ctrl+D（转到元数据标记，dnSpy 在树上和文档视图里都用这个键）、Ctrl+E Ctrl+W、Alt+Numpad*、Ctrl+Alt+P、Ctrl+Alt+Break、Ctrl+Alt+B/E/C/H/U/Z、Alt+4、Alt+8，Shift+Alt+Enter 不再被 Alt+Enter 的分支截住（原先还有个 WPF 没有的 F11 全屏，一并去掉），Ctrl+Tab 与 Ctrl+Shift+Tab 也补上了。十六进制视图后来补了自己的快捷键（Ctrl+G/M/L/F、F5、Ctrl+D/Ctrl+Shift+D、Ctrl+Alt+S 等，见 4.7）。主菜单现在可以用键盘操作。

5. **程序集树的多选只有部分命令用上。** 树已支持 Ctrl/Shift 多选和键盘扩选，Remove Assembly、保存资源、Search MSDN、分析（2026-10-16 起）、位置为「选中文件 / 同一文件夹 / 选中类型」的搜索作用于整个选区；但删除类型与成员、多节点合并反编译仍只看一个节点。

6. ~~**未保存修改的保护不完整。**~~ 2026-10-14 已修：有未保存修改时关闭窗口，主进程会拦下这次关闭并反问「是否要在继续之前保存？」（是 / 否 / 取消），取消则留在原地。Reload All 与移除程序集仍按 WPF 各自询问，措辞与本移植版的其它对话框一致。

7. ~~**图标与本地化。**~~ 2026-10-17 已补齐：主菜单、各右键菜单与工具窗口命令栏也换成 dnSpy 图标集（`dnSpy/dnSpy.Images` 的 XAML 矢量图转成 SVG，按 dnSpy 的 ThemedImageCreator 算法随主题背景换色），只剩 WPF 没有的加载动画仍是 lucide-react；界面语言与 WPF 一样 15 种，译文由各语言的 resx 生成（`scripts/generate-locales.mjs`），resx 里没有的移植版自有字符串回落英文。

## 3. 审计中发现的疑似缺陷

下表是审计过程中顺带发现的行为问题，不是缺失功能。「已核实」表示读代码确认了因果链，「代码推断」表示没有完整核实或依赖运行时行为。

| # | 问题 | 位置 | 依据 |
|---|---|---|---|
| 1 | ~~打开多个程序集时，File→Save / Save Module… 总是保存第一个模块~~ 已修复（2026-10-18）：`currentModule` 沿选中行的父链走到根行，并用模块行的路径匹配 `OpenedModule`；单测覆盖了「选中 B 程序集里的方法时保存 B」 | `FE/app-store.ts` 的 `currentModule` | 已核实 |
| 2 | ~~停止调试会杀掉附加的进程~~ 已修复（2026-10-17）：`stopDebug` 对附加的进程分离、对启动的进程终止，Debug 菜单另有 Detach All / Terminate All | `FE/app-store.ts` 的 `stopDebug` | 已核实 |
| 3 | 保存单个模块会清掉全局 `dirty`，即使其他模块仍有修改 | `FE/app-store.ts` 保存逻辑 | 代码推断 |
| 4 | ~~IL 编辑器从不重算 MaxStack~~ 已修复（2026-10-18）：方法体编辑器把 `KeepOldMaxStack` 原样传给 dnlib，不勾选时由 writer 重算栈深 | `BE/WorkspaceManager.MethodBody.cs` | 已核实 |
| 5 | ~~Raw Save Resource 与 Save Resource 写出相同的字节：主进程丢掉了 `raw` 参数~~ 已修复（2026-10-13）：改走 `resource/getItems`，`raw` 一路传到后端 | `MAIN/index.ts` 的 `edit:saveResource` | 已核实 |
| 6 | ~~PE-only、ELF、未知文件的 Open Hex Editor 读不出数据~~ 已修复（2026-10-18）：`GetHexLength` / `ReadHexAsync` 改走 `GetHexEntry`，按模块、树节点、PE-only、ELF、未知文件依次解析；只有托管模块会叠加 hex 补丁 | `BE/WorkspaceManager.cs` | 已核实 |
| 7 | 不属于任何成员的 Raw hex 补丁，保存时仍用原文件偏移；dnlib 重写文件后可能写错位置 | `BE/WorkspaceManager.cs` 保存时的补丁重定位 | 代码推断 |
| 8 | ~~C# Interactive 的 Reset 不能恢复不响应取消的脚本：`ResetAsync` 不释放执行信号量，后续提交排队到 600 秒 IPC 超时；被重置会话的旧输出仍会追加到日志~~ 已修复（2026-10-18）：会话各自持有执行锁、取消源与 generation；Reset 取消旧令牌并触发 `ScriptResetting` 后立即建立新会话，排队中的提交随旧令牌取消，旧会话的输出按 generation 丢弃。另：输出帧改为同步写入管道，避免单核机器上同步等待异步写造成的死锁 | `BE/Scripting/CSharpScriptService.cs`、`BE/JsonRpcServer.cs` | 已核实 |
| 9 | ~~基类型行不能分析：前端 `isAnalyzableNode` 不含 `basetype`，而后端已支持~~ 已修复（2026-10-16）：基类型行可分析，菜单打开前向后端确认引用能解析（WPF 的 CanAnalyze），解析不了的不显示「分析」 | `FE/components/CodeEditorContextMenu.tsx`、`FE/components/AssemblyExplorer.tsx` | 已核实 |
| 10 | 编辑器里单击引用时光标显示为手形，但只有 Ctrl+单击才跳转，而且在同一标签里跳（WPF 单击跳转，Ctrl+单击开新标签） | `FE/components/DocumentView.tsx` 的 `onMouseDown` | 代码推断 |

## 4. 各模块明细

### 4.1 应用壳与通用 UI 框架

完成度 100%（✅ 37 / 🟡 0 / ❌ 0 / ⛔ 3）。WPF 范围：`WPF/MainApp`、`Menus`、`ToolBars`、`ToolWindows`、`Tabs`、`Themes`、`Settings`、`Culture`、`BackgroundImage`、`Output`、`FileLists`、`Commands`。

2026-10-14 按实现与测试复核。此前这一节有 7 个 ❌ 与 17 个 🟡；补上的部分：窗口状态记忆、单实例与参数转发、退出时的未保存询问、工具窗口与标签组的右键命令、标签内容缩放、背景图片渲染、Environment 的字体与 RestoreTabs、主菜单键盘操作、标签快捷键与全局快捷键、关于与帮助菜单、输出窗口的命令栏、消息框的「不再提示」、工具栏与部分图标、**反编译器设置传递给后端（2026-10-14 晚）**。

2026-10-17 补齐剩余的 7 个 🟡（此前表头写的 ✅ 32 / 🟡 5 与表内不符，表内实为 ✅ 30 / 🟡 7）：

- **主题**：移植了 dnSpy 的主题服务。`.dntheme` 按 `Theme.cs` 读取，没写出的颜色按 `ColorInfos.cs` 的颜色树继承或取默认值（`scripts/generate-themes.mjs` 把颜色树与 dnSpy 自带的四个主题生成到 `FE/themes.generated.ts`），程序目录与用户目录下 `Themes/*.dntheme` 也会加载；每个 WPF 资源键写成 `--wpf-<键名>` CSS 变量，样式表照 WPF 模板引用它们（菜单、工具栏、文档标签、工具窗口标题与标签、树、表头、对话框、按钮、文本框、滚动条、状态栏），文本颜色写成 `tc-*` 规则；代码视图的 Monaco 主题也由主题生成（编辑器底色、选区、当前行、行号、各类 token），C# 的 TextMate 作用域映射到 dnSpy 的颜色类型，不再用 VS 的 dark+/light+。Blue 主题因此与 WPF 一样是浅色编辑器。高对比度主题只在系统处于高对比度时列出，系统切换时按 `ThemeService` 自动换主题。
- **界面语言**：与 WPF 一样 15 种。`scripts/generate-locales.mjs` 按英文原文在各语言 resx 里找对应条目生成译文表，没有 resx 对应的移植版自有字符串回落英文（WPF 对 resx 缺的条目也是回落英文）；View → Language 与 WPF 一样是「System」加各语言的本族语名称。
- **字体**：Environment › Font 页照 `FontAppSettingsPage`：类别下拉框（Hex Editor、Output Window、Text Editor）、系统字体列表（等宽字体加粗，Hex Editor 只列等宽字体）、以磅为单位的字号框；字体按主题各存一份（`ThemeFontSettings`），三个类别分别驱动代码视图与 C# 交互窗口、十六进制视图、输出窗口。默认字体按 `FontUtilities` 的候选列表取第一个已安装的。
- **Output 窗口**：「Show output from」下拉框与 Ctrl+1…Ctrl+0 切换窗格；Debug 窗格是调试器的输出（开始调试时清空并切到它，同 `OutputLogger`），另有一个移植版自己的「dnSpy」窗格记录打开、保存、编辑等消息（WPF 用消息框或不显示）。Clear All（Ctrl+L）、Save（Ctrl+S，文件名 `Output-<窗格>.txt`）、Word Wrap（Ctrl+E Ctrl+W）、右键菜单的 Copy / Clear All / Show Line Numbers / Show Timestamps / Word Wrap 都有；时间戳按 Output 选项页的 .NET 格式串写在每行前，换行、行号、时间戳与选项页是同一份设置。
- **消息框**：General 页加上「Enable all warning messages」按钮，与 WPF 一样立即生效。
- **图标**：主菜单、各右键菜单、工具窗口工具栏都换成 dnSpy 图像集，菜单勾选标记、子菜单箭头、树展开三角、标题栏按钮用 WPF 模板里的矢量路径；只剩 WPF 没有对应物的加载动画仍用 lucide。
- **命令行**：`--settings-file` 生效，且与 WPF 一样支持便携模式（程序目录下有 `dnSpy.json` 就用它）：渲染进程的选项、窗口状态、主进程设置与对话框目录都存进这一个文件，渲染进程改用不落盘的独立会话；`-p` / `-pn` 启动后附加到指定进程。

部分 WPF dnSpy 特有的反编译选项在 NuGet 版 ILSpy 中不存在，这属于 4.4。

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| 主窗口与自绘标题栏 | `MainApp/MainWindow.xaml`、`AppWindow.cs` | `MAIN/index.ts`（`frame:false`）、`FE/components/WindowControls.tsx` | ✅ | 标题按 `AppWindow.GetDefaultTitle` 写成 "dnSpy 6.6.0 (64-bit, .NET, Administrator)"，随界面语言变 |
| 窗口位置、尺寸、最大化记忆 | `MainApp/SavedWindowState.cs` | `MAIN/window-state.ts` | ✅ | `userData/window-state.json`；还原前按 dnSpy 的 50×50 规则看是否仍落在某个显示器上，落不上用默认的 10,10,1300,730；最大化与全屏各记各的，取其一 |
| 命令行参数 | `MainApp/AppCommandLineArgs.cs` | `MAIN/command-line.ts`、`MAIN/settings-file.ts`、`FE/command-line-options.ts` | ✅ | 文件路径、`--`、`--multiple`、`--dont-activate`、`-l`、`--culture`（任意区域名，按语言回落）、`--select`、`--new-tab`、`--theme`（名称或 GUID，含用户主题）、`--search*`、`--no-load-files`、`--full-screen`、`--show/hide-tool-window`（含 `!location`）、`--show-startup-time`、`--settings-file`（含便携的 `dnSpy.json`）、`-p`/`-pn`（启动后附加，同调试器的 `AppCommandLineArgsHandler`）都生效。`-e`/`--jdinfo` 是 Windows 注册的 JIT 调试入口，`--extension-directory` 对应 4.16 不支持的扩展，二者只被读下 |
| 单实例与参数转发 | `MainApp/App.xaml.cs` 的 `SwitchToOtherInstance` | `MAIN/index.ts` | ✅ | 后启动的进程把命令行交给先启动的窗口。默认与 WPF 一样「允许多开」（`AppSettings.AllowMoreThanOneInstance` 默认为 true），勾掉选项或写 `--multiple` 才是多开 |
| 以管理员身份重启 | `MainApp/RestartAsAdministratorCommand.cs` | `MAIN/index.ts` 的 `relaunchElevated`、`MAIN/elevated-start.ts` | ✅ | pkexec；提权副本固定走 X11 |
| 退出时的未保存提示 | `MainApp/ViewCommands.cs` | `MAIN/index.ts`、`FE/App.tsx` | ✅ | 有未保存修改时主进程拦下关闭并反问，按「保存/放弃/取消」决定关或留 |
| 全屏 | `MainApp/ViewCommands.cs` | `MenuBar.tsx`、`ToolBar.tsx`、`window:toggleFullScreen` | ✅ | Shift+Alt+Enter（原先被 Alt+Enter 的节点设置截住，已修），工具栏末尾有切换按钮，菜单项带勾 |
| 主菜单 | `Menus/MenuService.cs` | `MenuBar.tsx`、`file-menu.ts`、`edit-menu.ts` | ✅ | 分组、顺序、启用规则照搬；Alt 展开/收起、Alt+字母按助记键展开、左右键换菜单、Esc 关闭，菜单项就是可聚焦按钮 |
| 工具栏 | `ToolBars/ToolBarService.cs`、`MainApp/AppToolBar.cs` | `ToolBar.tsx` | ✅ | 按 `ToolBarConstants` 的分组顺序；保存按钮是「全部保存」，末尾有全屏切换；图标改用 dnSpy 自己的图像集 |
| 状态栏 | `MainApp/AppStatusBar.cs` | `FE/App.tsx` | ✅ | |
| 停靠工具窗口框架 | `ToolWindows/*`、`MainApp/MainWindowControl.cs` | `FE/App.tsx`（flexlayout）、`DockPane.tsx` | ✅ | |
| 工具窗口右键（Hide、Move 系列） | `MainApp/DsToolWindowServiceCommands.cs` | `FE/components/ToolWindowTabContextMenu.tsx` | ✅ | Hide、Hide All Tabs、Move/Move Group 到四个边；可移动的判定照搬 `CanMove`（停靠区已经是那个边就不给选）。四个边映射到本移植版的停靠区，新开的边会新建一个停靠区 |
| 布局持久化与迁移 | `MainApp/MainWindowControl.cs` | `FE/App.tsx` 的 `loadLayout`（`dnspy.layout.v3`） | ✅ | 损坏时回退默认布局 |
| 显示工具窗口的命令 | `MainApp/DocumentTreeViewWindowContent.cs` 等 | `FE/App.tsx` 的 `showToolWindow` | ✅ | View 菜单里标出的快捷键（Ctrl+Alt+L、Alt+2、Ctrl+Alt+B/E/C/H/U/Z、Alt+4、Alt+8 等）都已绑定 |
| 文档标签组（Window 菜单） | `Documents/Tabs/TabCommands.cs`、`Tabs/TabGroupService.cs` | `FE/App.tsx` | ✅ | 「使用垂直/水平标签组」的启用条件按 dnSpy 的 `IsHorizontal` 语义修正 |
| Window 菜单窗口列表 | `Documents/Tabs/TabCommands.cs` | `MenuBar.tsx` | ✅ | |
| 文档标签右键菜单 | `Documents/Tabs/TabCommands.cs` | `DocumentTabContextMenu.tsx` | ✅ | 补上移动/整组移动/关闭组/合并/排列等组命令；不能执行的不出现，整节为空则不出现（照搬 `TabGroupService` 的 CanExecute） |
| Windows 对话框 | `Documents/Tabs/Dialogs/TabsDlg.xaml` | `WindowsDialog.tsx` | ✅ | |
| 标签快捷键 | `Documents/Tabs/TabCommands.cs` | `FE/App.tsx` | ✅ | Ctrl+T、Ctrl+F4、Ctrl+Tab、Ctrl+Shift+Tab（在活动组内循环，两端回绕） |
| 标签内容缩放 | `Tabs/TabElementZoomer.cs` | `FE/zoom.ts`、`FE/App.tsx` | ✅ | 档位表照搬 `ZoomSelector`（20%~400%），Ctrl+=/Ctrl+-/Ctrl+0 与 Ctrl+滚轮；缩放的是编辑器区域整体，dnSpy 是每个标签视图各记一份 |
| 会话恢复 | `Documents/Tabs/DocumentTabSerializer.cs` | `FE/app-store.ts` 的 `loadSession` | ✅ | RestoreTabs 选项已生效；光标与滚动位置已恢复 |
| 最近文件 | `Documents/Tabs/Commands.cs` | `file-menu.ts`、`rememberRecentFiles` | ✅ | 每个文件一条，见 4.3 |
| 打开列表 / 文件列表 | `Documents/Tabs/Dialogs/OpenDocumentListDlg.xaml`、`FileLists/*` | `OpenListDialog.tsx` | ✅ | 见 4.3 |
| 从 GAC 打开 | `Documents/Tabs/Dialogs/OpenFromGACDlg.xaml` | `OpenFromGacDialog.tsx` | ✅ | 见 4.3 |
| 主题 | `Themes/ThemeService.cs`、`Theme.cs`、`ColorInfos.cs`、`*.dntheme` | `FE/theme-service.ts`、`FE/themes.generated.ts`、`FE/monaco-theme.ts`、`MAIN/theme-files.ts`、`styles.css` | ✅ | 读 dnSpy 自带的四个 `.dntheme` 与 `Themes` 目录里的用户主题，颜色继承与默认值同 `Theme.cs`；界面按 WPF 资源键着色，代码视图的 Monaco 主题由主题生成；菜单与 General 页列出 `VisibleThemes`（高对比度主题只在系统高对比度时出现），系统高对比度切换时自动换主题并记下 |
| 界面语言 | `Culture/CultureService.cs` | `FE/localization.tsx`、`FE/locales/*`、`FE/locales.generated.ts`、`shared/ui-locales.ts` | ✅ | 15 种，与 WPF 的 resx 相同；译文由 resx 生成，resx 没有的条目回落英文；View → Language 为「System」加各语言本族语名称；原生对话框的字符串同样按语言 |
| Options 对话框框架 | `Settings/Dialog/AppSettingsDlg.xaml` | `OptionsDialog.tsx`、`options-pages.ts`、`app-options.ts` | ✅ | 框架完整；反编译器设置现已传递给后端并生效（见第 2 节第 1 条更新）；Output 页的自动换行、行号与时间戳生效；仍有页面不生效的是文本编辑器、Hex 编辑器等 |
| Environment › General | `MainApp/Settings/GeneralAppSettingsPage.cs` | `options-pages.ts` | ✅ | Theme（列出所有可见主题）、Allow more than one instance、RestoreTabs、DecompileFullType、UseMemoryMappedIO 均已生效，「Enable all warning messages」按钮立即恢复被「不再提示」的消息；CheckForUpdates 没有对应功能，选项仍在（⛔） |
| Environment › Font | `MainApp/Settings/FontAppSettingsPage.cs`、`Settings/Fonts/*` | `FE/components/FontOptions.tsx`、`FE/fonts.ts`、`MAIN/system-fonts.ts` | ✅ | 三个用户可见的外观类别（Hex Editor、Output Window、Text Editor）各配字体与字号，按主题分别保存；字体列表来自系统（Chromium 的本地字体接口，取不到时用 fontconfig），等宽加粗，Hex Editor 只列等宽；字号以磅显示、像素保存，范围同 `FilterFontSize` |
| 背景图片 | `BackgroundImage/*` | `FE/components/BackgroundImage.tsx`、`MAIN/background-images.ts` | ✅ | 图片与文件夹路径、九个位置、四边百分比边距、偏移、不透明度、Stretch 与 StretchDirection、最大尺寸、缩放、随机轮播与间隔；主进程展开文件夹并把图片读成 data URL。图片开启时编辑器背景透明，图片显示在代码后面（dnSpy 画在每个文本视图里）；Hex 视图仍是不透明的 |
| Output 窗口 | `Output/*`、`DBG/ToolWindows/Logger/OutputLogger.cs` | `FE/components/ToolWindows.tsx` 的 `OutputPane`、`FE/app-store.ts` | ✅ | 「Show output from」切换 Debug 与 dnSpy 两个窗格（Ctrl+1…0），开始调试时清空并切到 Debug；Clear All、Save、Word Wrap、Copy、Show Line Numbers、Show Timestamps 与快捷键同 `OutputContent`；时间戳按选项的 .NET 格式串、在写入时打上；用 Output Window 类别的字体与 OutputWindowText 颜色。dnSpy 窗格是移植版自有的（WPF 不记录这类消息） |
| 消息框 | `MainApp/MessageBoxService.cs` | `FE/message-box.ts`、`MAIN/index.ts` | ✅ | 「不再提示」已实现（`ShowIgnorableMessage` 的语义：抑制后按「继续」，抑制清单随选项一起存，Reset 会清掉）；General 页的「Enable all warning messages」按钮与 WPF 一样清空抑制清单 |
| 关于 | `MainApp/AboutScreen.cs`、`LicenseInfo/*` | `AboutDialog.tsx` | ✅ | 标题按 `AboutScreen` 写成 "dnSpy <版本> (.NET)"，版本读打包版本；鸣谢与第三方许可折在对话框里，内容取自 `dnSpy/dnSpy/LicenseInfo/CREDITS.txt` 与 `CrossPlatform/packaging/licenses/THIRD-PARTY-NOTICES.md`（有单测比对副本是否过期）。dnSpy 那一页还会列出已加载的扩展程序集与一个「Check for updates」按钮：本移植版没有扩展可列，更新也不在范围内 |
| 帮助链接 | `MainApp/AboutCommands.cs` | `MenuBar.tsx` | ✅ | 与 dnSpy 的项一致：最新发布、问题、Wiki、源代码 |
| 启动时检查更新 | `MainApp/StartupUpdateCheck.cs` | 无 | ⛔ | 计划写明「更新机制不进入 MVP」；但 General 页仍留着无效的复选框 |
| Windows 资源管理器集成 | `MainApp/Settings/WindowsExplorerIntegration.cs` | 无 | ⛔ | 注册表功能；Linux 的 .desktop 也没声明 MimeType |
| MEF 扩展加载 | `Extension/ExtensionService.cs` | 无 | ⛔ | 见 4.16 |
| 图标服务 | `Images/ImageService.cs` | `FE/ds-image.ts`、`FE/components/DsIcon.tsx`、`FE/components/DsGlyphs.tsx` | ✅ | 树类行、主菜单与各右键菜单（按 WPF 菜单项的 `Icon` 属性）、工具栏、各工具窗口的命令栏都用 dnSpy 图标集并按主题换色；勾选标记、子菜单箭头、展开三角、窗口与工具窗口按钮用 WPF 模板的矢量路径。加载动画仍是 lucide，WPF 没有对应物 |
| 全局快捷键 | `Commands/CommandService.cs` | `FE/App.tsx` 的 keydown 处理 | ✅ | 菜单上标出的都已绑定；Go to Token 改回 dnSpy 的 Ctrl+D；Shift+Alt+Enter 不再被 Alt+Enter 截住。仍未绑定的是十六进制只读视图里的几个（Ctrl+X 等，本移植版不能改字节） |
| 设置存储 | `Settings/SettingsService.cs`、`App/AppDirectories.cs` | localStorage 的 `dnspy.*` 键、`MAIN/settings-file.ts` | ✅ | 默认存于用户配置目录；`--settings-file` 或程序目录下的 `dnSpy.json`（便携模式）时全部设置存进该文件 |

测试：`MenuBar.test.tsx`、`OptionsDialog.test.tsx`、`DockPane.test.tsx`、`DocumentTabContextMenu.test.tsx`、`ToolWindowTabContextMenu.test.tsx`、`WindowsDialog.test.tsx`、`AboutDialog.test.tsx`、`ToolWindows.test.tsx`（输出窗格、时间戳、行号）、`command-line-options.test.ts`、`zoom.test.ts`、`background-image.test.ts`、`message-box.test.ts`、`window-state.test.ts`、`app-info.test.ts`、`app-store-session.test.ts`、`theme-service.test.ts`（主题解析、继承、资源变量、高对比度、Monaco 主题）、`csharp-highlighting.test.ts`、`fonts.test.ts`（字体与 .NET 时间格式）、`settings-file.test.ts`（设置文件、主题目录、fontconfig）、`localization.test.tsx`、`locales.test.ts`、`ui-locales.test.ts`、`native-messages.test.ts`、`generated-locales.test.ts` 等；e2e `layout.spec.ts`、`session-close.spec.ts`、`app.spec.ts` 的主题持久化与语言切换、`csharp-highlighting.spec.ts`（三个主题的代码颜色）。

### 4.2 工程基础设施（新增，WPF 无对应）

完成度约 83%（✅ 8 / 🟡 4）。

| 项目 | 实现 | 状态 | 备注 |
|---|---|---|---|
| JSON-RPC 传输 | `MAIN/backend-client.ts`、`dnSpy.Backend.Host/JsonRpcServer.cs` | ✅ | stdio + Content-Length 分帧，单条上限 32 MiB |
| 握手 | `JsonRpcServer.cs` 的 `Hello` | ✅ | 协议版本校验、nonce 常量时间比较、capability 表 |
| 取消与超时 | `system/cancel` | ✅ | 默认 60 秒，反编译、搜索、分析、脚本 600 秒 |
| 后端进程监管 | `backend-client.ts`、`Host/Program.cs` | 🟡 | 后端随父进程退出；后端崩溃后不自动重启、不能恢复工作区，日志不落盘 |
| DTO 契约 | `Protocol.cs` ↔ `FE/../shared/protocol.ts` | 🟡 | 两边手写，没有代码生成或契约测试；`JsonRpcServer` 本身没有单测 |
| Electron 安全配置 | `MAIN/index.ts`、`packaging/electron-builder.yml` | ✅ | sandbox、contextIsolation、CSP、fuses；生产 CSP 仍留着 `ws:` 和 `http://127.0.0.1:*` |
| Linux 打包 | `scripts/package-platform.mjs` | ✅ | AppImage、deb，仅 x64 |
| Windows 打包 | 同上 | ✅ | nsis、zip，未签名 |
| macOS 打包 | 同上 | 🟡 | 只有 arm64，没有公证 |
| SBOM、许可证、校验和 | `scripts/generate-sbom.mjs`、`packaging/licenses` | ✅ | CycloneDX 1.6 |
| CI | `.github/workflows/cross-platform.yml` | 🟡 | Linux 跑后端测试、依赖审计、e2e、打包冒烟；**不跑前端 vitest 单测**，Windows/macOS 只打包 |
| 发布流水线 | 同上 | ✅ | push 到 `linux` 更新预发布，`v*` tag 正式发布 |

### 4.3 程序集树（Assembly Explorer）

完成度 100%（✅ 30 / 🟡 0 / ❌ 0 / ⛔ 1）。WPF 范围：`WPF/Documents/TreeView/`、`WPF/TreeView/`、`WPF/Documents/Tabs/` 中的打开与列表命令，以及 `Libraries/ICSharpCode.TreeView`（SharpTreeView）的键盘行为。

与 WPF 仍有的差别都是本文其他模块记录的整体设计差异，不单独计入本节：单击只选中、双击才在标签中打开（4.5「打开节点的标签模型」）；不做单实例转发（4.1）；不建模内存模块（下表 ⛔ 行）。

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| 打开程序集（含 PE、未知文档） | `Documents/Tabs/Commands.cs`、`Dialogs/OpenDocumentsHelper.cs` | `file-menu.ts`、`MAIN/index.ts`，RPC `workspace/open`、`workspace/addModules` | ✅ | 另新增 ELF 文档。打开后选中最后一个文件的根行（OpenDocumentsHelper） |
| Open from GAC | `Documents/Tabs/Dialogs/OpenFromGAC*` | `OpenFromGacDialog.tsx`，RPC `gac/list`、`gac/getDetails` | ✅ | 搜索（多词、名称或版本）、显示重复、右侧详情、多选、双击打开；Ctrl+Shift+O。Linux 上列的是 Mono 的 GAC |
| Open List | `Documents/Tabs/Dialogs/OpenDocumentList*`、`DocumentListService.cs`、`DefaultDocumentList.cs` | `OpenListDialog.tsx`、`FE/document-lists.ts`，RPC `documentList/defaults`（`BE/DefaultDocumentLists.cs`） | ✅ | 命名列表存 localStorage；当前打开的文件随时记入选中列表；内置列表来自本机每个 .NET 共享框架版本。新建列表用内联输入框代替 WPF 的输入对话框 |
| 最近文件 | `Documents/TreeView/AssemblyExplorerMostRecentlyUsedList.cs`、`Documents/Tabs/Commands.cs` 的 `RecentFilesCommand` | `FE/app-store.ts` 的 `rememberRecentFiles`、`openRecentFile`，`file-menu.ts` | ✅ | 每个文件一条，最多 30 条，大小写不敏感去重，最近的在前；Open、Open from GAC、拖放（只记新加的）、命令行会记入，会话恢复和 Open List 不记。菜单项「序号 + 完整路径」，超过 100 字符保留末尾 100 个并加 `[...]`；点开只把该文件加进当前树并选中。旧版按整组记录的列表启动时迁移 |
| Reload All | `Documents/Tabs/DocumentListLoader.cs`、`AE/UndoRedo/UndoRedoDocumentListListener.cs` | RPC `workspace/reload`（`ReloadWorkspaceRequest`），`FE/App.tsx` 的 `reloadAll` | ✅ | 有未保存修改时用 dnSpy 原话询问；重新加载用户打开的文件，自动加载的文档只保留标签还在用的（仍标为自动加载）；随后按节点键恢复展开的分支、选中项和文档标签，Hex / 模块信息标签按文件恢复 |
| Close All / Sort Assemblies | `Documents/Tabs/Commands.cs`、`DocumentTreeView.cs` | RPC `workspace/sortAssemblies` | ✅ | |
| Close All Framework Assemblies / Missing Files | `AE/Commands/CloseAll*Command.cs` | RPC `workspace/getCloseCandidates` + `workspace/removeModules` | ✅ | 走 Remove Assembly：有未保存修改先询问是否保存，被移除文档的标签一并关闭 |
| Close Old In-Memory Modules / Disable MMF | `AE/Commands/CloseOldInMemoryModulesCommand.cs` | 隐藏 | ⛔ | 后端整读镜像，没有 MMF，也不建模内存模块 |
| Remove Assembly | `AE/Assembly/AssemblyCommands.cs` | RPC `workspace/removeModules`；树右键、Edit 菜单、Del 键 | ✅ | 作用于选中的全部根行（程序集、PE、ELF、未知文档），标题「移除 {n} 程序集」。有未保存修改时问「是否要在继续之前保存？」（是：先原地保存，失败则不移除；否：直接移除；取消）。撤销历史里的编辑涉及的文档，移除本身记为一步可撤销的编辑，撤销后同一批节点原样回到原位置；只在重做历史里的文档直接移除并清空重做历史 |
| 会话恢复 | `Documents/Tabs/DocumentTabServiceLoader.cs` | `dnspy.session.v1` | ✅ | |
| 命令行参数 | `MainApp/AppCommandLineArgs.cs`、`Documents/Tabs/AppCommandLineArgsHandler.cs` | `MAIN/command-line.ts`，RPC `tree/selectMember`（`BE/XmlDocKeyProvider.cs`），`FE/App.tsx` 的 `followCommandLine` | ✅ | 非选项参数都是要打开的文件（`--` 之后一律当文件，`file://` 地址转成路径），`--open` 保留；其余 dnSpy 选项连同取值一起跳过。打开后跟随 `--select`：数字（十进制或 `0x`/`&H` 十六进制）是第一个模块里的 token，`N:` 是命名空间，其余按 Roslyn、再按 MSVC 格式的 XML 文档 ID 查找；找不到就打开第一个程序集。单实例与参数转发见 4.1 |
| 拖放（文件、节点） | `Documents/TreeView/DocumentTreeView.cs` | `AssemblyExplorer.tsx`，RPC `workspace/dropFiles`、`workspace/moveRoots` | ✅ | 文件落在哪个根行前就插在哪；目录展开为其下全部文件；多文件时按「拖入项过滤」选项筛选；拖动根行可重新排序 |
| 程序集解析 | `Documents/AssemblyResolver.cs` | `BE/GacFallbackAssemblyResolver.cs`、`BE/GacInfo.cs` 的 `Resolve` | ✅ | 模块目录与目标框架目录之后，非 .NET（Core）目标再查 GAC：先按完整标识找缓存目录，再在 Mono 的引用目录里找同名且版本、公钥标记一致的文件。树的引用解析与反编译器共用这一规则。解析出的程序集作为自动加载的根进树，排在最后，行文字变淡 |
| Load Dependencies | `AE/Compiler/LoadDependenciesCommands.cs` | RPC `workspace/loadDependencies` | ✅ | |
| 程序集 / 模块节点 | `AssemblyDocumentNodeImpl.cs`、`ModuleDocumentNodeImpl.cs` | `GetAssemblyChildren`、`GetModuleChildren` | ✅ | 列出 netmodule；`<Module>` 在 `-` 命名空间里 |
| 命名空间 / 类型 / 成员，访问器嵌套 | `NamespaceNodeImpl.cs`、`TypeNodeImpl.cs` 等 | `GetTypeChildren` 等 | ✅ | |
| 成员分组顺序 | `DocumentTreeViewSettings.cs` | 后端按 WPF 默认顺序输出，`orderTypeChildren` 按选项重排 | ✅ | Assembly Explorer 选项页的五个下拉生效 |
| 隐藏编译器生成的成员 | `TypeNodeImpl.cs` 等的 `ShowMember` | 后端 `compilerGenerated` 标记，树按反编译器选项过滤 | ✅ | 跟随 C# 反编译器「显示隐藏的编译器生成类型和方法」 |
| References 文件夹 | `ReferencesFolderNodeImpl.cs`、`ModuleReferenceNodeImpl.cs` | `GetReferenceChildren` | ✅ | 含 ModuleRef；程序集引用展开为被引用程序集的引用，双击选中被引用的程序集（需要时自动加载） |
| Type References 文件夹 | `TypeReferencesFolderNodeImpl.cs` | `GetTypeReferenceChildren` | ✅ | 类型、泛型实例、方法/属性/事件/字段引用分组；双击跳到定义 |
| 资源节点 | `Documents/TreeView/Resources/*` | `GetResourceChildren`、`BE/WorkspaceManager.Resources.cs` | ✅ | 图片、BAML、序列化资源等专用节点已实现 |
| Base Type / Derived Types | `BaseTypeFolderNodeImpl.cs`、`DerivedTypesFinder.cs` | `GetBaseTypeChildren`、`FindDerivedTypes`，RPC `tree/activate` | ✅ | 双击跳到类型定义（WPF `NodeActivated`）；解析不到时才打开注释文档 |
| 节点外观（文本、token、图标、提示） | 各 `*NodeImpl`、`Images/DotNetImageService.cs`、`Images/ThemedImageCreator.cs` | `AssemblyExplorer.tsx` 的 `NodeIcon`，`FE/ds-image.ts`、`FE/ds-images.generated.ts`（`scripts/generate-tree-images.mjs` 由 `dnSpy/dnSpy.Images` 生成） | ✅ | 行图标就是 dnSpy 图标集里后端点名的那一张（含 Private/Internal/Protected 等访问变体、展开的文件夹），按 ThemedImageCreator 的 HSL 算法对主题背景换色；切换主题只改写样式表，行不重新渲染。构造函数行的着色文本与标签一致（写类型名）。提示含框架与架构 |
| Assembly Explorer 选项页 | `Documents/Tabs/Settings/AssemblyExplorerAppSettingsPage.cs` | `options-pages.ts` | ✅ | 七项全部生效：token、语法高亮、版本号、PublicKeyToken、单击展开、成员顺序、拖入项过滤 |
| 选中、激活与多选 | `Documents/Tabs/DocumentTabService.cs`、ListBox 的 Extended 选择 | `AssemblyExplorer.tsx`、RPC `tree/activate` | ✅ | Ctrl/Shift 多选，Shift 范围从锚点算起（锚点是最后一次单独选中或 Ctrl 切换的行）；右键落在选区内时保留选区；引用类行激活跳转 |
| 键盘导航 | `TreeView/TreeViewImpl.cs`、SharpTreeView 的 `OnKeyDown` / `SharpTreeViewTextSearch` | `AssemblyExplorer.tsx` 的 `onTreeKeyDown`、`TreeTextSearch` | ✅ | ↑↓ Home End PgUp PgDn 移动并选中，Shift 扩选，Ctrl 只移动焦点、Ctrl+Space 切换；← 折叠或回到父行，→ 展开或进入第一个子行；小键盘 + − *；Enter / Space 激活唯一选中行；Ctrl+A 全选；直接键入行首文字查找（连续输入累积前缀、重复同一字母轮换、Backspace 回退、两倍双击时间后清空）。WPF 的输入查找比对的是文本控件的 `ToString()`，实际不可用，这里按行文字比对 |
| Open in New Tab、Open Containing Folder、折叠全部、同步选中 | `TabCommands.cs`、`Commands.cs` | 右键菜单、`revealNode` | ✅ | |
| Go to Entry Point / Global Cctor / Token | `EntryPointCommands.cs`、`GoToTokenCommand.cs` | RPC `module/getSpecialNode`、`tree/findByToken` | ✅ | |
| Copy MD Token / Full Name、Search MSDN | `CopyTokenCommand.cs`、`CopyFullNameCommand.cs`、`SearchMsdnCommand.cs` | `AssemblyExplorerContextMenu.tsx`，后端 `TreeNodeDto.FullName`、`MsdnName` | ✅ | 两个复制命令取第一个选中行，凡代表元数据行（程序集、模块、类型、成员、各种引用、基类型/派生类型）都有；全名即 `IFullName.FullName`。Search MSDN 对每个选中行各开一页：公开（或受保护）的定义、能解析到这种定义的引用行，以及非空命名空间 |
| Save Resource / Raw Save Resource | `AE/Resources/ResourceCommands.cs`、`SaveResources.cs` | RPC `resource/getItems`、`resource/getItemNames`，`MAIN/index.ts` 的 `edit:saveResource`、`MAIN/resource-files.ts` | ✅ | 四个命令齐全：保存 / 以子目录保存 / 直接保存 / 以子目录直接保存。标题按要写出的文件数（.resources 按条目算），一个文件写名字；「以子目录」两项只在多个文件且有名字带目录时出现。单独选中 Resources 文件夹即代表其中全部资源；选区里的非资源行忽略；没有数据可写的资源不显示命令。目录段 `.`/`..` 会改写，资源名不能把文件写到所选目录之外 |
| Go to Resource | `Documents/Tabs/ResourceCommands.cs` | RPC `resource/find`，树右键与代码视图右键 | ✅ | 只在读取 .resources 条目的属性/方法上出现（树里要求只选中一行）；选中并打开该条目 |

测试：后端 `AssemblyExplorerCommandTests.cs`（全名、MSDN 地址跟随引用、着色文本与标签一致、资源保存名、带撤销历史的移除、Reload 保留自动加载文件、`--select`、XML 文档 ID 往返、GAC 与 Mono 引用目录解析）、`WorkspaceManagerTests.cs`（懒加载、基类型/派生类型、FindByToken、PE/ELF、Reload、移除非托管文档等）、`DefaultDocumentListsTests.cs`；前端 `AssemblyExplorer.test.tsx`（键盘导航、输入查找、书签组合键穿透、dnSpy 图标、单击展开、激活、过滤编译器生成成员、成员顺序、拖放、程序集版本）、`AssemblyExplorerContextMenu.test.tsx`（多选移除、四个保存命令、复制与 MSDN、Go to Resource）、`CodeEditorContextMenu.test.tsx`（代码视图 Go to Resource）、`ds-image.test.ts`、`app-store.test.ts`（最近文件、Shift 锚点、移除与撤销、按模块保存）、`MenuBar.test.tsx`（最近文件菜单）、`MAIN/command-line.test.ts`、`MAIN/resource-files.test.ts`、`OpenFromGacDialog.test.tsx`、`document-lists.test.ts`；e2e `assembly-tree.spec.ts`（命令行 `--select` 与最近文件、键盘导航、Reload All 恢复标签、移除后撤销）、`app.spec.ts`、`assembly-tree-performance.spec.ts`。Open from GAC、Open List 两个对话框和拖放仍没有 e2e。

### 4.4 反编译与语言

完成度约 44%（✅ 6 / 🟡 11 / ❌ 9 / ⛔ 1）。WPF 范围：`WPF/Decompiler/`、`WPF/Language/`、`Extensions/ILSpy.Decompiler/`、`Extensions/dnSpy.BamlDecompiler/`、资源查看与导出项目。

后端没有沿用仓库里的 ILSpy 分支，而是用 NuGet 上的 `ICSharpCode.Decompiler 11.1`、`ICSharpCode.BamlDecompiler`，VB 由 `ICSharpCode.CodeConverter` 从 C# 文本转换得到。

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| C# 反编译 | `ILSpy.Decompiler/dnSpy.Decompiler.ILSpy.Core/CSharp/CSharpDecompiler.cs` | `BE/WorkspaceManager.cs` 的 `DecompileCSharp`，RPC `document/decompile` | ✅ | 有引用 span 和语句表 |
| Visual Basic | `.../VisualBasic/VBDecompiler.cs` | `ConvertToVisualBasicAsync`（CodeConverter） | 🟡 | 无 span、无语句表；方法文档会变成空壳类 |
| IL | `.../IL/ILDecompiler.cs` | 自写 `ILFormatter` | 🟡 | 没有 `.try`、`.custom`、`.override` 等；修饰符不是 ilasm 语法；有定义 span、指令操作数的引用 span 与逐指令语句表 |
| IL with C# | `.../Mixed/ILWithCSharpDecompiler.cs` | `DecompileILWithCSharp` | 🟡 | 同上 |
| ILAst | `.../ILAst/ILAstDecompiler.cs` | 无 | ⛔ | WPF 只在 DEBUG 构建注册 |
| 语言下拉与持久化 | `MainApp/ToolBarCommands.cs`、`Decompiler/DecompilerServiceSettings.cs` | `ToolBar.tsx`、`app-store.ts` 的 `changeLanguage` | ✅ | 2026-10-16 起为全局语言：切换时重反编译所有已开标签（含正在加载的），新标签用它，记在 `localStorage`，`-l` 也写入；分析器、字符串引用窗口跟随 |
| C#/VB 反编译选项 | `ILSpy.Decompiler/dnSpy.Decompiler.ILSpy/Settings/CSharpDecompilerSettingsPage.cs` | `options-pages.ts` | ❌ | 不传给后端，见第 2 节 |
| IL 选项 | `.../Settings/ILDecompilerSettingsPage.cs` | `options-pages.ts` | ❌ | 同上 |
| DecompileFullType | `Documents/Tabs/DocumentTabServiceSettings.cs` | `app-options.ts` | ❌ | 没人读取 |
| 源码与 IL 的语句映射 | `Decompiler/MethodDebugService.cs` | `BuildCodeStatements`、`BE/StatementIlRanges.cs`、`ILFormatter` | 🟡 | C# 与 IL（逐指令）有；VB 没有 |
| 异步反编译与取消 | `Documents/Tabs/AsyncShowResult.cs` | `DocumentView.tsx` 加载提示 | 🟡 | 没有取消按钮 |
| 反编译缓存 | `Documents/Tabs/DecompilationCache.cs` | 无 | 🟡 | 已开标签保留文本；重开同一节点会重新反编译 |
| 换语言或编辑后刷新 | `Documents/Tabs/RedecompileTabs.cs` | `changeLanguage`、`refreshAfterEdit` | ✅ | |
| 多节点合并反编译 | `Documents/Tabs/DocumentTreeNodeDecompiler.cs` | 无 | ❌ | |
| 程序集 / 模块节点输出 | `dnSpy.Decompiler/DecompilerBase.cs` | `DecompileWholeModuleAsSingleFile` | 🟡 | 反编译整个模块，大程序集很慢 |
| 命名空间节点输出 | `DecompilerBase.DecompileNamespace` | 同上 | 🟡 | 输出全部类型的完整代码（WPF 只列类型名） |
| 其他非代码节点 | `Documents/Tabs/NodeDecompiler.cs` | `DecompilePEInfo` 等 | 🟡 | 文件夹节点不打开文档 |
| Save Code | `Documents/Tabs/NodeTabSaver.cs` | `saveCode` | ✅ | BAML 存为 `.xml` |
| Export to Project | `Documents/Tabs/Dialogs/ExportToProjectDlg.xaml` | `file-menu.ts`（恒灰） | ❌ | 命令行的导出已实现（4.17，`dnSpy.Console`），GUI 菜单仍未接线 |
| `.resources` 条目显示 | `Documents/TreeView/Resources/BuiltInResourceElementNodeImpl.cs` | `DecompileResourceEntry` | 🟡 | 非字符串条目显示原始十六进制 |
| 图片资源预览 | `Resources/ImageResourceNode.cs` 等 | 无 | ❌ | |
| 嵌入资源文本识别 | `ResourceUtilities.cs` | `DescribeResource` | ❌ | 只显示 "Embedded resource, N bytes" |
| 保存资源 | `AE/Resources/ResourceCommands.cs` | RPC `resource/getItems` | ✅ | 与 4.3 重复计入 |
| Go to Resource | `Documents/Tabs/ResourceCommands.cs` | 树右键、代码视图右键 | ✅ | 与 4.3 重复计入 |
| BAML → XAML | `BamlDecompiler/XamlDecompiler.cs` | `DecompileResourceEntry` | 🟡 | 无 span、无悬停 |
| Disassemble BAML | `BamlDecompiler/BamlDisassembler.cs` | 无 | ❌ | |
| BAML 选项页 | `BamlDecompiler/BamlSettings.cs` | `options-pages.ts` | ❌ | 后端写死设置 |

测试：后端 `WorkspaceManagerTests.cs`（C#/IL、语句表、BAML、资源数据）、`DecompilationConcurrencyTests.cs`；e2e `app.spec.ts`（切换 IL、Save Code、保存资源）。VB 方法级、选项生效、资源预览没有测试。

### 4.5 代码编辑器与文档标签

完成度约 35%（✅ 4 / 🟡 13 / ❌ 13）。WPF 范围：`WPF/Text/`、`WPF/Documents/Tabs/`（DocViewer、导航历史）。编辑器是 Monaco，右键菜单为自绘的 `FE/components/CodeEditorContextMenu.tsx`。

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| 打开节点的标签模型 | `Documents/Tabs/DocumentTabService.cs` | `FE/App.tsx` 的 `addDocumentTab` | 🟡 | WPF 在活动标签里替换内容；这里每节点一个标签 |
| 单击 / Ctrl+单击引用 | `DocViewer/DocumentViewerMouseProcessor.cs` | `DocumentView.tsx` 的 `onMouseDown` | 🟡 | 见缺陷 #10 |
| F12 / Ctrl+F12 / Enter | `Text/Editor/TextReferenceCommandInfoProvider.cs` | `DocumentView.tsx` | 🟡 | 只绑了 F12 |
| 跳转落点 | `Documents/Tabs/TreeNodeReferenceDocumentTabContentProvider.cs` | `openReferenceTarget` | ❌ | 总是打开成员自己的文档，光标在顶部；同文档内不移动光标 |
| 引用指向未加载模块时按需打开 | `Documents/Tabs/DocTabReferenceNavigator.cs` | RPC `document/findMember` | ✅ | |
| IL/VB 引用、局部变量与参数引用 | `DocViewer/DocumentViewerDotNetSpanMap.cs` | `SpanTextOutput` | ❌ | 见第 2 节 |
| 引用高亮、相关关键字高亮 | `DocViewer/DocumentViewerHighlightReferencesTagger.cs` | 无 | ❌ | |
| 在引用间移动（Tab、Ctrl+Shift+↑↓） | `DocViewer/DocumentViewerCommandTargetFilter.cs` | 无 | ❌ | |
| Quick Info 悬停 | `Documents/Tabs/DocViewer/ToolTips/*` | 固定文本 "Go to definition (F12)" | ❌ | hover contrib 也没打包 |
| 后退 / 前进 | `Documents/Tabs/NavigationCommands.cs`、`TabHistory.cs` | `goBack`、`goForward` | 🟡 | 只有工具栏按钮；历史是全局的，不记光标 |
| 查找 / 替换 / F3 | `Text/Editor/Search/SearchService.cs` | `editor-registry.ts` | ❌ | 已接线但无效，见第 2 节 |
| 转到行 | `Text/Editor/GoToCommand.cs` | 无 | ❌ | |
| 折叠 / 大纲 | `Text/Editor/BlockStructureService.cs` | 无 | ❌ | 后端 `MarkFoldStart/End` 是空实现 |
| 块结构线 | 同上 | Monaco 缩进参考线 | 🟡 | 按缩进画线 |
| 括号匹配 | `DocViewer/BracePairService.cs` | 无 | ❌ | |
| 方法分隔线 | `DocViewer/LineSeparator*` | 无 | ❌ | |
| 缩放 | `Text/Editor/ZoomControlMargin.cs` | 无 | ❌ | |
| 行号 | `Text/Editor/LineNumberMargin.cs` | Monaco 默认 | 🟡 | 选项开关不生效 |
| 高亮当前行 | `DocViewer/Commands.cs` | `highlightCurrentLine` | ✅ | |
| 自动换行 | `DocViewer/Commands.cs` | `DocumentView.tsx` | 🟡 | 快捷键未绑定，与选项页不同步 |
| 显示空白 | `Text/Editor/DefaultTextEditorCommandInfoProvider.cs` | 写死 | ❌ | |
| 带格式复制 | `Text/Editor/CopyWpfTextViewCreationListener.cs` | `DocumentView.tsx` 的 `onCopy` | 🟡 | 右键 Copy 只写纯文本 |
| 语法着色 | `DocViewer/DecompilerTabContentClassifierContext.cs` | `csharp-highlighting.ts`（Shiki）、`il-language.ts` | 🟡 | 只有词法着色，没有语义着色 |
| 文本编辑器选项与字体 | `Text/Settings/*` | `options-pages.ts` | ❌ | `DocumentView` 不读任何字段 |
| 右键 Open in New Tab / Copy Token / Full Name / MSDN | `TabCommands.cs` 等 | `CodeEditorContextMenu.tsx` | ✅ | |
| 右键 Go to Token / Entry Point / Resource | `GoToTokenCommand.cs`、`EntryPointCommands.cs`、`ResourceCommands.cs` | `CodeEditorContextMenu.tsx` | 🟡 | Go to Resource 已接入；Go to Token、Go to Entry Point 仍只在树菜单里有 |
| 标签右键与快捷键 | `Documents/Tabs/TabCommands.cs` | `DocumentTabContextMenu.tsx` | 🟡 | 见 4.1 |
| 标签组与 Window 菜单 | `Tabs/TabGroupService.cs` | `FE/App.tsx` | ✅ | 与 4.1 重复计入 |
| 会话恢复标签 | `Documents/Tabs/DocumentTabSerializer.cs` | `buildSession`、`loadSession` | 🟡 | 与 4.1 重复计入 |
| Show Code | `Documents/Tabs/Commands.cs` | `showCode` | 🟡 | 会把语言切回 C# |

测试：`CodeEditorContextMenu.test.tsx`、`csharp-highlighting.test.ts`、`il-language.test.ts`；e2e `app.spec.ts`（F12 与历史、外部引用、编辑器右键）、`csharp-highlighting.spec.ts`。查找、悬停、折叠、缩放没有测试，这也是 contrib 缺失一直没被发现的原因。

### 4.6 书签

完成度约 100%（✅ 18 / ❌ 0）。WPF 范围：`WPF/Bookmarks/`。

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| 切换书签 | `Bookmarks/Commands/AppMenuCommands.cs` | `FE/bookmark-commands.ts`、`DocumentView.tsx` | ✅ | Ctrl+K,K 可用；Ctrl+F2、Ctrl+B,T 未绑定 |
| 边距点击与图标 | `Bookmarks/TextEditor/BookmarkGlyphTextMarkerHandler.cs` | `DocumentView.tsx` | ✅ | |
| 启用 / 禁用（单个、全部） | `AppMenuCommands.cs` | `toggleBookmarkEnabledAt` 等 | ✅ | |
| 上一个 / 下一个 | `Bookmarks/Navigator/BookmarkNavigatorImpl.cs` | `stepBookmark` | ✅ | F2、Shift+F2 未绑定（F2 用于重命名） |
| 同标签的上一个 / 下一个 | `AppMenuCommands.cs` | `stepBookmark(sameLabel)` | ✅ | |
| 文档内上一个 / 下一个、清除文档内全部 | `AppMenuCommands.cs` | `bookmark-commands.ts` | ✅ | |
| 清除全部 | `AppMenuCommands.cs` | `clearBookmarks` | ✅ | |
| 定位模型 | `Bookmarks/DotNet/DotNetMethodBodyBookmarkLocationImpl.cs` | `bookmarkIdentityOf` | ✅ | C# 文档完全支持；IL/VB 文档允许临时书签（WPF 不允许） |
| 持久化与重新关联 | `Bookmarks/Impl/BookmarksSerializer.cs` | `dnspy.bookmarks.v1` | ✅ | |
| 书签窗口列表 | `Bookmarks/ToolWindows/Bookmarks/BookmarksVM.cs` | `BookmarksPane.tsx`、`bookmark-model.ts` | ✅ | 支持按列排序（大小写不敏感） |
| 重命名、编辑标签 | `Bookmarks/ToolWindows/Bookmarks/Commands.cs` | `BookmarksPane.tsx` | ✅ | |
| 搜索（n:/l:/o:/m: 前缀） | `BookmarksVM.cs` | `filterBookmarks` | ✅ | |
| 跳转 | `BookmarksOperations.cs` | `goToBookmark` | ✅ | 双击或 Enter 跳转 |
| 删除、启用、禁用匹配项 | `BookmarksOperations.cs` | `BookmarksPane.tsx` | ✅ | |
| 复制、全选 | `Commands.cs` | `BookmarksPane.tsx`、`bookmark-model.ts` | ✅ | 四列制表符分隔格式 |
| 导入 / 导出 | `BookmarksOperations.cs`（XML） | `BookmarksPane.tsx`、`BE/WorkspaceManager.Bookmarks.cs` | ✅ | 完全兼容 WPF XML 格式 |
| Location 列格式化 | `DotNetBookmarkLocationFormatter.cs` | `BE/WorkspaceManager.Bookmarks.cs`、`CSharpMemberFormatter.cs` | ✅ | Token、成员签名、IL 偏移，支持全部显示选项 |
| 显示选项 | `Commands.cs` | `options-pages.ts`、`bookmarkLocationFormat` | ✅ | 7 个选项：Token、模块名、参数类型/名称、声明类型、返回类型、命名空间、内置类型关键字 |
| 书签选项页 | `Bookmarks/Settings/BookmarksAppSettingsPage.cs` | `options-pages.ts`、`BookmarksPane.tsx` | ✅ | 所有选项已生效（语法高亮、Location 列显示） |

测试：`BookmarksPane.test.tsx`、`app-store.test.ts`、`bookmark-model.test.ts`；后端 `BookmarkTests.cs`；e2e 覆盖边距添加、重载保留、导入导出、Ctrl+K 组合键。

### 4.7 Hex 编辑器（浏览与交互）

完成度约 84%（✅ 24 / 🟡 4 / ❌ 3）。WPF 范围：`WPF/Hex/`，以及 `AE/Hex/` 中的「Show in Hex Editor」等定位命令。从节点出发的 Hex 写入见 4.12。

2026-10-18 按实现与测试复核。WPF 的编辑器模型已经移植：`hex-model.ts` 照 `HexBufferLineFormatterImpl`、`HexOffsetFormatter`、`HexValueFormatter` 与 `SettingsConstants` 做行布局（每行字节数含「适合宽度」、分组、33 种值格式、四种偏移格式、大小写、ASCII 列与不可读单元格），`FE/components/HexEditor.tsx` 是整文件可滚动的转储（按 64 KiB 分块按需读取，只画视口内的行），有光标、选区、直接键入、右键菜单、四个对话框与查找条。旧的分页只读视图已删除。

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| Open Hex Editor | `AE/Hex/Commands.cs` | `hex-menu.ts`，RPC `hex/getLength`、`hex/readRange` | ✅ | 托管模块、PE-only、ELF 与未知文件都能打开并浏览（缺陷 #6 已修） |
| Show Instructions in Hex Editor（当前语句） | 同上 | RPC `hex/resolveStatement` | ✅ | |
| Show Instructions / Method Body / Initial Value | 同上 | RPC `hex/resolveTarget`、`BE/HexTargets.cs` | ✅ | |
| Show in Hex Editor（资源） | 同上 | `ResolveResourceTarget` | 🟡 | 只认 EmbeddedResource，资源元素没有目标 |
| Show in Hex Editor（地址引用） | 同上 | 隐藏 | ❌ | 代码里没有地址引用模型 |
| Hex Write return true/false/空方法体 | 同上 | `edit/hexPatch` | ✅ | 与 4.12 重复计入 |
| Hex Copy / Paste Method Body | 同上 | `hexCopyMethodBody` 等 | ✅ | 与 4.12 重复计入 |
| 字节显示 | `Hex/Editor/WpfHexViewImpl.cs` | `hex-model.ts` 的 `lineOf`、`HexView` | ✅ | 每行字节数（含适合宽度）、值格式、分组、大小写、偏移格式、列开关与 ASCII 列 |
| 滚动 | `Hex/Editor/HexViewScrollerImpl.cs` | `HexView` 的滚动与行虚拟化 | ✅ | 全文件连续滚动，滚轮、滚动条、方向键、PageUp/PageDown |
| Go to Position | `Hex/Commands/GoToPositionDlg.xaml` | `HexGoToPositionDialog`、RPC `hex/resolvePosition` | ✅ | 绝对/文件/RVA/当前位置，可选「选中到新位置」；数字按 dnSpy 规则解析（十进制，`0x`/`&H`/`h` 为十六进制） |
| Go to Metadata | `Hex/Commands/GoToMetadataDlg.xaml` | `HexGoToMetadataDialog`、RPC `hex/goToMetadata` | ✅ | 元数据标记、方法体、#Blob、#Strings、#US、#GUID；流与表的文件偏移由 dnlib 给出 |
| Select | `Hex/Commands/SelectDlg.xaml` | `HexSelectDialog` | ✅ | 起点/终点或起点/长度，四种位置类型 |
| 光标与选区 | `Hex/Editor/HexCaretImpl.cs`、`HexSelectionImpl.cs` | `HexView` 的 caret/anchor | ✅ | 点击、拖动、Shift+点击、方向键按半字节移动、Tab 切换列、Ctrl+A |
| 直接键入改字节 | `Hex/Operations/HexEditorOperationsImpl.cs` | `hexWriteBytes` → `edit/hexPatch` | ✅ | 值列改半字节、ASCII 列按选项里的编码写字节；每次按键一次可撤销的事务 |
| 撤销 / 重做 | `AE/Hex/HexBufferUndoRedo.cs` | `edit/undo`、`edit/redo` | ✅ | 字节写入是普通编辑事务，撤销后视图自动重读 |
| 删除 / 清零 | `Hex/ContextMenuCommands/Commands.cs` | 右键的 Clear Byte / Clear Selected Bytes（Del） | ✅ | |
| Fill Selection | 同上 | 右键的 Fill Selection... | ✅ | 按字节值填充，默认 0xFF |
| Copy / Copy Special | 同上、`Hex/Operations/ClipboardUtils.cs` | 右键 Copy Special 子菜单 | ✅ | 十六进制、UTF-8、Unicode、C#/VB 数组、文本、偏移、UInt16/32/64（含大端）、文件偏移 |
| Paste / Paste Special | 同上 | 右键 Paste Special 子菜单与 Ctrl+V | ✅ | 十六进制、UTF-8/Unicode 字符串（含 7 位长度前缀）、.NET 元数据 Blob |
| 查找 / 替换 | `Hex/Editor/Search/HexViewSearchService.cs` | 查找条、RPC `hex/find` | 🟡 | 十六进制或文本、F3/Shift+F3、循环；没有替换与增量查找 |
| 右键「每行字节数」「值格式」 | `Hex/ContextMenuCommands/Commands.cs` | `HexView` 的右键菜单 | ✅ | 每行字节数（适合宽度、8/16/32/48/64）与 33 种值格式，带勾选 |
| 本地设置对话框 | `Hex/Commands/LocalSettingsDlg.xaml` | `HexLocalSettingsDialog` | ✅ | 列开关、起始/结束/基准位置、相对位置、偏移位数、每行字节数、值格式与偏移格式 |
| Save Selection | `Hex/ContextMenuCommands/Commands.cs` | 右键 Save Selection...、IPC `hex:saveSelection` | ✅ | 原生保存对话框，按 1 MiB 分块读出后写盘 |
| 只显示选中字节 | 同上 | 右键的 Show Only Selected Bytes / Show All Bytes（Ctrl+D、Ctrl+Shift+D） | ✅ | 视图限定在选区之内，行号与滚动随之重算 |
| Refresh | 同上 | 右键 Refresh（F5） | ✅ | 丢弃分块缓存重新读取，编辑与撤销也会自动重读 |
| 结构信息（悬停、结构高亮） | `Hex/Files/*`、`Hex/Intellisense/*` | 无 | ❌ | 没有 PE/元数据结构模型接到 hex 视图 |
| F12 跳到代码、Follow 引用、Edit Field | `Hex/ContextMenuCommands/*` | 无 | ❌ | 依赖上一条的结构模型 |
| 命中范围高亮 | `Hex/Editor/HexMarkerService.cs` | `.hex-byte-marked` | ✅ | 查找结果与「Show ... in Hex Editor」的范围内都标出 |
| Hex 选项页 | `Hex/HexEditor/*AppSettingsPage.cs` | `HexView` 读取 `hexEditor.hexViewer` | 🟡 | 影响显示的那几项已生效（当前行高亮、列分隔线、值/偏移大小写、分组、偏移格式、ASCII 编码、每行字节数默认值）；高亮当前值、结构高亮、滚动条与缩放页仍不生效 |
| 当前行高亮、列分隔线、缩放 | `Hex/Editor/CurrentLineHighlighter.cs` 等 | `.hex-current-line`、`.hex-column-lines`，全局缩放 | ✅ | 前两项跟随选项页；缩放沿用文档标签的 Ctrl+滚轮 |
| Hex 标签跨会话恢复 | `AE/Hex/HexViewUIStateSerializer.cs` | `dnspy.hexViews.v1` | 🟡 | 每个文件的光标、选区、每行字节数与值格式在下次打开同一文件时恢复；标签本身仍只由 Reload All 重新打开，不随会话恢复 |

实现要点：后端新增 `hex/resolvePosition`、`hex/goToMetadata` 与 `hex/find`（`BE/WorkspaceManager.cs`），`hex/getLength` 与 `hex/readRange` 改为接受 `IModuleEntry`，因此 PE-only、ELF 与未知文件也能浏览；字节写入仍走 `edit/hexPatch`，一次按键一个事务。

测试：后端 `WorkspaceManagerTests.cs`（有界读取、目标解析、补丁读回、位置/元数据/查找、原生 PE 读取）；前端 `hex-model.test.ts`（行布局、值格式、偏移格式、复制/粘贴格式、查找解析）与 `SpecialDocuments.test.tsx`（渲染、分块读取、导航标记、按键、Ctrl+A、键入写字节、无分页）；e2e 覆盖 hex 写方法体并撤销、在 hex 中打开指令、光标移动、Go to Position、查找、Select All、Go to Metadata 与 `4D 5A` 断言。

### 4.8 元数据/PE 视图与本机反汇编

完成度约 38%（✅ 7 / 🟡 2 / ❌ 12）。WPF 范围：`AE/Hex/Nodes/`、`AE/Hex/PE/`、`WPF/Metadata/`、`WPF/Disassembly/`。ELF 结构视图和右键「Module Information」是移植版新增的，不计入。

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| 托管模块下的 PE 节点 | `AE/Hex/Nodes/PETreeNodeDataProvider.cs` | `GetPEChildren` | ✅ | |
| 本机 PE 文件的 PE 节点 | 同上 | `GetPeDocumentChildren`、`BE/PeOnlyModuleEntry.cs` | ✅ | |
| PE 节点整体文档 | `AE/Hex/Nodes/PENode.cs` | `AppendPeStructures` | ✅ | |
| DOS / File / Optional 头 | `AE/Hex/Nodes/ImageDosHeaderNode.cs` 等 | `BE/PeStructureFormatter.cs` | ✅ | |
| 节表头 | `AE/Hex/Nodes/ImageSectionHeaderNode.cs` | 同上 | ✅ | |
| COR20 头 | `AE/Hex/Nodes/ImageCor20HeaderNode.cs` | 同上 | ✅ | |
| Storage Signature / Header / 流 | `AE/Hex/Nodes/Storage*Node.cs` | 同上 | ✅ | |
| 字段网格与就地编辑 | `AE/Hex/Nodes/HexDocumentTabContent.cs`、`AE/Hex/PE/HexField.cs` | 无 | ❌ | 只有只读文本 |
| #~ 表流头 | `AE/Hex/Nodes/TablesStreamNode.cs` | 无 | ❌ | |
| 元数据表节点 | `AE/Hex/Nodes/MetadataTableNode.cs` | 无 | ❌ | |
| 元数据表视图（行×列） | `AE/Hex/PE/MetadataTableVM.cs` | 无 | ❌ | |
| 元数据行节点 | `AE/Hex/Nodes/MetadataTableRecordNode.cs` | 无 | ❌ | |
| Sort Table / Sort Selection | `AE/Hex/MDTableContextMenuCommands.cs` | `edit-menu.ts`（灰显） | ❌ | |
| Go to RID | 同上 | 灰显 | ❌ | |
| MD 表 Show in Hex Editor | 同上 | 灰显 | ❌ | |
| MD 表 Copy as Text / Copy / Paste | 同上 | 灰显 | ❌ | |
| Go to MD Table Row | `AE/Hex/Commands.cs` | 灰显 | ❌ | |
| PE 结构节点 Show in Hex Editor | 同上 | 隐藏 | ❌ | PE 结构与 hex 视图没有联动 |
| 本机反汇编查看器 | `WPF/Disassembly/Viewer/*`、`DBG/dnSpy.Debugger/Disassembly/*` | `DebugPlaceholder` | ❌ | 没有反汇编器 |
| Disassembler 选项页 | `WPF/Disassembly/Viewer/DisassemblyAppSettingsPage.cs` | `options-pages.ts` | 🟡 | 只有持久化 |
| Code Style（MASM/NASM/GAS） | `WPF/Disassembly/X86/*` | `options-pages.ts` | 🟡 | 只有持久化 |

`docs/linux-release-1.0.md` 中的「ECMA-335 Metadata Tables」实际只是 Module Information 里的各表行数。

测试：后端 PE 结构 5 条、ELF 5 条；e2e `pe-structure.spec.ts`、`elf-structure.spec.ts`。

### 4.9 搜索窗口

完成度 100%（✅ 29）。WPF 范围：`WPF/Search/`。后端的匹配器、过滤器、遍历器（`BE/Search/`）逐段对照 WPF 移植。2026-10-16 补齐原来的 4 个 🟡 与 1 个 ❌ 并按实现与测试复核：此前「命令行 `--search*`」标 ❌，实际已随程序集树一轮接通；「位置 4 项」标「树单选」，实际前端早已传整个选区。后端、前端单测与 e2e 都在本机真实构建后跑过（见本节末尾）。

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| 打开窗口（Ctrl+Shift+K、菜单、工具栏） | `Search/Commands.cs` | `FE/App.tsx`、`edit-menu.ts`、`ToolBar.tsx` | ✅ | |
| 打开后聚焦并全选 | `Search/SearchService.cs` | `search-store.ts` 的 `requestFocus` | ✅ | |
| 边输入边搜（500ms） | `Search/SearchControlVM.cs` | `search-store.ts` | ✅ | 另加 Enter 立即搜 |
| 搜索类型 24 项 | `Search/SearchType.cs`、`SearchControl.xaml` | `FE/search-model.ts`、`SearchPaneParts.tsx` 的 `SearchTypeBox`、`BE/Search/SearchFilter.cs` | ✅ | 自绘下拉框：每项带 dnSpy 的图标（Template、StructurePublic、DelegatePublic 等与 SearchControlVM 一致），有快捷键的项以 `Ctrl+字母` 为提示；收起时上下键直接换项，Alt+↓ / F4 / Enter / 空格展开 |
| 位置 4 项 | `Search/SearchControlVM.cs` | `BE/WorkspaceManager.Search.cs`、`search-store.ts` 的 `searchSelectionOf` | ✅ | 作用于树的整个选区；「选中类型」按 dnSpy 的 `GetAncestorOrSelf<TypeNode>` 取每行所在的类型，基类型 / 派生类型文件夹里的行算作文件夹所挂的类型（这层父子关系只有前端的树知道） |
| 选项 6 个复选框 | `Search/SearchControl.xaml` | `SearchPane.tsx` | ✅ | |
| 名称匹配（分词、全词、大小写、正则） | `dnSpy.Contracts.DnSpy/Search/SearchComparers.cs` | `BE/Search/SearchComparers.cs` | ✅ | |
| 字面量匹配 | 同上、`Search/FilterSearcher.cs` | `SearchComparers.cs`、`FilterSearcher.cs` | ✅ | |
| 遍历与过滤语义 | `Search/FilterSearcher.cs` | `BE/Search/FilterSearcher.cs` | ✅ | 包含 `<Module>` 全局函数和字段；模块引用结果无法跳转（树里没有这种行，WPF 同样跳不过去） |
| 资源搜索（含 BAML） | `Search/FilterSearcher.cs` | `ResourceTexts.cs`、`DecompileBaml` | ✅ | |
| 在框架程序集中搜索 | `FrameworkFileUtils` | `BE/Search/FrameworkAssemblies.cs` | ✅ | |
| 搜索编译器生成的成员 | `FilterSearcher.IsCompilerGenerated` | `BE/Search/CompilerGeneratedMembers.cs` | ✅ | 不随反编译器选项变化 |
| 结果列表（图标、高亮、排序） | `Search/SearchResult.cs` | `SearchResultFormatter.cs`、`SearchPane.tsx` | ✅ | 按视口渲染 |
| 结果文本随语言变化 | `Search/SearchService.cs` 的 `DecompilerChanged`、`SearchResult.CreateUI` | `BE/Search/SearchResultFormatter.cs`、RPC `search/relabel`、`search-store.ts` 的 `relabel` | ✅ | 成员走反编译器的 `Write`：C# 与两种 IL 视图都是 C# 格式化器（WPF 的 IL 反编译器不覆写它），VB 是移植的 `VisualBasicFormatter`（`BE/VisualBasicMemberFormatter.cs`）；类型走各语言的 `WriteType`（IL 写成 ``Nested`1``、``SearchTarget.Library/Nested`1``）。切换语言时后端按保留的最近 4 次搜索重写已有结果，不重搜、选中项不变；切换后才到的批次再补写一次 |
| 结果提示 | `SearchResult.CreateToolTipUI` | `SearchResultFormatter.WriteToolTip`、`SearchPaneParts.tsx` 的 `SearchResultToolTip` | ✅ | 成员走各语言的 `WriteToolTip`：C#（`CSharpMemberFormatter.WriteToolTip`，含 `(constant)`、默认值、`[deprecated]`、`(awaitable, extension)`、`(+ N overloads)`）、VB 同理、IL 用反汇编器的写法（`BE/ILMemberFormatter.cs`：`instance string NS.T::M(int32)`、`.property … { .get; }`）；方法体命中另起一行写 `IL_0002: ldc.i4 31337`，最后一行是文件路径。悬停 400ms 出现，开着语法高亮时按颜色画 |
| 边搜边出 | `Search/DocumentSearcher.cs` | RPC `search/run` + `search/progress` | ✅ | 单线程切片 |
| 上限 10,000 与红框 | 同上 | `BE/Search/SearchRun.cs` | ✅ | |
| 跟随结果（含方法体内定位） | `SearchService.FollowResult` | `SearchPane.tsx`、`findSearchResultCaret` | ✅ | C# 定位到语句起点，IL 定位到那条指令（IL 视图的语句即指令）；VB 视图没有语句表（见第 2 节第 3 条），只打开方法 |
| 右键：转到引用 / 新标签 | `Search/Commands.cs` | `SearchContextMenu.tsx` | ✅ | |
| 右键：复制 token / 全名 | `CopyTokenCommand.cs` 等 | 同上 | ✅ | |
| 右键：类断点 / 跟踪点 / 方法断点 | `DBG/.../ClassBreakpointCommands.cs` | 同上 | ✅ | |
| 右键：分析 / MSDN | `Extensions/dnSpy.Analyzer/TreeNodes/Commands.cs` | 同上 | ✅ | |
| 右键：选项组 | `Search/Commands.cs` | 同上 | ✅ | |
| 窗口内 Ctrl+字母快捷键 | `Search/SearchService.cs` | `SearchPane.tsx` | ✅ | |
| Ctrl+Shift+R 分析结果 | `Analyzer/TreeNodes/Commands.cs` | `SearchPane.tsx` | ✅ | |
| 设置持久化 | `Search/SearchSettings.cs` | `app-options.ts` | ✅ | |
| 文档变化时清空或重搜 | `Search/SearchService.cs` | `search-store.ts` | ✅ | |
| 关闭窗口时停止并清空 | `Search/SearchToolWindowContent.cs` | `FE/App.tsx` 的 `onModelChange` | ✅ | |
| 命令行 `--search*` | `Search/AppCommandLineArgsHandler.cs` | `MAIN/command-line.ts`、`FE/command-line-options.ts`、`FE/App.tsx` | ✅ | `--search`、`--search-for`、`--search-in` 与 WPF 的全部别名；WPF 设好文本后照常等 500ms 再搜，这里立即搜 |

顺带修正：IL 写其他程序集的类型时，方括号里写的是程序集全名（`['System.Runtime, Version=…']`），ILSpy 的 `GetScopeName` 只写简单名（`[System.Runtime]`），已改正，分析器的 IL 行文本同样受益。

测试：后端 `WorkspaceSearchTests.cs` 18 条（新增按语言写结果、按语言写提示、`search/relabel` 3 条）、`CSharpMemberFormatterTests.cs` 9 条、`VisualBasicMemberFormatterTests.cs` 7 条；前端 `search-model.test.ts`、`search-store.test.ts`、`SearchPane.test.tsx`（新增下拉框、提示、换语言保留选中、选中类型取祖先、换语言重写与批次补写）；e2e 4 条（新增「按工具栏语言重写列表并在提示里解释结果」）。2026-10-16 本机构建后：后端 425 条、前端 1110 条全部通过，e2e 全套 93 通过、3 跳过。

### 4.10 分析器

完成度 100%（✅ 29 / ⛔ 1）。WPF 范围：`Extensions/dnSpy.Analyzer/`。后端在 `BE/Analyzer/`，详细设计见 `CrossPlatform/ANALYZER_HANDOFF.md`。2026-10-16 补齐原来的 4 个 🟡 并按实现与测试复核：后端、前端单测与 e2e 都在本机真实构建后跑过（见本节末尾）。

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| 工具窗口，关闭即清空 | `AnalyzerToolWindowContent.cs` | `FE/App.tsx` | ✅ | |
| 添加：每成员一行，重复分析回到已有行 | `AnalyzerService.cs` | `FE/analyzer-store.ts` | ✅ | |
| 行文本、图标、显示标记 | `TreeNodes/*Node.cs` | `BE/Analyzer/AnalyzerLabelFormatter.cs` | ✅ | 类型名按所选反编译器书写：C# 走 `CSharpTypeName`，VB 走同一转换再按 VB 写（`Integer`、`List(Of T)`、关键字名加方括号），IL 走 `ILTypeName`（`int32`、`class [asm]NS.List`1<string>`、`!T`、`Outer/Inner`）；类型行与索引器名也按 WPF 各语言的 `FormatTypeName` / `FormatPropertyName` |
| 属性、事件访问器行 | `TreeNodes/PropertyAccessorNode.cs` 等 | `AnalyzerEntityChildren.cs` | ✅ | |
| 类型的 6 个搜索类别 | `TreeNodes/TypeNode.cs` 等 | `Searches/TypeSearches.cs` | ✅ | |
| 方法的 5 个搜索类别 | `TreeNodes/MethodNode.cs` 等 | `Searches/MethodSearches.cs` | ✅ | |
| 字段：读取于 / 赋值于 | `TreeNodes/FieldNode.cs` | `Searches/FieldAccessSearch.cs` | ✅ | |
| 属性：重写 / 重写于 / 实现于 | `TreeNodes/Property*Node.cs` | `Searches/PropertySearches.cs` | ✅ | |
| 事件：被触发于 / 重写 / 重写于 / 实现于 | `TreeNodes/Event*Node.cs` | `Searches/EventSearches.cs` | ✅ | |
| 扫描范围（可见性、友元、IgnoresAccessChecksTo） | `TreeNodes/ScopedWhereUsedAnalyzer.cs` | `BE/Analyzer/ScopedWhereUsedAnalyzer.cs` | ✅ | |
| lambda / 迭代器回溯到所在方法 | `TreeNodes/Helpers.cs` | `AnalyzerHelpers.cs` | ✅ | 与 WPF 一样只在 C# 反编译器且开着「反编译匿名方法」时回溯，其他语言列出编译器生成的方法本身并带方法内位置 |
| COM/NoPIA 类型等价、vtable 槽匹配 | `TreeNodes/TIAHelper.cs`、`ComUtils.cs` | 无 | ⛔ | 用户明确决定不做 |
| 异步搜索：展开才搜、边搜边出、收起取消 | `TreeNodes/AsyncFetchChildrenHelper.cs` | RPC `analyze/children` + `analyze/progress` | ✅ | |
| 结果规模与并行 | `TreeNodes/SearchNode.cs` | `WorkspaceManager.Analyzer.cs` | ✅ | 与 WPF 一样不设上限（25 个框架程序集上 `Object` 的「被使用」约 28,500 行、6 秒、分 35 批流入，前端每次重排约 40ms）；扫描按 40ms 切片单线程跑，多线程实测无收益（见交接文档「坑」第 4 条），结果与顺序同 WPF |
| 激活行 | `AnalyzerService.OnActivated` | `AnalyzerPane.tsx` | ✅ | |
| 显示方法内的引用 | `AnalyzerService.GoTo` | `findReferenceCaret` | ✅ | C# 定位到语句里对目标的引用；IL 定位到那条指令的操作数（IL 视图现有操作数引用 span）；VB 视图本身没有语句表（见第 2 节第 3 条），只打开方法 |
| 右键：跳转组、复制（多选按层级缩进）、复制 token / 全名 | `Analyzer/Commands.cs` | `AnalyzerContextMenu.tsx` | ✅ | 按 3 项统计 |
| 右键：断点、分析、MSDN、移除 | 同上 | 同上 | ✅ | 按 2 项统计 |
| 选项组与持久化 | `AnalyzerSettings.cs` | `app-options.ts` | ✅ | |
| 从程序集树分析 | `TreeNodes/Commands.cs` | `AssemblyExplorerContextMenu.tsx`、`resolveAnalyzeTargets` | ✅ | 右键菜单分析整个选区里能解析的成员（按选中顺序各加一个根）；基类型行在引用能解析时可分析；Ctrl+Shift+R 只取第一个选中项，取不到时显示分析器窗口，同 WPF |
| 从代码编辑器、搜索窗口、分析器分析 | 同上 | `CodeEditorContextMenu.tsx` 等 | ✅ | 按 3 项统计 |
| 没有目标时 Ctrl+Shift+R 显示窗口 | 同上 | `FE/App.tsx` | ✅ | |
| 多选与键盘导航 | WPF TreeView | `AnalyzerPane.tsx` | ✅ | 按视口渲染 |
| 模型变化后失效与重建 | `AnalyzerService.cs` | `analyzer-store.ts`、后端 `analyzerEpoch` | ✅ | |
| 语言切换时重写行文本 | `AnalyzerService.DecompilerChanged` | `analyzer-store.ts` 的 `relabel` | ✅ | 工具栏语言改为全局后，切换时所有成员行按新语言重写（同一成员只问一次后端），搜索结果保留；语言切换前已发出的搜索晚到的结果也会重写 |

另外，分析器窗口里 Ctrl+Shift+R 与 WPF 一样只分析第一个选中行（原先分析整个选区）。

与 WPF 仍有的、不计入差距的不同：「被应用于」的程序集行跨模块去重（WPF 多模块程序集每个模块各出一行，属 WPF 的 quirk）；类型解析比 WPF 宽松（没有共享 resolver，按全名兜底）；引用到未加载程序集的类型按普通类型着色（着色不触发加载）；VB 的 `dynamic` 写成 `Object`（WPF 的转换器写成 `unknown`）。尚未做过与 WPF 对同一程序集的逐类别结果对照（需要 Windows 环境）。

测试：后端 `WorkspaceAnalyzerTests.cs` 30 条（新增按语言书写行文本、按语言决定 lambda 回溯、IL 指令操作数的引用 span 三条，以及无上限断言）、`WorkspaceAnalyzerScopeTests.cs` 3 条、`BookmarkTests` 里 IL 引用 span 的断言；前端 `analyzer-model.test.ts`（IL 定位）、`analyzer-store.test.ts`（语言、重写、晚到结果、匿名方法设置）、`AnalyzerPane.test.tsx`（Ctrl+Shift+R 取第一个）、`AnalyzerContextMenu.test.tsx`、`AssemblyExplorerContextMenu.test.tsx`（多选与基类型）、`app-store.test.ts`（全局语言切换）；e2e 约 8 条，新增「writes the analyzer in the language the toolbar picks…」覆盖 C#→VB→IL 重写、IL 里落到操作数、树多选分析。2026-10-16 本机真实构建后：后端 406、前端单测 1103、e2e 92 通过 3 跳过，全绿。

### 4.11 字符串引用窗口

完成度约 95%（✅ 20 / 🟡 2）。WPF 范围：`Extensions/dnSpy.StringSearcher/`。2026-10-16 按实现与测试复核：此前标的 100% 那一版后端编译不过（`WorkspaceManager.StringReferences.cs` 十几处错误）、前端引用了未安装的 `react-i18next`、树右键入口恒不可见，已整体重写。

跨平台实现：`BE/WorkspaceManager.StringReferences.cs`（扫描、来源格式化、跟随目标、`StringLiteralFormatter` 即 WPF 的 `StringFormatter`），RPC `stringReferences/search` 与进度通知 `stringReferences/progress`；`FE/string-references-store.ts`（扫描、刷新、跟随工作区）、`FE/string-references-model.ts`（过滤与 WPF 各比较器）、`FE/components/StringReferencesPane.tsx`、`StringReferencesContextMenu.tsx`。

| 功能点 | WPF 来源 | 状态 | 备注 |
|---|---|---|---|
| 树右键与编辑菜单入口 | `Commands.cs` | ✅ | 选中项里有 .NET 模块中的行时出现（`GetModule()`），打开窗口、焦点进搜索框、扫描 |
| 工具窗口 | `StringReferencesToolWindowContent.cs` | ✅ | 停靠在工具窗口区；关掉后由命令重新打开 |
| 扫描所选节点所在程序集的全部模块 | `StringReferencesService.Analyze` | ✅ | 含 netmodule；记住扫过的模块供刷新 |
| 未扫描时，在搜索框输入或改选项即扫描树的选中项 | `StartSearchIfNotStarted` | ✅ | |
| IL ldstr（每条一行，带 IL 偏移） | `ILStringReference.cs` | ✅ | 空字符串不列 |
| 常量（字段、属性、参数默认值） | `ConstantStringReference.cs` | ✅ | |
| 自定义特性参数 | `CustomAttributeStringReference.cs` | ✅ | 构造参数（Argument #n）、命名参数、数组逐项；模块、程序集、类型、方法、字段、属性、事件、参数（含返回值）、泛型参数上的特性。字段等成员的特性按 WPF 归在类型名下，跟随仍到成员本身 |
| 按当前反编译器隐藏编译器生成成员 | `Decompiler.ShowMember` | ✅ | C#/VB 隐藏 lambda、状态机等，IL 全部列出；切换语言自动重扫 |
| 子串过滤 | `ApplyFilter` | ✅ | 绑定延迟 100 ms，与 WPF 相同 |
| 区分大小写 | `SearchCaseSensitive` | ✅ | |
| 正则表达式 | `SearchIsRegex` | ✅ | 非法模式时保留原过滤、搜索框标红并在提示里写原因。用的是 JavaScript 正则，个别 .NET 专有语法不同 |
| 按格式化后的字符串匹配 | `SearchMatchFormattedString` | ✅ | |
| 四列（种类、文本、来源、模块） | `StringsControl.xaml` | ✅ | WPF 的列序与列宽；字面量按普通/逐字字符串着色，来源带容器图标与语法着色，「parameter」「attribute」「generic」等用 dnSpy 的灰色并随界面语言翻译 |
| 来源列随当前语言格式化 | `Decompiler.Write(...)` | 🟡 | 一律按 C# 格式化器（WPF `StringReference.DefaultFormatterOptions` 的选项）书写；WPF 选 VB 或 IL 时按该语言书写 |
| 列头排序 | `StringsControlVM.UpdateSortDescriptions` | ✅ | 升序 → 降序 → 还原；无排序时按种类、令牌、IL 偏移；文本与来源列忽略大小写，模块列只在 IL 行之间比模块（照 WPF 的 `ModuleComparer` 写法） |
| 列拖动重排与调整列宽 | `GridView AllowsColumnReorder` | ✅ | |
| 跟随（双击、Enter，Ctrl/Shift 新标签） | `FollowReference` | 🟡 | ldstr 在 C# 视图里定位到所在语句；IL/VB 视图没有语句表（见第 2 节第 3 条），只打开方法 |
| 右键菜单 | `Commands.cs` | ✅ | 复制字符串文本（格式化，Ctrl+C）/（原始）；转到代码中的引用 / 在新标签页中转到 |
| Ctrl+C 复制格式化文本 | `StringSearcherCommandLoader` | ✅ | |
| 刷新按钮 | `RefreshCommand` | ✅ | 有已扫描模块时重扫，否则扫描树的选中项 |
| 自动刷新 | `DocumentModified`、`CollectionChanged`、`DecompilerChanged` | ✅ | 编辑、撤销/重做、重载、增删程序集、切换语言时重扫；移除的模块自动剔除；关闭工作区清空 |
| 设置持久化（3 项） | `StringReferencesSettingsImpl` | ✅ | 存在应用选项里 |

扫描在工作区锁内按类型分片进行，结果分批推送到列表（对应 WPF 边扫边加），新扫描会取消正在进行的那次。

测试：后端 `WorkspaceStringReferencesTests.cs` 13 条（夹具 `backend/tests/StringTarget`：三类来源与来源文字、字面量格式化规则、编译器生成成员、跟随目标、整程序集扫描、按模块刷新、分批结果与一次扫描一致）；前端 `string-references-model.test.ts`（排序与过滤）、`string-references-store.test.ts`（扫描、批次、取消、刷新、跟随工作区）、`StringReferencesPane.test.tsx`（列、过滤延迟、非法正则、排序、列重排、跟随与复制、右键菜单、焦点）、`AssemblyExplorerContextMenu.test.tsx` 与 `MenuBar.test.tsx` 的入口；e2e「the String References window」。

### 4.12 程序集编辑（AsmEditor）与保存

整体完成度约 82%（✅ 52 / 🟡 11 / ❌ 7 / ⛔ 2）。WPF 范围：`Extensions/dnSpy.AsmEditor/` 全部子目录。

2026-10-18 按 WPF 补齐后按实现与测试复核（此前约 53%：✅ 31 / 🟡 11 / ❌ 27 / ⛔ 2）。这一轮补上的主体：

- **方法体编辑器**（`FE/components/MethodBodyDialog.tsx`、`BE/WorkspaceManager.MethodBody.cs`）：三页签、局部变量、异常处理器、指令表与指令宏全部接通，走 `edit/getIlBody`、`edit/replaceIlBody`、`edit/transformIlBody`；CIL 头的 `KeepOldMaxStack` 现在真正交给 writer（缺陷 #4 已修）。
- **资源编辑**（`FE/components/ResourceDialogs.tsx`、`BE/WorkspaceManager.ResourceEditing.cs`）：Edit Resource、Edit Resource Element、Create File / Multi File / Assembly Linked / File Linked、向 `.resources` 新增与删除元素；`.resources` 由 `System.Resources.Extensions.PreserializedResourceWriter` 重写，用户类型的序列化字节原样保留。
- **Edit Assembly / Edit Module**（`FE/components/AssemblyModuleDialogs.tsx`、`BE/WorkspaceManager.AssemblyModule.cs`）：程序集页签（Main / 特性 / 安全声明）与模块的五页（Main / Metadata / Cor20 / PE / 特性）。
- **保存选项**（`FE/components/SaveModuleOptionsDialog.tsx`、`BE/WorkspaceManager.SaveOptions.cs`）：保留 RID / #US / #Strings / #Blob 偏移、校验和、MVID 节、共享方法体、Win32 资源、模块类型、PDB 与混合模式（`NativeModuleWriterOptions`）。多模块保存目标错误（缺陷 #1）一并修好。
- **C# 源码编辑**（`FE/components/EditCodeDialog.tsx`、`BE/WorkspaceManager.Compiler.cs`、`BE/Editing/Compiler/`）：Edit Method (C#)、Edit Class (C#)、Add Class Members、Add Class、Edit Assembly Attributes 与 Merge with Assembly。Roslyn 编译后交给移植过来的 dnSpy `ModuleImporter`，可新增成员、类型与编译器生成的状态机；每次导入在事务里保存快照，撤销恢复成员列表、方法体与各定义选项。窗口只有一份 `main.cs`，没有 WPF 的引用列表与生成的隐藏代码页；引用由后端取目标模块、它的 AssemblyRef 与当前运行时的参考包，Windows 专属的 .NET Framework 引用在 Linux 上解析不到时编译会失败。

| 子模块 | 完成度 | ✅ | 🟡 | ❌ | ⛔ |
|---|---|---|---|---|---|
| Assembly | ~50% | 2 | 0 | 2 | 1 |
| Module | ~100% | 3 | 0 | 0 | 0 |
| Namespace | ~100% | 3 | 0 | 0 | 0 |
| Types / Method / Field / Property / Event | ~100% | 5 | 0 | 0 | 0 |
| MethodBody | ~89% | 7 | 2 | 0 | 0 |
| Compiler（C# 编辑） | ~83% | 5 | 0 | 1 | 0 |
| Resources | ~86% | 5 | 2 | 0 | 0 |
| Hex（修改能力） | ~63% | 5 | 0 | 3 | 0 |
| SaveModule | ~83% | 4 | 2 | 0 | 0 |
| UndoRedo | ~83% | 4 | 2 | 0 | 0 |
| 通用对话框（DnlibDialogs、ViewHelpers） | ~86% | 5 | 2 | 0 | 0 |
| Commands（菜单落位与杂项命令） | ~75% | 4 | 1 | 1 | 1 |

#### Assembly、Module、Namespace

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| Edit Assembly… | `AE/Assembly/AssemblyCommands.cs`、`AssemblyOptionsVM.cs` | `AssemblyOptionsDialog.tsx`，RPC `assembly/getOptions`、`assembly/setOptions` | ✅ | 名称、区域、公钥（可从文件读）、哈希算法、处理器架构、内容类型、四段版本、五个标志位、自定义特性与安全声明；改名后行标签随之刷新 |
| Create Assembly… | 同上 | 灰显 | ❌ | 工作区没有内存模块；新建程序集要先落盘才能进入树 |
| Remove Assembly | 同上 | RPC `workspace/removeModules` | ✅ | 作用于选中的全部根行；撤销历史涉及的文档，移除记为可撤销的一步，见 4.3 |
| Disable Memory Mapped I/O | 同上 | 隐藏 | ⛔ | 后端没有内存映射 |
| Edit Module… | `AE/Module/ModuleCommands.cs`、`ModuleOptionsVM.cs` | `ModuleOptionsDialog.tsx`，RPC `module/getOptions`、`module/setOptions` | ✅ | Main / Metadata / Cor20 / PE / 自定义特性五页；模块名、MVID、入口点、版本串、标头版本、Cor20 标志与运行时版本、Machine、Characteristics 与 DllCharacteristics |
| NetModule 新建、添加、移除 | 同上、`NetModuleOptionsVM.cs` | 隐藏 | ❌ | 树分不清 netmodule 与程序集模块，且没有把另一个模块挂进程序集的模型 |
| 程序集转 NetModule | 同上 | RPC `edit/convertModule` | ✅ | 可撤销 |
| NetModule 转程序集 | 同上 | 同一 RPC；菜单按父行判断方向 | ✅ | 没有程序集根（模块自成一棵树）时显示「Convert NetModule to Assembly」 |
| Delete Namespace | `AE/Namespace/NamespaceCommands.cs` | RPC `edit/delete` | ✅ | |
| Rename Namespace | 同上 | `EditDialogs.tsx`，RPC `edit/setNamespace` | ✅ | 还会改写其他模块里的 TypeRef |
| Move Types to Empty Namespace | 同上 | 同上 | ✅ | |

#### 类型与成员

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| Edit Type…（6 个页签） | `AE/Types/TypeOptionsDlg.xaml` | `TypeOptionsDialog.tsx`，RPC `edit/getOptions`、`edit/setOptions`；`BE/Editing/TypeDefEditor.cs` | ✅ | |
| Edit Method…（8 个页签） | `AE/Method/MethodOptionsDlg.xaml` | `MethodOptionsDialog.tsx`、`BE/Editing/MethodDefEditor.cs` | ✅ | |
| Edit Field / Property / Event… | `AE/{Field,Property,Event}/*OptionsDlg.xaml` | `FieldOptionsDialog.tsx` 等 | ✅ | |
| 新建类型、嵌套类型、方法、字段、属性、事件 | `*DefCommands.cs` | RPC `edit/create` | ✅ | 撤销后重做回到同一个 token |
| 删除类型与成员 | `*DefCommands.cs`、`AE/Commands/Deleted*Updater.cs` | RPC `edit/delete` | ✅ | 删除属性/事件会连带删除访问器 |

另新增了 WPF 没有的简易重命名框（RPC `edit/rename`）。

#### 方法体（MethodBody）

「Edit Method Body…」打开 `MethodBodyDialog.tsx`，三页签与 WPF 的 `MethodBodyDlg` 对应；读取与写回走 `edit/getIlBody`、`edit/replaceIlBody`，指令命令走 `edit/transformIlBody`。

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| 方法体类型（None/CIL/Native）、给无体方法加 body | `AE/MethodBody/MethodBodyVM.cs` | 下拉框切换；无体方法可以从 CIL 开始编辑 | ✅ | `CodeType` 与 body 类型都写回 `MethodImplAttributes` |
| CIL 头选项 | `CilBodyVM.cs` | MaxStack、InitLocals、KeepOldMaxStack、LocalVarSigTok（只读）、Header RVA/Offset | ✅ | `KeepOldMaxStack` 原样传给 dnlib；不勾选时由 dnlib 重算栈深 |
| 指令表编辑 | `InstructionsListHelper.cs` | 可编辑的标签/操作码/操作数网格；追加、在选区前后插入、删除、多选与上下移动 | 🟡 | 没有 WPF 列表的 Cut/Copy/Paste 剪贴板 |
| 操作数编辑 | `InstructionOperandVM.cs`、`SwitchOperandDlg` | 数字/字符串/分支/switch 文本、局部变量与参数下拉、成员/类型选择器（可新建 MemberRef） | 🟡 | `MethodSpec` 的泛型实参与 `calli` 的调用签名能原样往返，但无法在界面上新建 |
| 局部变量页 | `LocalVM.cs` | 增删、名称、Pinned、编译器生成、类型编辑器 | ✅ | 类型用 `TypeSigEditor`，与局部变量类型创建对话框一致 |
| 异常处理器页 | `ExceptionHandlerVM.cs` | 增删、四个处理器类型、五个位置、捕获类型 | ✅ | 编辑带 try/catch 的方法不再丢 EH |
| 指令宏（Simplify/Optimize、NOP、反转分支等） | `InstructionsListHelper.cs` | 后端 `edit/transformIlBody` 的七个命令 | ✅ | 栈指令（Convert to Unconditional Branch、Remove and Add Pops）按操作数签名计算栈效应 |
| Edit IL Instructions（按选中语句） | `MethodBodyCommands.cs` | 代码视图右键「Edit IL Instructions…」 | ✅ | 以语句的 IL 范围预选指令 |
| Replace Method Body with stub | `MethodBodyCommands.cs` | RPC `edit/replaceMethodBodyWithStub`、`BE/MethodBodyStub.cs` | ✅ | |

#### Compiler（Roslyn 源码编辑）

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| Edit Method (C#) | `AE/Compiler/EditMethodCodeVM.cs` | `EditCodeDialog.tsx`，RPC `compiler/compile`；`BE/WorkspaceManager.Compiler.cs`、`BE/Editing/Compiler/ModuleImporter.cs` | ✅ | 反编译外层类型、编辑后编译并只导入该方法；源可用新局部变量、新增成员引用 |
| Edit Class (C#) | `AE/Compiler/EditClassVM.cs` | 同上，模式 `editClass` | ✅ | 整个类型合并，可增删成员 |
| Add Class Members (C#) | `AE/Compiler/AddClassMembersCommands.cs` | 同上，模式 `addMembers` | ✅ | 只加入源里新出现的成员，不改已有成员 |
| Add Class (C#) | `AE/Compiler/AddClassCommands.cs` | 同上，模式 `addClass` | ✅ | 从空类模板开始；新类型加入模块 |
| Edit Assembly Attributes (C#) | `AE/Compiler/EditAssemblyVM.cs` | 同上，模式 `editAssembly` | ✅ | 程序集与模块特性、安全声明、版本写回 |
| Merge with Assembly | `AE/Compiler/MergeWithAssemblyCommand.cs` | 主进程选文件，RPC `compiler/merge` | ✅ | 与 WPF 一样不合并依赖程序集 |
| 编译器选项页（Compiler settings） | `AE/Compiler/CompilerAppSettingsPageContainer.cs` | 无 | ❌ | 忽略访问修饰、引用列表、生成代码页等选项没有 UI；命令本身按默认选项运行 |

#### 资源、Hex 修改、保存、撤销

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| Delete Resource | `AE/Resources/ResourceCommands.cs` | RPC `edit/delete` | ✅ | |
| Delete Resource Element | 同上 | 同一 RPC，重写 `.resources` 后删去条目 | ✅ | 撤销恢复整份文件 |
| Edit Resource（名称、可见性、链接属性） | `ResourceVM.cs` | `ResourceOptionsDialog.tsx`，RPC `resource/getOptions`、`resource/setOptions` | ✅ | 名称、Public/Private、程序集链接、文件链接（名称/哈希/无元数据）、自定义特性 |
| Edit Resource Element（字符串、图片、序列化对象等） | `ResourceElementVM.cs` 等 | `ResourceElementDialog.tsx`，RPC `resource/getElementOptions`、`resource/setElementOptions` | 🟡 | 内置类型、字节与流的值可编辑，用户类型的序列化字节可替换；WPF 的图片/ImageListStreamer 专用对话框没有移植 |
| Create File / Multi File Resource | `ResourceCommands.cs` | `CreateResourceDialog.tsx`，RPC `resource/create` | ✅ | 多文件资源写成一个 `.resources`，每个文件一个 `byte[]` |
| Create Assembly / File Linked Resource | 同上 | 同上 | ✅ | 程序集名或文件名可直接输入 |
| 新建资源元素 | 同上 | `CreateResourceElementDialog.tsx`，RPC `resource/createElement` | 🟡 | 字符串、布尔/数值、字节数组、流、null 可建；WPF 的图片与 ImageListStreamer 元素新建没有移植 |
| Hex Write return true/false/空方法体 | `AE/Hex/Commands.cs` | `hex-menu.ts` → RPC `edit/hexPatch` | ✅ | |
| Hex Copy / Paste Method Body | 同上 | 剪贴板传十六进制文本 | ✅ | |
| Hex 修改接入撤销与保存 | `AE/Hex/HexBufferUndoRedo.cs` | 补丁作为事务操作，保存时重定位 | ✅ | 见缺陷 #7 |
| Hex 视图里直接改写、粘贴、填充 | `WPF/Hex/ContextMenuCommands/Commands.cs` | `HexView` → `hexWriteBytes`、`edit/hexPatch` | ✅ | 键入、粘贴（含粘贴特殊）、填充与清零，每次一个事务；PE-only/ELF 文件只读 |
| Go to Offset / Metadata / 选择 | 同上 | `HexGoToPositionDialog`、`HexGoToMetadataDialog`、`HexSelectDialog` | ✅ | 见 4.7 |
| 单独保存 Hex 文档、改非 .NET 文件 | `AE/Hex/HexTabSaver.cs` | 后端拒绝 PE-only 文件 | ❌ | |
| 编辑 PE 头与元数据表字段 | `AE/Hex/Nodes/*`、`AE/Hex/PE/*VM.cs` | 无 | ❌ | |
| MD 表命令与 Go to MD Table Row | `AE/Hex/MDTableContextMenuCommands.cs` | 灰显 | ❌ | |
| Save Module… | `AE/SaveModule/SaveModuleCommand.cs` | `SaveModuleOptionsDialog.tsx` + 原生另存为，RPC `module/saveAsWithOptions` | ✅ | 写出选项见下；保存的是选中行所属的模块（缺陷 #1 已修） |
| Save All | 同上、`SaveMultiModuleVM.cs` | RPC `module/saveAllWithOptions` | 🟡 | 使用当前写出选项；仍不列出模块、无进度、不能取消 |
| 原地覆盖原文件 | `AE/SaveModule/DocumentSaver.cs` | RPC `module/saveWithOptions` | ✅ | 写临时文件、重新加载校验后原子替换 |
| Mixed-mode 保存 | `SaveModuleOptionsVM.cs` | `NativeModuleWriterOptions` | ✅ | 勾选「Use the native writer」后按原 PE 布局写出并保留额外 PE 数据 |
| 写 PDB | 同上 | `ModuleWriterOptions.WritePdb`（portable PDB） | ✅ | 仅当模块读到了 `PdbState` 时可用；PDB 写在目标文件旁 |
| 写出选项（保留 RID/堆、校验和、Win32 资源等） | 同上 | `SaveModuleOptionsDto` | 🟡 | 保留 RID/#US/#Strings/#Blob 偏移、校验和、MVID 节、共享方法体、Win32 资源、模块类型；WPF 的 PE 头/元数据堆大小/Cor20 覆盖页没有移植 |
| Undo / Redo | `AE/UndoRedo/*` | RPC `edit/undo`、`edit/redo` | ✅ | 编译器导入也在事务里保存快照，撤销恢复成员与类型 |
| 编辑命令统一进撤销栈并刷新界面 | `UndoCommandService.cs` | `refreshAfterEdit` | ✅ | 后端有版本冲突检测 |
| 修改标记 | 同上 | 前端只有一个工作区级 `dirty` | 🟡 | 见缺陷 #3；撤销回保存点后不复位 |
| 退出时询问保存 | `AE/UndoRedo/Commands.cs` | `beforeunload` | 🟡 | 没有「保存后退出」 |
| 重新加载前提示 | `UndoRedoDocumentListListener.cs` | `FE/App.tsx` 的 `reloadAll` | ✅ | dnSpy 原话：「有 N 个尚未被保存的文件。是否要重新载入所有程序集并放弃所有修改？」 |
| 移除已修改的程序集时询问 | `AE/Assembly/AssemblyCommands.cs`、`AE/SaveModule/DocumentSaver.cs` | `FE/App.tsx` 的 `removeDocuments`，`app:askSaveModified` | ✅ | 「是否要在继续之前保存？」是 / 否 / 取消；选「是」原地保存，保存失败则不移除 |

#### 通用对话框与命令

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| 签名构造器（TypeSig、MethodSig、属性签名） | `AE/DnlibDialogs/TypeSigCreatorVM.cs` 等 | `widgets/TypeSigEditor.tsx` 等、`BE/Editing/SignatureCodec.cs` | ✅ | |
| 成员选择器 | `MemberPickerVM.cs`、`ViewHelpers/DnlibTypePicker.cs` | `TypePickerDialog.tsx` | 🟡 | 没有搜索框 |
| 自定义特性、命名参数、常量 | `CustomAttributeVM.cs`、`ConstantVM.cs` | `widgets/CustomAttributeDialog.tsx` 等 | ✅ | |
| 泛型参数、DeclSecurity、TypeDefOrRefAndCA | `GenericParamVM.cs`、`DeclSecurityVM.cs` | 对应的 Dialog 与 Codec | ✅ | |
| ParamDef、P/Invoke、Marshal、MethodOverride | `ParamDefVM.cs`、`ImplMapVM.cs`、`MarshalTypeVM.cs` | 对应的 Dialog 与 Editor | ✅ | |
| 手工构造 MemberRef / MethodSpec | `MemberRefVM.cs`、`MethodSpecVM.cs` | 指令操作数可经选择器构造 MemberRef | 🟡 | `MethodSpec` 的泛型实参没有编辑界面 |
| 列表编辑控件 | `ListVM.cs` | `ListEditor.tsx` | ✅ | |
| 命令在三处菜单里的落位 | `AE/Commands/*MenuHandler.cs` | `edit-menu.ts`、两个右键菜单 | ✅ | |
| 多选批量操作 | `AE/Commands/DeletableNodes.cs` | 树支持多选 | 🟡 | Remove Assembly 作用于整个选区；删除类型/成员仍只删一个 |
| Copy MD Token / Full Name | `WPF/Documents/Tabs/CopyTokenCommand.cs` | 树和代码视图菜单 | ✅ | |
| Copy IL Bytes | `AE/Commands/InstructionCommands.cs` | 无 | ❌ | |
| Load Dependencies | `AE/Compiler/LoadDependenciesCommands.cs` | RPC `workspace/loadDependencies` | ✅ | 与 4.3 重复计入 |
| Close All Framework Assemblies / Missing Files | `AE/Commands/CloseAll*Command.cs` | File 菜单 | ✅ | 与 4.3 重复计入 |
| Close Old In-Memory Modules | `AE/Commands/CloseOldInMemoryModulesCommand.cs` | 灰显 | ⛔ | 不建模内存模块 |

测试：后端 `WorkspaceEditCreateTests.cs`、`WorkspaceEditOptionsTests.cs`、`Editing/NodeOptionsRoundTripTests.cs`、`Editing/SignatureRoundTripTests.cs`、`WorkspaceIlBodyTests.cs`（方法体三页与七个指令命令）、`WorkspaceResourceEditingTests.cs`（资源新建/改名/元素增删改）、`WorkspaceAssemblyModuleOptionsTests.cs`、`WorkspaceSaveOptionsTests.cs`（保留 RID 与压缩的 token 对比、原地保存）、`WorkspaceCompilerTests.cs`（改方法体、增成员、编译错误与撤销），以及 `WorkspaceManagerTests.cs` 中的方法体、资源、hex、保存用例；前端 `*OptionsDialog.test.tsx`、`MethodBodyDialog.test.tsx`、`il-body-model.test.ts`、`ResourceDialogs.test.tsx`、`AssemblyModuleDialogs.test.tsx`、`SaveModuleOptionsDialog.test.tsx`、`EditCodeDialog.test.tsx` 与 `widgets/*.test.ts(x)` 约 480 条；e2e 覆盖新建类型并保存、IL 与元数据编辑、hex 写入并撤销、模块转换。

### 4.13 调试器

整体完成度约 83%（✅ 63 / 🟡 16 / ❌ 7 / ⛔ 4）。WPF 范围：`Extensions/dnSpy.Debugger/` 全部子项目、`dnSpy/Roslyn/Roslyn.ExpressionCompiler`。

2026-10-17 按 WPF 补齐后按实现与测试复核（此前约 47%：✅ 30 / 🟡 21 / ❌ 35 / ⛔ 4）。跨平台版只有一个引擎：后端进程内直连 ICorDebug（`CDS/`），只支持 CoreCLR。没有 PDB 时，断点、单步落点和局部变量名都来自反编译语句到 IL 偏移的映射（`BE/StatementIlRanges.cs`）。

这一轮补上的主体是表达式求值器（`CDS/Evaluation/`）：用 Roslyn 按被调试进程已加载的模块建 C#/VB 编译（`MetadataImportOptions.All`，C# 打开 `IgnoreAccessibility` 读私有成员），把表达式编译进一个以局部变量和 `this` 为参数的合成方法，再解释它的 IOperation 树；字段、数组、算术、转换、模式匹配等在调试器侧直接算，属性、方法调用、`new`、装箱与字符串用 func-eval（`ICorDebugEval`，冻结其他线程，超时后 Abort / RudeAbort）。值的格式化、DebuggerDisplay / DebuggerTypeProxy、Raw / Results / Dynamic View、格式说明符（`h`、`d`、`nq`、`raw`、`results`、`ac` 等）、`$exception`、`$ReturnValue`、`$N` 对象 ID 都按 WPF 的 `CSharpValueFormatter` 与值节点提供者实现，三列按 dnSpy 的颜色类型着色。断点条件与跟踪点的 `{表达式}` 也改走这个求值器。

| 子模块 | 完成度 | ✅ | 🟡 | ❌ | ⛔ |
|---|---|---|---|---|---|
| 变量与表达式求值 | ~96% | 11 | 1 | 0 | 0 |
| 异常设置 | ~90% | 9 | 0 | 1 | 1 |
| 调试器选项 | ~89% | 7 | 2 | 0 | 1 |
| 调试工具窗口 | ~83% | 6 | 3 | 0 | 0 |
| 单步与执行点 | ~80% | 7 | 2 | 1 | 0 |
| 断点 | ~79% | 10 | 7 | 0 | 0 |
| 会话控制 | ~75% | 10 | 1 | 3 | 1 |
| 运行时与代码映射 | ~60% | 3 | 0 | 2 | 1 |

剩下的 ❌ 都在 WPF 的边缘：Mono / Unity、多进程、Unwind To This Frame、编辑器的 Break When Exception Thrown、阻止托管代码检测调试器、动态模块。

#### 会话控制

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| Debug Program 对话框（.NET 页） | `DBG/dnSpy.Debugger/Dialogs/DebugProgram/*`、`dnSpy.Debugger.DotNet.CorDebug/Dialogs/DebugProgram/DotNetStartDebuggingOptionsPage.cs` | `DebugProgramDialog.tsx`，RPC `debug/launch` | ✅ | 支持宿主可执行文件；缺 ConnectionTimeout |
| Break at（4 种） | `DotNetCommonStartDebuggingOptionsPage.cs` | `CDS/CorDebugSession.Entry.cs` | ✅ | `ModuleCctorOrEntryPoint` 的帧按 WPF 写成 `<Module>.<Module>()` |
| .NET Framework 启动页 | `DotNetFrameworkStartDebuggingOptionsPage.cs` | 无 | ⛔ | Linux 上没有 .NET Framework |
| Mono / Unity 启动与 connect | `dnSpy.Debugger.DotNet.Mono/Dialogs/DebugProgram/*` | 无 | ❌ | 计划列为后续方向 |
| 启动选项 MRU | `DbgUI/StartDebuggingOptionsMru.cs` | `DebugProgramDialog.tsx`（`dnspy.debugProgramMru.v1`） | ✅ | 按程序路径记住参数、目录、环境、宿主与 Break at，最多 20 个 |
| Start Without Debugging | `DbgUI/DebugMenuCommands.cs` | 同一对话框，主进程 `debug:startWithoutDebugging` | ✅ | Ctrl+F5；与引擎一样对 `.dll` 走 dotnet 宿主 |
| Attach to Process | `Dialogs/AttachToProcess/*` | `AttachDialog.tsx`，RPC `debug/listProcesses`、`debug/attach` | 🟡 | 只列已加载 CoreCLR 的进程（读 `/proc/<pid>/maps`）；没有 Title、Type、命令行列 |
| Unity 附加 | `dnSpy.Debugger.DotNet.Mono/Dialogs/AttachToProcess/Unity*` | 无 | ❌ | |
| Continue | `DebugMenuCommands.cs` | `continueDebug` | ✅ | |
| Break All | 同上 | `pauseDebug` | ✅ | Ctrl+Alt+Break，运行时可用 |
| Stop Debugging | 同上 | `stopDebug` | ✅ | 启动的进程终止，附加的进程分离（缺陷 #2 已修） |
| Detach All / Terminate All | 同上 | `detachDebug`、`terminateDebug` | ✅ | Debug 菜单与 Processes 窗口 |
| Restart | 同上 | `restartDebug` | ✅ | Ctrl+Shift+F5，按上次的参数重启；附加的进程不可用 |
| 多进程调试 | 同上 | 只有一个会话 | ❌ | |
| 调试状态提示 | `DbgUI/DebuggerImpl.cs` | 状态栏 | ✅ | 中断时按选项把窗口带到前台 |

#### 单步与执行点

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| Step Into / Over / Out | `Steppers/DbgStepperImpl.cs` | `CDS/CorDebugSession.Stepping.cs` | ✅ | 按 3 项统计；在源级顺序点挂临时断点；Step Into 按选项跳过属性与运算符、Just My Code 之外的模块 |
| 跨 await 单步 | `dnSpy.Debugger.DotNet/Steppers` | 语句级断点 | 🟡 | continuation 不做判定，分支或异常路径上可能多停一次 |
| Show Next Statement | `DbgUI/DocumentViewerCommands.cs` | `revealStoppedLocation` | ✅ | Alt+Num *，Debug 菜单与编辑器右键 |
| Set Next Statement | 同上 | `setNextStatement`，`CDS/CorDebugSession.Control.cs`（`ICorDebugILFrame.SetIP`） | ✅ | Ctrl+Shift+F10；先 `CanSetIP` 检查，只能在当前方法内 |
| Run to Cursor | `ToolWindows/CallStack/CallStackOperations.cs`、`DocumentViewerCommands.cs` | `runToCursor` | ✅ | Ctrl+F10：编辑器里是光标处语句上的临时 IL 断点，Call Stack 里是该帧返回地址上的本机断点 |
| Unwind To This Frame | `ToolWindows/CallStack/Commands.cs` | 无 | ❌ | |
| 当前语句与调用栈帧高亮 | `CallStack/TextEditor/ActiveStatementService.cs` | `DocumentView.tsx` | 🟡 | 编辑器不区分当前语句与其他帧；总切到 C# 视图 |
| 停在工作区外的模块时自动加载 | `dnSpy.Debugger.DotNet/Modules/DbgLoadModuleReferenceHandlerImpl.cs` | `openDebugModule` | ✅ | 切换到的帧保持为活动帧 |

#### 断点

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| 行断点 | `Breakpoints/Code/TextEditor/GlyphMarginOperations.cs` | `toggleLineBreakpoint`、`CDS/CorDebugSession.Breakpoints.cs` | 🟡 | 只有 C# 视图能下断点 |
| 启用 / 禁用 | `DbgUI/DocumentViewerCommands.cs` | 右键、面板复选框 | ✅ | |
| 绑定状态 | `Breakpoints/Code/BoundCodeBreakpointsService.cs` | `breakpoint` 事件 | ✅ | 运行时拒绝偏移时退回顺序点 |
| 断点字形外观 | `BreakpointGlyphTextMarkerHandler.cs` | 三种样式 | 🟡 | 条件断点、跟踪点没有专用图标 |
| 边距右键与悬停工具条 | `GlyphMarginCommands.cs` | 编辑器右键 | 🟡 | 没有 Settings…、Export… |
| Add Method Breakpoint | `dnSpy.Debugger.DotNet/Breakpoints/Code/TextEditor/ClassBreakpointCommands.cs` | RPC `setFunctionBreakpoints` | 🟡 | 按名称匹配，重载只绑一个 |
| Add Class Breakpoint / Tracepoint | 同上 | `addClassBreakpoint` | 🟡 | 同上 |
| 条件 | `Breakpoints/Code/CondChecker/DbgCodeBreakpointConditionChecker.cs` | `BreakpointSettingsDialog.tsx`、`CDS/CorDebugSession.BreakpointChecks.cs` | ✅ | 完整的 C#/VB 表达式，可以访问成员、调用方法；求值时进程原地挂起，命中在调度线程外判定 |
| 命中计数 | `CondChecker/DbgCodeBreakpointHitCountChecker.cs` | `CDS/BreakpointBreakDecision.cs` | ✅ | |
| 筛选器 | `CondChecker/DbgCodeBreakpointFilterChecker.cs` | `CDS/CorDebugSession.BreakpointChecks.cs` | ✅ | |
| 跟踪点消息 | `CondChecker/TracepointMessageParser.cs` | `CDS/TracepointMessage.cs` | ✅ | `{表达式}` 走求值器 |
| 标签 | 设置对话框 | 设置对话框 | ✅ | |
| Enable / Disable / Delete All | `DebugMenuCommands.cs` | `MenuBar.tsx` | ✅ | |
| Breakpoints 窗口 | `ToolWindows/CodeBreakpoints/*` | `BreakpointsPane` | 🟡 | 有搜索、标签与模块列、双击转到源代码、右键菜单；不是可排序的多列表格 |
| 导入 / 导出 | `Breakpoints/Code/BreakpointsSerializer.cs` | 面板按钮 | 🟡 | JSON 格式，与 WPF 的 XML 不互通 |
| 持久化 | 同上 | `dnspy.breakpoints.v1` | ✅ | |
| 模块断点 | `Breakpoints/Modules/*` | `ModuleBreakpointsPane`，RPC `setModuleBreakpoints`，`CDS/CorDebugSession.ModuleBreakpoints.cs` | ✅ | 模块名、顺序、动态、内存、应用程序域、进程，名称支持通配符；持久化在 `dnspy.moduleBreakpoints.v1` |

另新增：Breakpoints 面板可按名称输入函数断点。

#### 异常设置

后端读取与 WPF 相同的 `DotNet.ex.xml`，客户端只持久化与默认值的差异，开会话时重放给引擎。

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| 异常列表 | `ToolWindows/Exceptions/*`、`Exceptions/DefaultExceptionDefinitionsProvider.cs` | `ExceptionSettingsPane.tsx`，RPC `exceptions/get`；`CDS/ExceptionSettingsService.cs` | ✅ | 工具栏代替右键菜单 |
| 勾选「抛出时中断」与批量开关 | 同上 | RPC `exceptions/apply` | ✅ | |
| 添加 / 删除异常 | 同上 | `addExceptionDefinition` 等 | ✅ | |
| 条件（模块名） | `Exceptions/ExceptionConditionsChecker.cs` | 条件对话框 | ✅ | |
| 搜索、类别筛选、只显示已启用 | `ToolWindows/Exceptions` | 有 | ✅ | |
| 恢复默认 | 同上 | RPC `exceptions/reset` | ✅ | |
| 设置持久化 | `Exceptions/ExceptionListSettings.cs` | `dnspy.exceptions.v1` | ✅ | |
| 首次机会 / 未处理异常中断 | CorDebug 异常回调 | `CDS/CorDebugSession.Exceptions.cs` | ✅ | 与 WPF 一样不理会 user-first-chance；遵守「忽略未处理异常」 |
| MDA 类别 | `DotNet.ex.xml` | 列出但不会触发 | ⛔ | MDA 只存在于 .NET Framework |
| 异常中断后的提示 | `DbgUI/DebuggerImpl.cs`、`ToolWindows/Logger/OutputLogger.cs` | Output、状态栏、Locals 的 `$exception` | ✅ | Output 按 OutputLogger 写「Exception thrown: 'X' in M」与 Additional information（读 `Exception._message`，不做 func-eval） |
| 右键 Break When Exception Thrown | `dnSpy.Debugger.DotNet/Exceptions/BreakWhenThrownExceptionCommand.cs` | 隐藏 | ❌ | |

#### 调试工具窗口

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| Call Stack | `ToolWindows/CallStack/*` | `DebugToolWindows.tsx` 的 `CallStackPane`；`CDS/CorDebugSession.Stack.cs` 的 `StackFrameFormatter` | ✅ | 帧名按 `CSharpStackFrameFormatter` 着色书写（模块、返回类型、参数类型/名/值、IL 与本机偏移、标记、属性访问器、状态机与局部函数还原）；右键的 Copy、Switch To Frame、Go To Code/Disassembly、Run To Cursor 与十个显示开关；本机到托管的过渡帧；深帧的行号在切换时再解析 |
| Threads | `ToolWindows/Threads/*` | `ThreadsPane`；`CDS/CorDebugSession.Threads.cs` | ✅ | ID、托管 ID、类别（Main/Finalizer/GC/ThreadPool/Worker）、名称、位置、优先级、关联掩码、挂起计数、进程、应用程序域、状态；冻结/解冻、重命名、切换。类别与优先级在 Linux 上取自 `/proc/<pid>/task` |
| Modules | `ToolWindows/Modules/*` | `ModulesPane` | ✅ | WPF 的全部列；Go To Module、Open Module from Memory、Load All Modules、Save Module |
| Processes | `ToolWindows/Processes/*` | `ProcessesPane` | ✅ | 只有一个会话，所以只有一行；Continue/Break/Detach/Terminate Process |
| Memory 1–4 | `ToolWindows/Memory/*` | `DebugNativeWindows.tsx` 的 `MemoryPane`，RPC `readMemory`、`writeMemory` | 🟡 | 地址或表达式定位、按页读、不可读的页显示 `??`、双击改字节；不是完整的 hex 编辑器（没有选区、复制、查找） |
| Disassembly | `Disassembly/*` | `DisassemblyPane`；`CDS/CorDebugSession.Native.cs`（Iced） | 🟡 | 按 Disassembler 选项与各方言 Code Style 输出，带 IL 与源码注释、标签、当前指令；是工具窗口而不是文档标签，不能在里面下断点。与 4.8 重复计入 |
| Output：程序 stdout/stderr | `ToolWindows/Logger/OutputLogger.cs` | `output` 事件 | ✅ | 附加的进程不能重定向 |
| Output：Debugger.Log | 同上 | `LogMessage` 回调 | ✅ | |
| Output：模块、线程、进程消息与过滤开关 | `ToolWindows/Logger/Commands.cs` | Loaded / Unloaded、线程与进程退出码、异常 | 🟡 | 措辞同 OutputLogger；没有各类消息的过滤开关 |

#### 变量与表达式求值

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| Locals | `ToolWindows/Locals/*` | `DebugVariablesWindows.tsx` 的 `LocalsPane`；`CDS/CorDebugSession.Variables.cs` | ✅ | 变量名来自反编译器，无需 PDB；`this`、参数、状态机与闭包里提升的局部变量、Type variables；按选项排序与分组 |
| Autos | `ToolWindows/Autos/*` | `AutosPane`，RPC `autos` | ✅ | 由 IL 找出前后语句读写的变量、字段与静态字段 |
| Watch 1–4 | `ToolWindows/Watch/*` | `WatchPane` | ✅ | 底部空行输入，名称列可编辑、Paste、Delete Watch、Clear All；Ctrl+Alt+W, 1–4 |
| Static Fields | `ToolWindows/StaticFields/*` | `StaticFieldsPane`，RPC `staticFields` | ✅ | |
| 表达式求值（C#/VB） | `dnSpy/Roslyn/Roslyn.ExpressionCompiler`、`Evaluation/*` | `CDS/Evaluation/ExpressionCompiler.cs`、`OperationInterpreter.cs` | ✅ | 语言随调试器选项的 Language；有副作用的表达式在 Locals/Autos 里不自动求值 |
| 编辑变量值 | Locals 的 EditValue | `setExpression` | ✅ | 双击或 F2，值是任意表达式 |
| 属性求值、ToString、函数调用 | `dnSpy.Debugger.DotNet.CorDebug/Impl/Evaluation` | `CDS/CorDebugSession.FuncEval.cs`、`Evaluation/EvalRuntime.cs` | ✅ | 1 秒超时后 Abort；遵守「属性求值与函数调用」「ToString」选项 |
| DebuggerDisplay / DebuggerTypeProxy | `dnSpy.Debugger.DotNet/Evaluation/Engine/*` | `Evaluation/ValueFormatter.cs`、`ValueNodes.cs` | ✅ | 还有 DebuggerBrowsable、元组、KeyValuePair、Nullable |
| Raw / Results / Dynamic View | `dnSpy/Roslyn/dnSpy.Roslyn/Debugger/ValueNodes/*` | `ValueNodes.cs` | ✅ | |
| 十六进制显示 | 各窗口命令 | 各窗口右键的 Hexadecimal Display、Digit Separators | ✅ | 默认十六进制，与 WPF 相同 |
| Make Object ID | `Evaluation/DbgObjectIdServiceImpl.cs` | `makeObjectId`、`deleteObjectId` | ✅ | 强句柄，`$N` 可在表达式里用 |
| 显示返回值 | ShowReturnValues 设置 | `CDS/CorDebugSession.ReturnValues.cs` | 🟡 | 单步越过的调用在 Locals 里显示「X returned」并可用 `$ReturnValue`（`GetReturnValueLiveOffset` + `GetReturnValueForILOffset`）；返回结构体的调用不保留 |

#### 调试器选项

选项经 RPC `debug/setOptions` 交给引擎，会话中途改也生效；停住时各窗口按新格式重读。

| 功能点 | 状态 | 备注 |
|---|---|---|
| 选项页界面与持久化 | ✅ | |
| 启动调试时显示 Locals | ✅ | |
| 抑制 JIT 优化 | ✅ | `ICorDebugModule2.JITCompilerFlags`；系统模块另设 `DOTNET_ReadyToRun=0` |
| Just My Code 与步进过滤 | ✅ | `SetJMCStatus`、步进器 JMC、只步入主模块、跳过属性与运算符 |
| 忽略 Debugger.Break() | ✅ | |
| 忽略未处理异常 | ✅ | |
| 变量窗口显示选项 | ✅ | 隐藏编译器生成成员、遵守隐藏特性、排序与分组、原始局部变量、返回值、高亮变化的值、语法高亮 |
| 焦点相关选项 | 🟡 | 中断时把窗口带到前台；「把焦点给被调试进程」在 Linux 上做不到 |
| 重定向 GUI 程序的控制台输出 | 🟡 | Linux 程序不分 GUI/控制台子系统，总是重定向 |
| 启用 MDA | ⛔ | 只存在于 .NET Framework |

#### 运行时、平台与代码映射

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| Windows 反反调试（IsDebuggerPresent 等） | `DBG/dnSpy.Debugger/AntiAntiDebug/*` | 选项在，无实现 | ⛔ | Windows API，计划明确不支持 |
| 阻止托管代码检测调试器 | `dnSpy.Debugger.DotNet.CorDebug/AntiAntiDebug/ManagedDebuggerHook.cs` | 选项在，无实现 | ❌ | 在 Linux CoreCLR 上同样有意义 |
| 从内存打开模块 | `Code/GoToInMemoryModuleStatement.cs` | `saveModule`（按节还原文件布局）后打开 | ✅ | Modules 窗口的 Open Module from Memory 与 Go To Module |
| 动态模块与 Reload All Method Bodies | `dnSpy.Debugger.DotNet/Metadata/Commands.cs` | 无 | ❌ | |
| 反编译源码上的断点、单步、定位 | `dnSpy.Debugger.DotNet/Code/DbgMethodDebugInfoProvider.cs` | `BE/StatementIlRanges.cs`、`IDebugSymbolResolver` | ✅ | 只有 C# |
| 无 PDB 时变量名取自反编译器 | `Evaluation/DbgLocalsValueNodeProviderImpl.cs` | `GetVariableNamesAsync` | ✅ | |

Linux 新增（不计入）：以 root 身份重启（pkexec）、随包提供 `libdbgshim.so` 并在缺失时按能力降级、按名称的函数断点。附加失败时没有 ptrace 权限诊断，只返回 HRESULT。

测试：后端 `DebugEvaluationTests.cs`（求值局部变量、成员与运算符，func-eval 调属性与方法，十六进制与格式说明符，对象展开与改值，错误作为值，Locals、Autos、对象 ID、`$exception`，内存与反汇编，线程，Run to Cursor，Set Next Statement，模块断点，返回值）、`DebugSessionManagerTests.cs`（启动、Break kind、附加与分离、进程列表、单步、异常中断）、`BreakpointExpressionTests.cs`、`BreakpointBreakDecisionTests.cs`、`TracepointMessageTests.cs`、`ExceptionSettingsTests.cs`；前端 `DebugVariablesWindows.test.tsx`（着色、展开、改值、变化高亮、Watch 输入）、`app-store.test.ts` 的 debugger commands（分离与终止、改值、Watch、Set Next Statement、Run to Cursor、模块断点、OutputLogger 消息）、`DebugProgramDialog.test.tsx`（含启动选项记忆）、`ExceptionSettingsPane.test.tsx`、`BreakpointsPane.test.tsx`、`CodeEditorContextMenu.test.tsx`、`MenuBar.test.tsx`；e2e 覆盖断点、单步、帧切换、Locals、异常中断、断点持久化，以及 `--evaluate` 夹具上的 DebuggerDisplay、展开、改值、Watch 调用属性、Autos、Disassembly、Threads。Memory 窗口与 Processes 窗口只有后端测试。

### 4.14 C# 交互窗口（Scripting）

完成度约 98%（✅ 24 / 🟡 1 / ❌ 0 / ⛔ 2）。WPF 范围：`Extensions/dnSpy.Scripting.Roslyn/`、`WPF/Scripting/`。跨平台实现：`FE/components/CSharpInteractive.tsx`、`FE/script-lines.ts`、`BE/Scripting/CSharpScriptService.cs`；RPC `script/evaluate`、`script/reset`、`script/isComplete`、`script/classify`，通知 `script/output`，以及宿主反向请求 `client/request` / `client/response`。

脚本在后端 Host 进程内执行；计划文档 §3.2 写的是「独立子进程隔离执行环境」，与实现不符。

| 功能点 | WPF 来源 | 状态 | 备注 |
|---|---|---|---|
| 打开窗口（Ctrl+Alt+N） | `CSharp/CSharpToolWindowContent.cs` | ✅ | |
| 持久会话，变量跨提交保留 | `Common/ScriptControlVM.cs` | ✅ | |
| 返回值、诊断、异常格式化 | 同上 | ✅ | 诊断最多 5 条，其余按 WPF 写成 `+ additional N error(s)` |
| 横幅与提示语 | `CSharp/CSharpControlVM.cs` | ✅ | 开窗依次打印引擎版本、`Loading context from '...'`（找到响应文件时）和 `Type "#help" for more information.` |
| `#help` | `Common/HelpCommand.cs` | ✅ | 与 WPF 同一张表：Enter、Ctrl+Enter、Shift+Enter、Esc、Alt+↑/↓、Ctrl+Alt+↑/↓、Ctrl+A |
| 清屏 | `Common/ClearCommand.cs` | ✅ | 工具栏、右键菜单与 Ctrl+L |
| 重置 | `Common/ResetCommand.cs` | ✅ | `#reset [noconfig]`；取消旧会话、触发 `ScriptResetting`，随即建立新会话，不等待不响应取消的脚本（缺陷 #8 已修复） |
| `#r` / `#load` 与搜索路径 | `ScriptControlVM.cs` | ✅ | 相对路径按用户目录、`~/scripts`、数据目录/scripts、程序目录/scripts 解析；`#r` 的简单程序集名先查运行时程序集，再交给 Roslyn |
| 预置引用与 `.rsp` | `CSharpInteractive.rsp` | ✅ | 读程序目录与数据目录的 `CSharpInteractive.rsp`（随 Host 发布并可改），支持 `/r`、`/u`、`/lib`、`/loadpath`；`#reset noconfig` 跳过 |
| 提交键（按完整性提交） | `WPF/Text/Editor/ReplEditor.cs` | ✅ | Enter 只提交 `#` 命令或 `IsCompleteSubmission` 为真的输入，否则换行；Ctrl+Enter 强制提交；Shift+Enter 换行；Escape 清空输入 |
| 历史 | `Text/Editor/ReplCommandInfoProvider.cs` | ✅ | Alt+↑/↓ 遍历；Ctrl+Alt+↑/↓ 只选匹配当前输入的命令；保留最近 100 条 |
| Escape 清空输入、Ctrl+A 两段选择 | `ReplCommandTargetFilter.cs` | ✅ | 第一次 Ctrl+A 选当前输入，第二次选整个日志 |
| 输入代码语义着色 | `ScriptControlVM.cs` | ✅ | `script/classify` 按会话的下一次提交编译输入，用 `RoslynClassifier` 的映射给出 dnSpy 主题色，未绑定的名字为红色；回显保留输入时的颜色（见 4.15） |
| Print / PrintLine / PrintError | `dnSpy.Contracts.DnSpy/Scripting/Roslyn/IScriptGlobals.cs` | ✅ | 全套重载：格式串、`TextColor`、`object` 值、异常、`PrintLineError`；`Print` 留在当前行，`PrintLine` 结束它 |
| 彩色输出 API | `Common/ScriptGlobals.cs`、`CachedWriter.cs` | ✅ | `TextColor` 枚举（复制 WPF 的全部颜色名）、`Write(ColorAndText)`、`CreateWriter()`、`IOutputWriter` / `IOutputWritable` |
| 输出实时出现 | 同上 | ✅ | 每行以 `script/output` 通知推送，带 generation；脚本在后台线程的打印也继续追加到日志 |
| PrintOptions | `Common/PrintOptionsImpl.cs` | ✅ | Ellipsis、EscapeNonPrintableCharacters、MaximumOutputLength、MemberDisplayFormat、NumberRadix、AutoColorizeObjects |
| `Resolve<T>` 访问 dnSpy 服务 | `WPF/Scripting/ServiceLocator.cs` | ✅ | 后端服务注册表；Host 登记 `WorkspaceManager`，脚本可用 `Resolve<WorkspaceManager>()` 读取已打开的程序集。可解析的服务比 WPF 的窗口服务少 |
| 消息框与输入框 | `ScriptGlobals.cs` | ✅ | `Show`/`ShowYesNo`/… 走客户端原生消息框，`Ask<T>` 弹输入框并按 converter/verifier 重问直到有效或取消；没有 `ownerWindow` 参数（WPF 的 `Window` 类型） |
| UI 线程（UIDispatcher、`UI(...)`） | 同上 | ⛔ | WPF Dispatcher 专属 |
| 生命周期与协作取消（Token、Break） | 同上 | ✅ | `Token`、`ScriptResetting`（重置时先取消令牌再触发，未注销的脚本输出仍可见）、`Break()` |
| 复制、Copy Code、剪切、粘贴 | `Common/Commands.cs` | ✅ | 右键菜单与 Ctrl+C / Ctrl+Shift+C / Ctrl+X / Ctrl+V；Copy Code 要有选区，取提交过的代码（日志里的选区按整行取，WPF 是精确字符区间） |
| 保存文本 / 保存代码 | `Commands/RoslynReplIds.cs` | ✅ | Ctrl+S / Ctrl+Shift+S 与右键菜单；Save 写整个窗口（含提示符），Save Code 只写提交过的代码与当前输入（选中的日志行按整行取） |
| 自动换行开关 | `Common/ReplSettings.cs` | ✅ | 工具栏复选框，状态存进 REPL 选项 |
| 显示行号开关 | `Common/Commands.cs` | ✅ | 右键菜单与选项页；默认开（同 WPF 的 `ShowLineNumbers`）；日志与输入框是分开的视图，行号画在输入框上 |
| REPL 选项页 | `WPF/Text/Repl/*AppSettingsPage.cs` | 🟡 | General（自动换行、行号、当前行高亮）、Scroll Bars、Tabs 与 Advanced 的 Indicator margin / Mouse wheel zoom / Don't add extra line spacing 已生效；Advanced 的压缩空行、Selection margin、Zoom control、引用高亮与缩进参考线在拆分后的 Monaco 输入框里没有对应 |
| VB Interactive | `VisualBasic/*` | ⛔ | WPF 自己在 csproj 中排除了 VB 文件 |

实现要点：

- **实时输出**：`script/output` 通知把每一行（连同颜色类）在脚本运行时推给窗口，响应只在没有客户端时（单测、无窗口宿主）返回整批结果。帧改成了同步写管道：脚本线程会阻塞到行写进管道，而单核宿主上「同步等待异步写」会让异步续体排在被阻塞的线程池线程之后，形成死锁。
- **重置与隔离**：每个会话有自己的执行锁、取消源和 generation。Reset 只取消旧会话并换上新会话，所以不响应取消的脚本不会拖住新引擎；旧会话的输出与迟到结果按 generation 丢弃。排队中的提交用旧令牌取消。
- **反向请求**：脚本的 `Show`/`Ask<T>` 由宿主发出 `client/request` 通知，主进程用原生消息框回答，或把输入框交给渲染进程的弹窗（`onScriptAsk` / `respondScriptAsk`），答案以 `client/response` 通知回到宿主。无窗口的宿主按「用户取消」回答。
- **脚本可见性与兼容层**：`dnSpy.Backend.Contracts/Scripting.cs` 复刻了 WPF 的 `TextColor`、`IPrintOptions`、`IOutputWriter`、`IOutputWritable`、`ICachedWriter`、`MsgBoxButton`，因为脚本只能引用后端契约程序集。默认引用包含 `dnSpy.Backend.Contracts`、`dnSpy.Backend.Core`、`dnlib`，默认导入再加两个 dnSpy 命名空间。

实现文件：

- 后端：`BE/Scripting/CSharpScriptService.cs`（会话、输出路由、globals）、`ScriptAssemblyResolver.cs`（`#r` 与 `/r` 的解析）、`ResponseFileReader.cs`（rsp 与 `RespFileUtils`）、`Scripting/CSharpInteractive.rsp`；`BE/dnSpy.Backend.Contracts/Scripting.cs`；`BE/JsonRpcServer.cs` 的分发、通知与反向请求；`BE/JsonRpcScriptClient.cs`
- 前端：`FE/components/CSharpInteractive.tsx`（工具栏、命令、右键菜单、Ask 弹窗、选项）、`FE/script-lines.ts`（把带换行的输出片段拼回行、Save/Copy Code 的文本）、`FE/app-store.ts`（`#` 命令、history、generation 过滤）、`MAIN/index.ts` 与 `PRELOAD/index.ts`（`script:isComplete`、`script:output`、`script:ask`）

测试：后端 `CSharpScriptServiceTests.cs` 37 条（除原有 REPL 语义外，新增完整性判断、Print 重载与颜色、PrintOptions、CachedWriter、rsp 与 noconfig、`#r`/`#load` 搜索路径、Resolve、消息框/输入框与重问、运行中实时输出、不响应取消脚本上的 Reset、ScriptResetting）；前端 `CSharpInteractive.test.tsx` 7 条（输出片段拼行、多行回显、空行、Save/Copy Code 文本）、`app-store.test.ts` 新增 5 条（noconfig、流式输出、generation 过滤与迟到响应）；e2e 3 个场景（提交与会话、编辑键与历史/保存/实时输出/Ask、语义着色）。

### 4.15 Roslyn 语言服务

完成度约 69%（✅ 3 / 🟡 5 / ❌ 0）。WPF 范围：`dnSpy/Roslyn/dnSpy.Roslyn*`。2026-10-16 按实现与测试复核；此前标的 95% 是一份没有接通的骨架（后端 `JsonRpcServer` 没有分发 `languageService/*`，签名帮助直接返回 null，前端 provider 挂在所有 csharp 模型上），已整体重写。

WPF 里这些能力分属两个宿主：C# Interactive 只用 `RoslynClassifier` 给输入做语义着色（`ScriptControlVM.OnCommandUpdatedAsync`，REPL 缓冲区不在 Roslyn Workspace 里，所以没有补全、悬停、签名帮助、智能缩进）；补全、Quick Info、签名帮助、智能缩进、结构导航、编译诊断只服务于「Edit Method / Class (C#)」编辑器。跨平台版按同样的划分移植：

- **C# Interactive 的语义着色**已接到界面上：`script/classify` 把输入当作会话的下一次提交编译（引用、导入、前面提交声明的变量都在），用 WPF 同一套映射给出 dnSpy 主题色；绑定不上的名字按 WPF 的默认色画成红色；提交后的回显保留输入时的颜色（WPF 的 REPL 缓冲区也保留）。
- **代码编辑器的其余能力**做到「后端服务 + 可复用的前端绑定」为止：`languageService/*` 每个文档一个 AdhocWorkspace（对应 `RoslynLanguageCompiler` 每次编辑会话一个 workspace），前端 `attachRoslynDocument(monaco, editor, { references, options })` 把一个 Monaco 编辑器接成 Roslyn 文档。它们的宿主 Edit Method (C#) 编辑器属于 4.12 的 Compiler 子模块，目前未移植，所以这些能力还没有界面入口。provider 只回答绑定过的模型，反编译文档和 C# Interactive 从不向后端发请求。

实现文件：

- 后端：`BE/LanguageService/RoslynClassifier.cs`（`RoslynClassifier` 的移植）、`RoslynTextParts.cs`（`TextTagsHelper`、符号显示部件着色、`GlyphHelper` 的图标名）、`RoslynLanguageService.cs`（文档、补全、Quick Info、诊断、缩进、结构导航）、`SignatureHelpProvider.cs`、`LanguageServiceHost.cs`（MEF 宿主、引用程序集与 XML 文档）、`DocumentationText.cs`；`BE/Scripting/CSharpScriptService.cs` 的 `ClassifyAsync`
- RPC：`script/classify`；`languageService/open`、`update`、`close`、`classify`、`completion`、`completionDescription`、`quickInfo`、`signatureHelp`、`diagnostics`、`indentation`、`selectionRanges`
- 前端：`FE/roslyn-classification.ts`（分类结果画成 `tc-*` 内联装饰，供 REPL 与代码编辑器共用）、`FE/roslyn-language-service.ts`（各 provider 与 `attachRoslynDocument`，连同它要的 Monaco contrib：`FE/roslyn-editor-contribs.ts`；`FE/monaco.ts` 仍只导入 `editor.api`，之前那版改成整包导入后代码视图的右键光标定位回归了，已改回）、`FE/components/CSharpInteractive.tsx`、`FE/components/ColoredText.tsx` 的 `ClassifiedText`；`tc-*` 的颜色、加粗与斜体由主题服务（`FE/theme-service.ts`）按当前 `.dntheme` 写出

| 功能点 | WPF 来源 | 状态 | 备注 |
|---|---|---|---|
| 语义分类着色 | `dnSpy.Roslyn/Text/Classification/RoslynClassifier.cs` | ✅ | 逐项移植：名字按绑定到的符号细分（静态类/密封类、扩展方法、字面量字段、脚本顶层变量当局部变量等），附加类分类与正则/JSON 内嵌分类跳过。C# Interactive 输入实时着色、回显保留颜色。WPF 的分类器不认识 record，会把 record 名画成默认色；这里按它自己的 `TextTagsHelper` 把 record 当类、record struct 当结构体 |
| 补全 | `dnSpy.Roslyn/Intellisense/Completions/*` | 🟡 | Roslyn `CompletionService`：触发判断走 `ShouldTriggerCompletion`，插入文本取 Roslyn 的 InsertionText（`List<>` 插入 `List`），复杂项（override 等）预先算 `GetChangeAsync`，提交字符按规则增删，builder 模式不随键入提交，提示框里是带颜色的 `GetDescriptionAsync`，最近使用由 Monaco 的 `recentlyUsed` 承担。缺：WPF 建议框底部按种类过滤的按钮（Monaco 建议框没有过滤栏），图标是 Monaco 的而不是 dnSpy 的；缺宿主编辑器（4.12） |
| Quick Info | `Intellisense/QuickInfo/*` | 🟡 | 按 WPF 的六个分节（说明、文档注释、用法、类型参数、匿名类型、异常）给出带颜色的文本，后端也给出符号图标名与「不是所有目标都可用」的警告标记；Monaco 的悬停框显示不了这两个图标。引用程序集优先取本机 SDK 的 Microsoft.NETCore.App.Ref，以便带上 XML 文档；缺宿主编辑器（4.12） |
| 签名帮助 | `Intellisense/SignatureHelp/*` | 🟡 | 这一版 Roslyn 的 `SignatureHelpService` 不公开（WPF 靠 `dnSpy.Roslyn.Internal` 的 IVT 访问），改为在语义模型上实现同一组 provider：调用、对象创建（含 `new(`）、构造函数初始化器、主构造函数基类型、索引器、特性、泛型名；按参数个数排序重载，选中绑定到的那个、绑定不上时选第一个放得下的，命名参数与 params 定位到对应参数，签名与参数说明取 XML 文档。Monaco 的参数提示只能显示纯文本签名（文档部分有颜色）；缺宿主编辑器（4.12） |
| 智能缩进 | `dnSpy.Roslyn.EditorFeatures/SmartIndent/*` | ✅ | Roslyn 的 `IIndentationService` 不公开，改用 Roslyn 格式化器：把新行的首个记号（空行时放一个占位标识符）就地格式化，取它被移到的列；按编辑器的缩进宽度、制表符宽度与是否用制表符计算。前端以 Enter 的 on-type formatting 应用。WPF 的 C# Interactive 同样没有 Roslyn 智能缩进（缓冲区没有 Document） |
| 文本结构导航 | `dnSpy.Roslyn.EditorFeatures/TextStructureNavigation/*` | 🟡 | `GetSpanOfEnclosing` 链（记号 → 各层语法节点）作为 Monaco 的扩展/收缩选区（Shift+Alt+→/←）。`GetExtentOfWord`（双击选词、Ctrl+←/→ 按记号移动）在 Monaco 里没有对应的扩展点，仍是 Monaco 的单词规则 |
| 编译诊断 | `dnSpy.Roslyn/Compiler/RoslynLanguageCompiler.cs` | ✅ | 与 `CompileAsync` 相同：Emit 到内存取诊断，失败时关掉 unsafe 再试一次；去掉 Hidden，带 `CSharpLanguageCompiler.GetHelpUri` 的帮助链接、行列与偏移。编译选项（优化、溢出检查、unsafe、预处理符号）取 WPF C# 编译器设置的默认值，可由打开请求覆盖。前端 `compile()` 把结果标成 Monaco 标记 |
| 代码编辑器选项页 | `dnSpy.Roslyn/Compiler/CodeEditorOptionsDefinitions.cs` | 🟡 | 选项页在（`codeEditor`、`compiler` 两组设置），但还没有编辑器读它们 |

测试：后端 `LanguageService/RoslynLanguageServiceTests.cs` 26 条（着色、补全与提示、Quick Info、四类签名帮助与重载选择、诊断与帮助链接、预处理符号、智能缩进、选区、引用与 XML 文档）、`CSharpScriptServiceTests.cs` 新增 5 条（REPL 着色、未绑定名字、前一提交的变量、着色不执行代码）；前端 `roslyn-classification.test.ts`、`roslyn-language-service.test.ts`（各 provider 的映射、只回答绑定过的模型、编辑先于请求送达）、`app-store.test.ts` 的回显颜色、`ColoredText.test.tsx`；e2e「colors the C# Interactive input the way the WPF window's Roslyn classifier does」。

### 4.16 扩展系统

不计完成度（✅ 1 / ❌ 1 / ⛔ 9）。`docs/linux-support-plan.md` §3.2、§10 与 `docs/linux-release-1.0.md` 写明：不兼容 WPF/MEF 扩展二进制，首版只装载随产品发布的内置模块，第三方扩展 SDK 不在 1.0 范围内。这是延期而不是放弃。

- ✅ 内置功能（分析器、编辑、调试、脚本、BAML、反编译）直接编进 `dnSpy.Backend.*` 和前端，不能单独卸载或替换。
- ❌ 关于页不列出已加载的模块（WPF `MainApp/AboutScreen.cs`）。
- ⛔ 扩展发现（`*.x.dll`）、`--extension-directory`、兼容性检查、MEF 组合与缓存、资源字典注入、第三方后端插件、第三方前端扩展点、扩展生命周期事件、示例扩展（`Extensions/Examples`）。

目前没有新扩展协议的任何骨架（后端插件接口、前端清单贡献点）。若把延期项计为 ❌，完成度约 17%。

### 4.17 命令行版 dnSpy.Console

完成度约 92%（✅ 11 / 🟡 2）。WPF 范围：`dnSpy/dnSpy.Console/Program.cs`。跨平台实现：`CrossPlatform/backend/dnSpy.Console/`（程序集名 `dnSpy.Console`，命名空间 `dnSpy.Cli`），`CrossPlatform/backend/tests/dnSpy.Backend.Tests/ConsoleTests.cs` 22 条测试；2026-10-18 按实现与本机测试复核（后端 506 条全绿）。

CLI 是独立可执行文件，已加入 `dnSpy.CrossPlatform.slnx`；`scripts/package-platform.mjs` 把它与 `dnSpy.Backend.Host` 一起发布到后端目录（两者共用同一份自包含运行时，先发布 Host 再发布 Console），所以安装包里的 `resources/backend/<rid>/dnSpy.Console` 可以直接运行。它不依赖 GUI，也不使用 stdio JSON-RPC。入口 `Program.cs` 只设置 UTF-8 输出，实际逻辑在 `DnSpyConsole` 里，测试可以进程内调用。

| 功能点 | WPF 来源 | 状态 | 备注 |
|---|---|---|---|
| 批量导出为项目（`-o`） | `DnSpyDecompiler.Decompile`、`MSBuildProjectCreator` | ✅ | 每个模块一个目录与工程；工程文件由 `ICSharpCode.Decompiler` 的 `WholeProjectDecompiler` 生成，dnSpy 的开关在其子类里实现 |
| 递归与通配符（`-r`、`dir/*.dll`） | `GetDotNetFiles`、`DumpDir` | ✅ | 与 WPF 一样：显式文件不是 .NET 文件报错，目录扫描跳过；`-r` 才进子目录 |
| 生成 .sln（`--sln-name`、`--no-sln`、`.slnx`） | `SolutionWriter` | ✅ | 逐字移植 VS2005–2022 的 solution 头与工程配置节；后缀为 `.slnx` 时写 XML 形式；工程按 exe 在前、文件名排序 |
| 项目格式（`--sdk-project`、`--vs`、`--project-guid`） | `SdkProjectWriter`、`DefaultProjectWriter` | ✅ | `--vs` 写传统工程的 `ToolsVersion` 与 solution 头；`--project-guid` 按 WPF 的规则递增最后 8 位并写进每个工程与 .sln |
| 语言选择（`-l`） | `GetLanguageOrNull` | 🟡 | 接受 `C#`、`Visual Basic`、`IL`、`IL with C#` 及各自的唯一/通用 GUID；IL 语言没有工程扩展名，导出时报「doesn't support creating project files」。VB 的工程导出不是真正的 VB 反编译（见下） |
| 反编译器选项透传 | `IDecompiler.Settings.Options` | 🟡 | 开关名与 WPF 相同（`--xml-doc`、`--anon-methods`、`--async`、`--tokens`、`--bytes`、`--sort-members` 等），并支持 `no-`/`dont-` 前缀；只提供 `ICSharpCode.Decompiler 11.1` 里存在的选项，dnSpy fork 特有的 `member-order`、`max-string-length`、`show-all`、`hex`、`full-names` 等没有对应开关 |
| 资源开关（`--no-resources`、`--no-resx`、`--no-baml`） | `Project.CreateEmbeddedResourceFiles`、`BamlResourceProjectFile` | ✅ | `--no-resources` 保留原始 `.resources`；`--no-resx` 不写 `.resx` 而保留 `.resources`；BAML 默认经 `ICSharpCode.BamlDecompiler` 还原成 `.xaml`（`Page`/`ApplicationDefinition`），`--no-baml` 保留 `.baml` 资源项 |
| 程序集解析（`--asm-path`、`--user-gac`、`--no-gac`、`--no-stdlib`、`--gac-file`） | `AssemblyResolver`、`GetDotNetFiles` | ✅ | `--asm-path`/`--user-gac` 同时喂给 dnlib 与 ILSpy 解析器，用户 GAC 目录视为 GAC（不写 HintPath）；`--no-gac` 清空解析器的 GAC 搜索；`--no-stdlib` 从工程引用里去掉 mscorlib/System.Runtime 等；`--gac-file` 支持部分程序集名并回落到 `GacInfo` |
| 单个类型/成员输出（`-t`、`--type`、`--md`） | `Decompile` 的 stdout 分支 | ✅ | 类型查找与 WPF 相同（全名、去泛型参数、仅类型名、大小写不敏感）；只允许一个文件；输出 C#/VB/IL/IL with C# 四种语言 |
| 彩色输出（`--no-color`、重定向时自动关闭） | `ConsoleColorizerOutput`、`ColorProvider` | ✅ | 按 dnSpy 的颜色映射：关键字青、注释绿、字符串暗黄、类型/成员品红、方法暗黄、本地变量白、标签暗红；IL 的 opcode/引用同样着色 |
| `--spaces` | `GetIndenter` | ✅ | 0 用制表符，1–100 用指定空格数；C#/VB/IL 的缩进都跟随 |
| `--threads` | `ProjectCreatorOptions.NumberOfThreads` | ✅ | 传给 `WholeProjectDecompiler.MaxDegreeOfParallelism`；0 表示每核一个线程 |
| 用法帮助 | `PrintHelp` | ✅ | 与 WPF 相同：无参数或参数错误时打印用法、语言、语言选项与示例；错误以 `ERROR: ...` 结尾 |

与 WPF 的已知差异：

- 语言选项是子集（见上表 🟡），`--help` 里列出的也就是实际支持的选项；WPF 里按选项 GUID 兜底的写法没有移植。
- Visual Basic 的工程导出是把 C# 文本交给 GUI 同款的 `ICSharpCode.CodeConverter` 再改写成 `.vbproj`，不是 WPF 那种真正的 VB 反编译器。普通类可以编译；record、C# 主构造函数、部分设计器代码会转换失败或生成不可编译的 VB。stdout 的 VB 视图同样受此限制。转换前会去掉 nullable 特性，并修正 `ParamArray` 与 `Optional` 同时出现的参数列表。
- `--no-gac` 通过清空 `UniversalAssemblyResolver` 的进程级 GAC 目录表实现（该库没有实例级开关）；CLI 一次进程只解析一遍参数，因此与 WPF 等价，进程内重复调用时会在下一次创建解析器时把表恢复。
- dnSpy 的工程导出还会把卫星程序集折进主工程、把 WinForms 设计器拆成 `.Designer.cs`、生成 Settings/SplashScreen 等文件；这些没有单独移植，卫星程序集按普通模块导出，设计器与 Settings 类型按普通代码写进工程。
- 工程文件的具体 XML 由 `WholeProjectDecompiler` 生成，属性顺序与 WPF 的 `SdkProjectWriter`/`DefaultProjectWriter` 不完全逐字节相同；`--project-guid`、`--vs`、`--no-stdlib`、工程引用替换、BAML→XAML 与资源开关都在生成后按 dnSpy 的规则改写。
- 导出的 XAML code-behind 会按 dnSpy 的 `XamlTypeProjectFile` 规则改成 `partial` 并移除 `InitializeComponent`/`IComponentConnector.Connect`/`_CreateDelegate` 及其字段；`BamlTarget` 导出的工程在本机用 `dotnet build -p:EnableWindowsTargeting=true` 实测可编译。
- GUI 的「Export to Project」菜单仍未接线（见 4.4），CLI 与它共用的导出实现目前只存在于 `dnSpy.Console` 项目里。

测试：`ConsoleTests.cs` 覆盖帮助与错误、C#/VB/IL/IL with C# 的 stdout（IL 默认带 PDB 的 sequence point）、`--spaces`、语言 GUID、语言选项的 `no-`/`dont-` 形式、非 .NET 文件、SDK 工程与 .sln、工程引用替换、`--no-sln`、`.slnx`、BAML→XAML、`--no-baml`、`--no-resources`、传统工程的 `ToolsVersion`/`ProjectGuid`、通配符，以及把导出的 C# 与 WPF 工程交给 `dotnet build` 实际编译。WPF 启动参数本体（`-e` 等）见 4.1。

### 4.18 其他杂项

不计完成度（✅ 5 / 🟡 1 / ❌ 1 / ⛔ 7）。

| 项目 | WPF 来源 | 状态 | 备注 |
|---|---|---|---|
| 本地化资源（15 种语言） | `WPF/Properties/*.resx` 等 | ✅ | 15 种，译文由 resx 生成，见 4.1 |
| 许可证与鸣谢 | `WPF/LicenseInfo/*` | 🟡 | 安装包里齐全；应用内看不到 |
| 图标库 `dnSpy.Images` | `dnSpy/dnSpy.Images/` | ✅ | 全部 245 张原图转成 SVG、按主题换色，树、菜单、工具栏与各工具窗口都在用 |
| 更新检查 | `WPF/MainApp/UpdateService.cs` | ❌ | 选项页复选框无效，会误导用户 |
| 打开列表与默认列表 | `WPF/FileLists/*` | ✅ | 与 4.1 重复；默认列表取本机 .NET 共享框架 |
| netcorefiles（dbgshim） | `DBG/netcorefiles/` | ✅ | 改用 `Microsoft.Diagnostics.DbgShim` NuGet 包 |
| 以管理员身份重启 | `WPF/MainApp/RestartAsAdministratorCommand.cs` | ✅ | 与 4.1 重复 |
| 弱事件、MVVM 辅助、启动优化、WineFixes、DevBuildWarning | `WPF/Events`、`WPF/MVVM`、`WPF/MainApp/*` | ⛔ | 基础设施或 WPF 专属 |
| `dnSpy-x86` 32 位宿主 | `dnSpy/dnSpy-x86/` | ⛔ | 目标平台是 x64 |
| AppHostInfoGenerator | `DBG/AppHostInfoGenerator/` | ⛔ | 后端直接运行 apphost，不需要识别表 |

## 5. 建议的推进顺序

按「风险 × 使用频率 ÷ 工作量」粗排，供排期参考。

**P0：正确性与数据安全**（工作量小，影响大）

1. 修 Save / Save Module 的目标模块（缺陷 #1），以及保存单个模块清掉全局 `dirty`（缺陷 #3）。
2. ~~停止调试时区分启动的进程与附加的进程，后者走 Detach，并在菜单里加 Detach All（缺陷 #2）~~ 已完成（2026-10-17）。
3. ~~关闭窗口前，有未保存修改时弹出「保存 / 放弃 / 取消」对话框~~ 已完成（2026-10-14）。
4. ~~修 PE-only/ELF 文件的 hex 读取（缺陷 #6）~~ 已完成（2026-10-18）。Raw Save Resource（缺陷 #5）已修。
5. ~~IL 编辑器默认重算 MaxStack（缺陷 #4）~~ 已完成（2026-10-18）。

**P1：让已有界面生效**（UI 已经做好，只差接线）

1. 给 `DecompileRequest` 加反编译设置 DTO，接通 C#/VB、IL、BAML 选项页与 DecompileFullType；随后接文本编辑器、Hex、调试器等页面，并把 `UseMemoryMappedIO` 落到后端读文件的方式上。主题、字体、RestoreTabs、背景图片、Output 窗口这几页已于 2026-10-14 接通。
2. Monaco 改为完整导入（或按需导入 contrib），补一条查找功能的 e2e 防回归。
3. ~~调试器选项传给后端：JIT 优化抑制、Just My Code、忽略 Debugger.Break、忽略未处理异常~~ 已完成（2026-10-17）。
4. ~~绑定菜单上已标出的快捷键，修正 Go to Token 的键位与 Shift+Alt+Enter 冲突~~ 已完成（2026-10-14）。
5. ~~记忆窗口位置和尺寸；接受裸文件路径参数并加单实例锁~~ 已完成（2026-10-14；单实例默认关闭，与 WPF 的 `AllowMoreThanOneInstance` 默认值一致）。
6. ~~CI 增加前端 vitest 单测~~ 已完成（2026-10-14）。

**P2：补齐核心能力**

1. IL 输出改用 `ReflectionDisassembler` 并生成 span 与语句表，一次解决 IL 视图的跳转、断点、书签持久化。
2. ~~方法体编辑器支持局部变量与异常处理器，以及指令插入、移动和操作数选择器~~ 已完成（2026-10-18，见 4.12）。
3. ~~调试器的表达式求值与 func-eval、对象字段展开（Watch、Autos、DebuggerDisplay、完整断点条件都依赖它）~~ 已完成（2026-10-17）。
4. ~~Roslyn 源码编辑（Edit Method / Class (C#)），连带 ModuleImporter 与 Merge with Assembly~~ 已完成（2026-10-18）；编译设置页仍未移植。
5. 元数据表子树与表格视图；Hex 视图的结构信息与 F12 跳转（光标、选区与直接改写已于 2026-10-18 完成，见 4.7）。
6. GUI 的 Export to Project 接线（命令行版已于 2026-10-18 完成，见 4.17；导出实现目前在 `dnSpy.Console` 里，可抽到后端共享）。
7. ~~保存选项：保留 RID/堆、写 PDB、混合模式模块~~ 已完成（2026-10-18）；PE/Metadata/Cor20 覆盖页与 Save All 的进度/取消未做。

**P3：扩展范围**

~~字符串引用窗口；程序集与模块属性对话框；资源新建与元素编辑~~（2026-10-18 前两项与元素编辑的主体已完成，图片与 ImageListStreamer 专用对话框未移植）；~~Memory、Disassembly、Processes 等调试窗口；Set Next Statement 与 Run to Cursor~~（2026-10-17 已完成）；~~脚本 `Resolve<T>` API~~（2026-10-18 已完成）；Mono/Unity 调试；扩展系统；更新检查。

## 6. 测试基线

2026-10-18 程序集编辑补齐后在本机重新跑过（后端与前端都是真实构建，`DebugTarget` 夹具也重新构建）：

| 套件 | 结果 |
|---|---|
| 后端 `dotnet test` | 484 通过（程序集编辑补齐后；此前为 462、459、438、425、406、403、359） |
| 前端 `tsc --noEmit`（`tsconfig.json`、`tsconfig.node.json`） | 0 错误 |
| 前端 vitest | 1279 通过（程序集编辑补齐后；此前为 1243、1225、1214、1201、1103、1095、1041） |
| e2e（Playwright Electron） | 96 通过、3 跳过、0 失败（程序集编辑补齐后重跑） |

程序集编辑这一轮新增的 `Protocol.cs` 记录全部追加在文件末尾（方法体、资源、程序集/模块、保存选项、编译器），因此 e2e 钉死的 `RpcException @02000088`、`get_Code @06000A56` 没有移动。Hex 编辑器这一轮改了 `Protocol.cs`（三个请求/响应记录：位置解析、元数据定位、查找），e2e 里钉死的标记随之变为 `RpcException @02000088`、`get_Code @06000A56`（此前为 `@02000082`/`@060009EC`）。调试器这一轮把变量窗口的数字改成与 WPF 一样默认十六进制，e2e 里 Locals 的断言随之写成 `0x0000002A` 等。C# 交互窗口那一轮改了 `Protocol.cs` 的脚本记录（输出加颜色、评估响应加 generation、Reset 请求/响应、完整性请求、反向请求）。引擎的 JSON 回复改为驼峰命名（`DebugJson`），着色片段到前端是 `{ text, color }`。

复核前 HEAD 后端和前端都构建不过（见 4.11），所以那之前记的数字都来自更早的构建。改 `Protocol.cs` 后 e2e 里钉死的元数据标记变为 `RpcException @02000079`、`get_Code @0600095C`；整包导入 Monaco 带来的右键光标定位回归（「keeps the caret on what it was right-clicked on」）随 `monaco.ts` 改回 `editor.api` 消失。这一轮新增的用例见 4.10、4.11、4.14、4.15 各节末尾；分析器这次改 `Protocol.cs`（两个请求加语言参数、`TextColors.ILModule`）没有挪动这两个标记。

应用壳复核（2026-10-14）时前端新增的用例：窗口状态（`window-state.test.ts`）、窗口标题（`app-info.test.ts`）、命令行选项解析（`command-line-options.test.ts`）、缩放档位（`zoom.test.ts`）、背景图片的尺寸与位置（`background-image.test.ts`）、消息框的「不再提示」（`message-box.test.ts`）、工具窗口菜单（`ToolWindowTabContextMenu.test.tsx`）、输出窗口的命令栏（`ToolWindows.test.tsx`）、关于对话框与它引用的两份文本是否与出处一致（`AboutDialog.test.tsx`、`about-resources.test.ts`）。CI 现在会跑前端单测（`.github/workflows/cross-platform.yml` 的 Test frontend 步骤）。

此前记录的「后端 336 通过」之后的一次「346 通过」是 `--no-build` 跑在旧 DLL 上得到的；真实构建下当时有 22 条失败，已逐条按 WPF 行为修正（1 处后端缺陷、21 条过期断言），见 `docs/assembly-tree-frontend-integration.md`。

覆盖较好的部分：元数据编辑对话框、签名与自定义特性编解码、搜索、分析器、程序集树（键盘、图标、最近文件、命令行、Reload、移除与撤销）、断点判定与跟踪点、异常设置、书签。

明显的测试盲区：反解码器选项是否生效（消费方在后端，尚无 DTO）、Monaco 编辑器功能（查找、悬停、折叠）、`JsonRpcServer` 的握手与分帧、方法体编辑器组件、调试器的 Pause、附加对话框，以及 Memory 与 Processes 窗口的前端。应用壳里，`--settings-file` 与 `-p`/`-pn` 只有单测、没有 e2e，系统高对比度切换只在单测里模拟；窗口状态与关闭询问有单测，但没有 e2e。

## 7. 与现有文档的出入

| 文档 | 说法 | 实际情况 |
|---|---|---|
| `docs/linux-release-1.0.md` | 调试「不含异常断点与表达式求值」 | 两者都已实现（4.13，表达式求值于 2026-10-17 补上） |
| `docs/linux-release-1.0.md` | 稳定版功能包含「ECMA-335 Metadata Tables」 | 只有 Module Information 中的各表行数，没有元数据表视图（4.8） |
| `docs/linux-release-1.0.md` | 验证结果：.NET 13/13、Vitest 2/2、Electron 7/7 | 当前为 482 / 1277 / 96（见第 6 节） |
| `docs/linux-release-1.0.md` | 能力包含「嵌入资源替换」「结构化 IL 方法体编辑」 | 均属实；方法体现在可编辑局部变量、异常处理器与指令宏（4.12） |
| `docs/linux-support-plan.md` §3.2 | C#/VB 交互窗口在「独立子进程隔离执行环境」中运行 | 脚本在后端 Host 进程内执行，没有 VB（4.14） |
| `docs/linux-support-plan.md` §14 | 验收条件包含「恢复窗口尺寸」「查看监视表达式」 | 窗口尺寸与位置自 2026-10-14 起会恢复（4.1）；监视表达式仍未实现 |
| `docs/linux-support-plan.md` §8.2 | DTO 由 schema 生成 C# 与 TypeScript，CI 检查漂移 | 两边手写，没有生成与漂移检查（4.2） |
| `CrossPlatform/ASSEMBLY_EXPLORER_CHANGES.md` | PE 与 Type References 节点为「占位实现」 | 两者均已完整实现（4.3） |
