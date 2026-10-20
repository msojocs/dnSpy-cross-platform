# dnSpy 跨平台移植进度（对照 WPF 版）

> 审计日期：2026-10-12；反编译与语言（4.4）于 2026-10-20 补齐后按实现与测试复核；程序集树（4.3）于 2026-10-13 按实现与测试复核，2026-10-14 补齐剩余差距后再次复核；应用壳与通用 UI（4.1）于 2026-10-14 按实现与测试复核；字符串引用窗口（4.11）与 Roslyn 语言服务（4.15）于 2026-10-16 按实现与测试复核；分析器（4.10）于 2026-10-16 补齐剩余差距后按实现与测试复核；搜索窗口（4.9）于 2026-10-16 补齐剩余差距后按实现与测试复核；应用壳与通用 UI（4.1）于 2026-10-17 补齐剩余差距后按实现与测试复核；调试器（4.13）于 2026-10-17 补齐后按实现与测试复核；Hex 编辑器浏览（4.7）于 2026-10-18 按实现与测试复核；程序集编辑（4.12）于 2026-10-18 补齐后按实现与测试复核；命令行版 dnSpy.Console（4.17）于 2026-10-18 补齐后按实现与测试复核；代码编辑器与文档标签（4.5）于 2026-10-19 补齐后按实现与测试复核；程序集编辑（4.12）与元数据/PE 视图（4.8）于 2026-10-19 补齐剩余差距后再次按实现与测试复核；调试器（4.13）于 2026-10-20 补齐剩余差距（除 Mono/Unity）后再次按实现与测试复核，随之更新 4.8 的本机反汇编三行；字符串引用窗口（4.11）于 2026-10-20 补齐剩余差距后再次按实现与测试复核；代码编辑器与文档标签（4.5）于 2026-10-20 补上选择边距与行压缩后再次按实现与测试复核，同日补上虚拟空格与 Quick Info 的图标后第三次复核
>
> 代码基线：`linux` 分支，提交 `adeb8c1a9`
>
> 对照对象：WPF 版 `dnSpy/dnSpy/`、`Extensions/*`、`dnSpy/Roslyn/`、`dnSpy/dnSpy.Console/`；跨平台版 `CrossPlatform/`

本文按模块逐项对照 WPF 版用户可见功能，记录跨平台版（Electron/React 前端 + .NET 10 后端）的移植状态。结论来自只读代码审计，没有运行构建或测试；标「代码推断」的条目没有实测。4.1（应用壳）、4.3（程序集树）、4.5（代码编辑器与文档标签）、4.9（搜索窗口）、4.10（分析器）、4.11（字符串引用窗口）、4.7（Hex 编辑器浏览）、4.8（元数据/PE 视图）、4.12（程序集编辑）、4.13（调试器）、4.4（反编译与语言）、4.15（Roslyn 语言服务）与 4.17（命令行版 dnSpy.Console）另有按实现与测试复核的一轮，这几节的结论以本机跑过的单测与 e2e 为准，见表内备注。

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
| 调试器 | ~97% | 82 | 1 | 2 | 5 | 除 Mono/Unity 外对齐 WPF：断点按 IL 位置在 C#/VB/IL 视图都能下、WPF 的 Breakpoints 窗口与 XML 断点文件、跨 await 单步、多进程与「中断所有进程」、hex 编辑器式的 Memory 窗口与 Disassembly 标签、动态模块与内存模块；Roslyn 表达式求值与 func-eval |
| 程序集编辑（AsmEditor） | 100% | 71 | 0 | 0 | 1 | 全部功能点对齐 WPF：C#/VB 源码编辑与编译器设置、方法体三页编辑器（含指令剪贴板与四个操作数窗口）、图像与 ImageListStreamer 资源、新建程序集与 NetModule、按保存点的修改标记、Save Module 五页写出选项与带进度/取消的 Save All、PE 头与元数据表字段编辑、MD 表命令、Copy IL Bytes |
| C# 交互窗口 | ~98% | 24 | 1 | 0 | 2 | 除 UI 线程与 VB 外完整对齐 WPF：完整性提交、两段 Ctrl+A、前缀历史、实时输出、彩色输出 API、PrintOptions、Resolve、消息框/输入框、保存与右键菜单、REPL 选项页 |
| 元数据/PE 视图与本机反汇编 | 100% | 21 | 0 | 0 | 0 | PE 头、表流、元数据表与表行按 WPF 显示为可编辑的表单与表格，排序、Go to RID、Go to MD Table Row 齐备；本机反汇编是调试器的 Disassembly 文档标签（Iced，按 Disassembler 与 Code Style 选项） |
| 反编译与语言 | ~92% | 22 | 4 | 0 | 1 | C#、IL、IL with C# 对齐 WPF：IL 为分支反汇编器的移植，C# 页的分支独有选项（token 注释、成员顺序、修饰符等）写在包的输出上，程序集/模块/命名空间节点照 WPF 只写头部与特性；BAML 选项与 Disassemble BAML、GUI 导出项目齐备；VB 仍是 C# 的转换，三个 C# 选项包不支持 |
| 代码编辑器与文档标签 | 100% | 31 | 0 | 0 | 1 | 标签模型、单击/Ctrl+单击跟随、每标签历史、引用与关键字高亮、Quick Info（含图标）、块结构线、分隔线、缩放、带格式复制都照 WPF；VB 经 Roslyn 重新绑定得到引用；2026-10-20 补上选择边距、行压缩与虚拟空格，Text Viewer 页全部生效 |
| Hex 编辑器（浏览） | ~84% | 24 | 4 | 3 | 0 | 整文件滚动转储、光标与选区、键入改写、右键菜单、四个对话框与查找；缺结构信息与 F12 |
| Roslyn 语言服务 | ~69% | 3 | 5 | 0 | 0 | C# Interactive 有 WPF 同款语义着色；补全、Quick Info、签名帮助、诊断、智能缩进、选区已做成后端服务与可复用绑定，宿主 Edit Method (C#) 已在 4.12 移植 |
| 字符串引用窗口 | 100% | 22 | 0 | 0 | 0 | 全部功能点对齐 WPF：三类来源、过滤与选项、WPF 的排序语义、列重排与列宽、右键菜单、自动刷新；来源列随工具栏语言经该反编译器的格式化器书写（VB 用自己的，IL 与 C# 同），C#/VB/IL 视图里跟随 ldstr 都定位到所在语句 |
| dnSpy.Console 命令行 | ~92% | 11 | 2 | 0 | 0 | 跨平台 CLI 已就位：项目导出（SDK/传统工程、.sln/.slnx、GAC 与程序集解析、资源与 BAML 开关）、单个类型/成员输出（C#/VB/IL/IL with C#）、彩色与 `--spaces` 都对齐 WPF；语言选项是子集，VB 工程由 C# 转换而来 |
| 扩展系统 | 不计 | 1 | 0 | 1 | 9 | 按计划首版不支持第三方扩展；内置功能直接编进程序 |
| 其他杂项 | 不计 | 5 | 1 | 1 | 7 | 多为 WPF/Windows 基础设施；15 种语言与图标库已齐；更新检查缺失 |
| 工程基础设施（新增） | ~83% | 8 | 4 | 0 | 0 | 协议、安全、三平台打包、CI 发布已就绪；CI 不跑前端单测 |

**整体**：除「工程基础设施」外，把上表各模块（含「不计」的两行）逐行相加，合计 ✅ 460 / 🟡 18 / ❌ 7 / ⛔ 31，完成度约 **97%**（2026-10-20 代码编辑器与文档标签补上虚拟空格前为 ✅ 459 / 🟡 19 / ❌ 7 / ⛔ 31；补上选择边距与行压缩前为 ✅ 458 / 🟡 19 / ❌ 7 / ⛔ 31；2026-10-20 字符串引用窗口补齐前为 ✅ 456 / 🟡 21 / ❌ 7 / ⛔ 31，约 96%；2026-10-20 反编译与语言补齐前为 ✅ 440 / 🟡 28 / ❌ 16 / ⛔ 31，约 94%；2026-10-20 调试器补齐前为 ✅ 417 / 🟡 45 / ❌ 22 / ⛔ 31，约 91%；2026-10-19 程序集编辑与元数据/PE 视图补齐前为 ✅ 388 / 🟡 56 / ❌ 40 / ⛔ 31，约 86%；代码编辑器与文档标签补齐前为 ✅ 363 / 🟡 68 / ❌ 53 / ⛔ 30，约 82%；2026-10-18 命令行版补齐前按同一张表为 ✅ 352 / 🟡 66 / ❌ 53 / ⛔ 30；更早的审计记录曾写作 ✅ 334 / 🟡 75 / ❌ 74 / ⛔ 30，与当时的表不一致，本次按表重算）。这一行由上表直接求和，不再逐次增减维护。

### 1.2 按工作流看

| 工作流 | 可用程度 | 说明 |
|---|---|---|
| 打开程序集、浏览树、看 C# 代码、F12 跳转 | 日常可用 | 与 WPF 相同：树的选中显示在前面的标签，单击引用跟随、Ctrl+单击开新标签，每个标签有自己的后退/前进 |
| 看 IL / VB | 日常可用 | IL 与 WPF 同格式（分支反汇编器的移植，2026-10-20 起），操作码、操作数、标签都可跟随；VB 是 C# 的转换，成员与局部变量可跳转、高亮；两种视图都有语句表，能下断点、显示当前语句 |
| 搜索、分析引用 | 日常可用 | 两块是移植最完整的部分 |
| 改名、改元数据、增删成员 | 日常可用 | 五类成员的选项对话框与 WPF 逐页对齐 |
| 改方法体 | 日常可用 | C# 源码编辑（方法、类、类成员、程序集特性、合并）与方法体三页编辑器都在；IL 编辑器可增删局部变量与异常处理器，撤销覆盖导入 |
| 保存 | 日常可用 | 与 WPF 相同：Save Module 的五页写出选项，Save All 列出修改过的文档、有进度与取消；修改标记按保存点计算；新建的程序集与 NetModule 第一次保存时取得文件；退出时可「保存后退出」 |
| 调试 .NET (CoreCLR) 程序 | 日常可用 | 断点（含完整条件，C#/VB/IL 视图都能下）、单步（含跨 await）、Set Next Statement、调用栈；Locals/Autos/Watch 可求值、展开、改值；Memory 与 Disassembly；可同时调多个 CoreCLR 进程；不支持 Mono/Unity |
| 元数据表、Hex 修改 | 日常可用 | Hex 可滚动浏览、查找、复制、直接改字节并撤销，非 .NET 文件也能改写与保存；PE 头与元数据表是可编辑的表单与表格，表可排序、复制粘贴行；Hex 视图仍没有结构信息与 F12 |
| 脚本、批处理导出 | 部分可用 | GUI 的 Export to Project 与独立的 `dnSpy.Console` 共用后端的导出实现（见 4.4、4.17）；REPL 仍不能操作已打开的程序集 |

## 2. 跨模块问题

这些问题不属于某一个模块，但拉低了多个模块的完成度，修一处能同时改善好几块。

1. ~~**仍有一组选项页只保存、不生效。**~~ **已修复（2026-10-14）**：`DecompileRequest` 现在包含 `DecompilerSettingsDto` 字段，前端在调用反编译时会传递用户的 C#、IL 和 BAML 设置，后端通过 `DecompilerSettingsMapper` 应用这些设置。`DecompileFullType` 和 `UseMemoryMappedIO` 现在会被传递给后端。由于使用的是 NuGet 版 `ICSharpCode.Decompiler 11.1`，WPF dnSpy 分支特有的 C# 选项（`ShowTokenAndRvaComments`、`SortMembers` 等）在包里不存在；2026-10-20 起它们由 `BE/DnSpyCSharpOptions.cs` 写在包的输出上，只剩包不允许改写法的三项（见 4.4）。BAML 页（2026-10-20 起）与 IL 页全部生效。仍改了没效果的是：
   - Hex 编辑器的部分选项（文本编辑器的 Text Viewer 页已在 2026-10-19 全部由文档视图读取，2026-10-20 补上选择边距、行压缩与虚拟空格后全部生效，见 4.5；Hex 视图已应用当前行高亮、列分隔线、值/偏移大小写、分组、偏移格式、ASCII 编码与默认每行字节数；高亮当前值、结构高亮与滚动条页仍不生效，Memory 窗口仍只读其中的大小写与分组，见 4.7）、书签语法高亮、REPL；
   - General 的版本号与 PublicKeyToken 等程序集树页选项。

   Output 页的自动换行、行号、时间戳与时间格式（2026-10-17 起）、Environment › Font 页，以及调试器页与 Disassembler / Code Style 页（2026-10-17 起，经 `debug/setOptions` 交给引擎）已生效。

   此外 General 页的 `CheckForUpdatesOnStartup` 没有对应功能（⛔）。

2. ~~**Monaco 的 contrib 没有打包。**~~ 2026-10-19 已修：`FE/monaco.ts` 仍只导入 `editor.api`（整包导入曾让右键光标定位回归），按需加入 find、hover、bracketMatching 三个 contrib，Edit→Find、F3 与悬停都可用。折叠、单词高亮、Monaco 的缩放与 Go to Line 面板有意不加载：dnSpy 的文档视图没有折叠，高亮的是引用而不是单词，缩放与转到行另有照 WPF 的实现（见 4.5）。

3. ~~**VB 文档没有语句表，IL 的断点仍按 C# 下。**~~ 2026-10-20 已修：断点改为与 WPF 相同的 IL 位置（模块、方法标记、IL 偏移），每种视图按自己的语句表画在包含该偏移的语句上。C# 反编译生成引用 span 和语句到 IL 的映射（`BE/StatementIlRanges.cs`）；IL 视图（含 IL with C#）有逐指令的语句表、定义 span 与操作数引用 span；VB 是 C# 文本的转换，转换时在每条语句前插入标记注释、转换后按 VB 语法树取回位置（`BE/VisualBasicConversion.cs`），因此 VB 也有语句表，方法文档也不再变成空壳类（只转换成员时包进一个临时类，转换后再拆开）。三种视图里都能下断点、显示当前语句，搜索与分析器的跟随也按各自的语句表定位。IL 格式本身也已于 2026-10-20 对齐：输出改为 dnSpy 分支 `ReflectionDisassembler` 的移植（`BE/IL/`），有 `.try`、`.custom`、`.override` 等。

4. ~~**菜单上标了快捷键却没有绑定。**~~ 2026-10-14 已修：菜单上标出的快捷键都接上了——Ctrl+Alt+L、Alt+2、Ctrl+D（转到元数据标记，dnSpy 在树上和文档视图里都用这个键）、Ctrl+E Ctrl+W、Alt+Numpad*、Ctrl+Alt+P、Ctrl+Alt+Break、Ctrl+Alt+B/E/C/H/U/Z、Alt+4、Alt+8，Shift+Alt+Enter 不再被 Alt+Enter 的分支截住（原先还有个 WPF 没有的 F11 全屏，一并去掉），Ctrl+Tab 与 Ctrl+Shift+Tab 也补上了。十六进制视图后来补了自己的快捷键（Ctrl+G/M/L/F、F5、Ctrl+D/Ctrl+Shift+D、Ctrl+Alt+S 等，见 4.7）。主菜单现在可以用键盘操作。

5. **程序集树的多选只有部分命令用上。** 树已支持 Ctrl/Shift 多选和键盘扩选，Remove Assembly、删除类型与成员（2026-10-19 起，一步撤销）、保存资源、Search MSDN、分析（2026-10-16 起）、位置为「选中文件 / 同一文件夹 / 选中类型」的搜索作用于整个选区；多节点合并反编译（DocumentTreeNodeDecompiler）也已接上，选中多个节点时标签显示它们合在一起的文档（见 4.4）。

6. ~~**未保存修改的保护不完整。**~~ 2026-10-14 已修：有未保存修改时关闭窗口，主进程会拦下这次关闭并反问「是否要在继续之前保存？」（是 / 否 / 取消），取消则留在原地。Reload All 与移除程序集仍按 WPF 各自询问，措辞与本移植版的其它对话框一致。

7. ~~**图标与本地化。**~~ 2026-10-17 已补齐：主菜单、各右键菜单与工具窗口命令栏也换成 dnSpy 图标集（`dnSpy/dnSpy.Images` 的 XAML 矢量图转成 SVG，按 dnSpy 的 ThemedImageCreator 算法随主题背景换色），只剩 WPF 没有的加载动画仍是 lucide-react；界面语言与 WPF 一样 15 种，译文由各语言的 resx 生成（`scripts/generate-locales.mjs`），resx 里没有的移植版自有字符串回落英文。

## 3. 审计中发现的疑似缺陷

下表是审计过程中顺带发现的行为问题，不是缺失功能。「已核实」表示读代码确认了因果链，「代码推断」表示没有完整核实或依赖运行时行为。

| # | 问题 | 位置 | 依据 |
|---|---|---|---|
| 1 | ~~打开多个程序集时，File→Save / Save Module… 总是保存第一个模块~~ 已修复（2026-10-18）：`currentModule` 沿选中行的父链走到根行，并用模块行的路径匹配 `OpenedModule`；单测覆盖了「选中 B 程序集里的方法时保存 B」 | `FE/app-store.ts` 的 `currentModule` | 已核实 |
| 2 | ~~停止调试会杀掉附加的进程~~ 已修复（2026-10-17）：`stopDebug` 对附加的进程分离、对启动的进程终止，Debug 菜单另有 Detach All / Terminate All | `FE/app-store.ts` 的 `stopDebug` | 已核实 |
| 3 | ~~保存单个模块会清掉全局 `dirty`，即使其他模块仍有修改~~ 已修复（2026-10-19）：修改标记改为每个文档按保存点计算（dnSpy 的 `UndoObject.SavedCommand`），后端在每次提交、撤销、重做与保存后返回仍有修改的文档 | `BE/WorkspaceManager.Saving.cs`、`FE/app-store.ts` | 已核实 |
| 4 | ~~IL 编辑器从不重算 MaxStack~~ 已修复（2026-10-18）：方法体编辑器把 `KeepOldMaxStack` 原样传给 dnlib，不勾选时由 writer 重算栈深 | `BE/WorkspaceManager.MethodBody.cs` | 已核实 |
| 5 | ~~Raw Save Resource 与 Save Resource 写出相同的字节：主进程丢掉了 `raw` 参数~~ 已修复（2026-10-13）：改走 `resource/getItems`，`raw` 一路传到后端 | `MAIN/index.ts` 的 `edit:saveResource` | 已核实 |
| 6 | ~~PE-only、ELF、未知文件的 Open Hex Editor 读不出数据~~ 已修复（2026-10-18）：`GetHexLength` / `ReadHexAsync` 改走 `GetHexEntry`，按模块、树节点、PE-only、ELF、未知文件依次解析；2026-10-19 起各类文档都叠加 hex 补丁并可改写 | `BE/WorkspaceManager.cs` | 已核实 |
| 7 | 不属于任何成员的 Raw hex 补丁，保存时仍用原文件偏移；dnlib 重写文件后可能写错位置 | `BE/WorkspaceManager.cs` 保存时的补丁重定位 | 代码推断 |
| 8 | ~~C# Interactive 的 Reset 不能恢复不响应取消的脚本：`ResetAsync` 不释放执行信号量，后续提交排队到 600 秒 IPC 超时；被重置会话的旧输出仍会追加到日志~~ 已修复（2026-10-18）：会话各自持有执行锁、取消源与 generation；Reset 取消旧令牌并触发 `ScriptResetting` 后立即建立新会话，排队中的提交随旧令牌取消，旧会话的输出按 generation 丢弃。另：输出帧改为同步写入管道，避免单核机器上同步等待异步写造成的死锁 | `BE/Scripting/CSharpScriptService.cs`、`BE/JsonRpcServer.cs` | 已核实 |
| 9 | ~~基类型行不能分析：前端 `isAnalyzableNode` 不含 `basetype`，而后端已支持~~ 已修复（2026-10-16）：基类型行可分析，菜单打开前向后端确认引用能解析（WPF 的 CanAnalyze），解析不了的不显示「分析」 | `FE/components/CodeEditorContextMenu.tsx`、`FE/components/AssemblyExplorer.tsx` | 已核实 |
| 10 | ~~编辑器里单击引用时光标显示为手形，但只有 Ctrl+单击才跳转，而且在同一标签里跳（WPF 单击跳转，Ctrl+单击开新标签）~~ 已修复（2026-10-19）：照 `DocumentViewerMouseProcessor`，抬起时在同一字符上的单击在本标签跟随，Ctrl+单击开新标签，定义与局部变量要按住 Ctrl；e2e 覆盖 | `FE/components/DocumentView.tsx` 的 `onMouseUp` | 已核实 |
| 11 | ~~Merge with Assembly 总是失败：RPC `compiler/merge` 在 `JsonRpcServer` 里没有分发，落到 `MethodNotFound`~~ 已修复（2026-10-20）：补上分发 | `CrossPlatform/backend/dnSpy.Backend.Host/JsonRpcServer.cs` | 已核实 |
| 12 | ~~VB 视图在回退路径（以及 Edit Code 窗口的源码）上不带选项页的设置，按后端默认值反编译；GUI 的 VB 转换不套用命令行与工程导出用的转换修正，会写出 `MyBase._002Ector()`~~ 已修复（2026-10-20） | `BE/WorkspaceManager.cs` 的 `DecompileVisualBasicAsync`、`BE/VisualBasicConversion.cs`、`FE/components/EditCodeDialog.tsx` | 已核实 |

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
| 标签内容缩放 | `Tabs/TabElementZoomer.cs` | `FE/zoom.ts`、`FE/App.tsx` | ✅ | 档位表照搬 `ZoomSelector`（20%~400%），Ctrl+=/Ctrl+-/Ctrl+0 与 Ctrl+滚轮；作用于非文本标签（Hex、模块信息）的内容，文档视图按 Text Viewer 的 ZoomLevel 缩放文字（所有文档视图共用一份，见 4.5） |
| 会话恢复 | `Documents/Tabs/DocumentTabSerializer.cs` | `FE/app-store.ts` 的 `loadSession` | ✅ | RestoreTabs 选项已生效；光标与滚动位置已恢复 |
| 最近文件 | `Documents/Tabs/Commands.cs` | `file-menu.ts`、`rememberRecentFiles` | ✅ | 每个文件一条，见 4.3 |
| 打开列表 / 文件列表 | `Documents/Tabs/Dialogs/OpenDocumentListDlg.xaml`、`FileLists/*` | `OpenListDialog.tsx` | ✅ | 见 4.3 |
| 从 GAC 打开 | `Documents/Tabs/Dialogs/OpenFromGACDlg.xaml` | `OpenFromGacDialog.tsx` | ✅ | 见 4.3 |
| 主题 | `Themes/ThemeService.cs`、`Theme.cs`、`ColorInfos.cs`、`*.dntheme` | `FE/theme-service.ts`、`FE/themes.generated.ts`、`FE/monaco-theme.ts`、`MAIN/theme-files.ts`、`styles.css` | ✅ | 读 dnSpy 自带的四个 `.dntheme` 与 `Themes` 目录里的用户主题，颜色继承与默认值同 `Theme.cs`；界面按 WPF 资源键着色，代码视图的 Monaco 主题由主题生成；菜单与 General 页列出 `VisibleThemes`（高对比度主题只在系统高对比度时出现），系统高对比度切换时自动换主题并记下 |
| 界面语言 | `Culture/CultureService.cs` | `FE/localization.tsx`、`FE/locales/*`、`FE/locales.generated.ts`、`shared/ui-locales.ts` | ✅ | 15 种，与 WPF 的 resx 相同；译文由 resx 生成，resx 没有的条目回落英文；View → Language 为「System」加各语言本族语名称；原生对话框的字符串同样按语言 |
| Options 对话框框架 | `Settings/Dialog/AppSettingsDlg.xaml` | `OptionsDialog.tsx`、`options-pages.ts`、`app-options.ts` | ✅ | 框架完整；反编译器设置现已传递给后端并生效（见第 2 节第 1 条更新）；Output 页的自动换行、行号与时间戳生效；Text Viewer 页（2026-10-19 起）由文档视图读取；仍有页面不生效的是 Hex 编辑器等 |
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

与 WPF 仍有的差别都是本文其他模块记录的整体设计差异，不单独计入本节：不做单实例转发（4.1）；不建模内存模块（下表 ⛔ 行）。

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| 打开程序集（含 PE、未知文档） | `Documents/Tabs/Commands.cs`、`Dialogs/OpenDocumentsHelper.cs` | `file-menu.ts`、`MAIN/index.ts`，RPC `workspace/open`、`workspace/addModules` | ✅ | 另新增 ELF 文档。打开后选中最后一个文件的根行（OpenDocumentsHelper） |
| Open from GAC | `Documents/Tabs/Dialogs/OpenFromGAC*` | `OpenFromGacDialog.tsx`，RPC `gac/list`、`gac/getDetails` | ✅ | 搜索（多词、名称或版本）、显示重复、右侧详情、多选、双击打开；Ctrl+Shift+O。Linux 上列的是 Mono 的 GAC |
| Open List | `Documents/Tabs/Dialogs/OpenDocumentList*`、`DocumentListService.cs`、`DefaultDocumentList.cs` | `OpenListDialog.tsx`、`FE/document-lists.ts`，RPC `documentList/defaults`（`BE/DefaultDocumentLists.cs`） | ✅ | 命名列表存 localStorage；当前打开的文件随时记入选中列表；内置列表来自本机每个 .NET 共享框架版本。新建列表用内联输入框代替 WPF 的输入对话框 |
| 最近文件 | `Documents/TreeView/AssemblyExplorerMostRecentlyUsedList.cs`、`Documents/Tabs/Commands.cs` 的 `RecentFilesCommand` | `FE/app-store.ts` 的 `rememberRecentFiles`、`openRecentFile`，`file-menu.ts` | ✅ | 每个文件一条，最多 30 条，大小写不敏感去重，最近的在前；Open、Open from GAC、拖放（只记新加的）、命令行会记入，会话恢复和 Open List 不记。菜单项「序号 + 完整路径」，超过 100 字符保留末尾 100 个并加 `[...]`；点开只把该文件加进当前树并选中。旧版按整组记录的列表启动时迁移 |
| Reload All | `Documents/Tabs/DocumentListLoader.cs`、`AE/UndoRedo/UndoRedoDocumentListListener.cs` | RPC `workspace/reload`（`ReloadWorkspaceRequest`），`FE/App.tsx` 的 `reloadAll` | ✅ | 有未保存修改时用 dnSpy 原话询问；重新加载用户打开的文件，自动加载的文档只保留标签还在用的（仍标为自动加载）；随后按节点键恢复展开的分支、选中项和文档标签，Hex / 模块信息标签按文件恢复 |
| Close All / Sort Assemblies | `Documents/Tabs/Commands.cs`、`DocumentTreeView.cs` | RPC `workspace/sortAssemblies` | ✅ | |
| Close All Framework Assemblies / Missing Files | `AE/Commands/CloseAll*Command.cs` | RPC `workspace/getCloseCandidates` + `workspace/removeModules` | ✅ | 走 Remove Assembly：有未保存修改先询问是否保存，被移除文档的标签一并关闭 |
| Close Old In-Memory Modules / Disable MMF | `AE/Commands/CloseOldInMemoryModulesCommand.cs` | 隐藏 | ⛔ | 后端整读镜像，没有 MMF；Close Old In-Memory Modules 是 File 菜单的命令，2026-10-20 起可用，计在 4.12 |
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

完成度约 92%（✅ 22 / 🟡 4 / ❌ 0 / ⛔ 1），2026-10-20 补齐后按实现与测试复核。WPF 范围：`WPF/Decompiler/`、`WPF/Documents/Tabs/`（反编译相关）、`Extensions/ILSpy.Decompiler/`、`Extensions/dnSpy.BamlDecompiler/`、资源查看与导出项目。

后端没有沿用仓库里的 ILSpy 分支（子模块未检出，且基于旧版 NRefactory），而是用 NuGet 上的 `ICSharpCode.Decompiler 11.1`、`ICSharpCode.BamlDecompiler`。分支独有的部分逐一补在它上面：

- **IL**：分支的 `ReflectionDisassembler`、`MethodBodyDisassembler`、`ILStructure` 等与 dnSpy 的 `ILDecompiler`/`ILWithCSharpDecompiler` 移植到 `BE/IL/`（源码取自 dnSpyEx/ILSpy 与 dnSpy 本体），输出 `.try`/`.custom`/`.override`/`.data`、PDB 信息、IL 字节、token/RVA 注释与 XML 文档，IL 页 7 个选项全部生效，`MaxStringLength` 与 WPF 一样只在设置里不在页面上（DTO 有、默认 20000）。
- **C# 页的分支独有选项**：`BE/DnSpyCSharpOptions.cs` 的 `DnSpyDecompilerSettings` 随包的 `DecompilerSettings` 一起克隆传递，`DnSpyCSharpTransform` 作为最后一个 AST 变换照分支的 `AstBuilder` 写出：token/RVA 注释（属性、事件按访问器各一行，注释里的 token 与地址可点击）、成员顺序（UseSourceCodeOrder、SortMembers 与五级反编译顺序）、省略隐含的 `internal`/`private`、一行一个特性、十六进制数字、保留空的默认构造函数、System 命名空间在前的 using 顺序、全限定类型名仍写 using；InsertParenthesesForReadability 关闭时在渲染前去掉可读性括号。前端默认值改为分支的默认值（token 注释开、源码顺序、每行一个特性、写出 internal/private、十进制）。
- **VB**：仍由 `ICSharpCode.CodeConverter` 从 C# 文本转换。转换时套用与工程导出、命令行相同的修正（`VisualBasicConverterFixes`：nullable 特性、`MyBase._002Ector()`、ParamArray 与 Optional），访问修饰符照 WPF 的 `VBDecompiler` 一律写出，token 注释随之转换并保留 span。

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| C# 反编译 | `ILSpy.Decompiler/dnSpy.Decompiler.ILSpy.Core/CSharp/CSharpDecompiler.cs` | `BE/WorkspaceManager.cs` 的 `DecompileDocumentAsync`，RPC `document/decompile` | ✅ | 有引用 span 和语句表；分支独有选项见上 |
| Visual Basic | `.../VisualBasic/VBDecompiler.cs` | `BE/VisualBasicConversion.cs`、`BE/WorkspaceManager.VisualBasic.cs` | 🟡 | 是 C# 的转换而不是 VB 反编译器（WPF 的 VB 依赖分支的 NRefactory.VB）；经 Roslyn 重新绑定有引用 span，转换时用标记注释取回语句表；C# 页选项、转换修正与 token 注释都生效；转换失败时整篇只剩错误注释 |
| IL | `.../IL/ILDecompiler.cs` | `BE/IL/ILDecompiler.cs`、`ReflectionDisassembler*.cs` | ✅ | 分支反汇编器的移植；定义/引用/标签 span、逐指令语句表；工作区没有的类型与成员不能跟随，但仍按反汇编器给的颜色着色 |
| IL with C# | `.../Mixed/ILWithCSharpDecompiler.cs` | `BE/IL/ILWithCSharp.cs` | ✅ | 每条 C# 语句写在它的第一条指令之上，状态机的 MoveNext 按原方法显示 |
| ILAst | `.../ILAst/ILAstDecompiler.cs` | 无 | ⛔ | WPF 只在 DEBUG 构建注册 |
| 语言下拉与持久化 | `MainApp/ToolBarCommands.cs`、`Decompiler/DecompilerServiceSettings.cs` | `ToolBar.tsx`、`app-store.ts` 的 `changeLanguage` | ✅ | 全局语言：切换时重反编译所有已开标签（含正在加载的），新标签用它，记在 `localStorage`，`-l` 也写入；分析器、字符串引用窗口跟随 |
| C#/VB 反编译选项 | `ILSpy.Decompiler/dnSpy.Decompiler.ILSpy/Settings/CSharpDecompilerSettingsPage.cs` | `options-pages.ts` → `decompiler-settings.ts` → `BE/DecompilerSettingsMapper.cs`、`BE/DnSpyCSharpOptions.cs` | 🟡 | 23 项中 19 项与五级反编译顺序按分支语义生效；ForceShowAllMembers 只能展开自动属性/事件并保留空构造函数（包里编译器生成的类型与成员一律隐藏）；FullyQualifyAmbiguousTypeNames 关、AllowFieldInitializers 关、EmitCalliAsInvocationExpression 关这三种写法包不提供，仍按包的方式输出。Edit Code 窗口的源码也带上这些设置 |
| IL 选项 | `.../Settings/ILDecompilerSettingsPage.cs` | `options-pages.ts` → `ToILSettings` | ✅ | 7 项全部生效 |
| DecompileFullType | `Documents/Tabs/DocumentTabServiceSettings.cs` | RPC `document/resolveNode` | ✅ | 跟随成员时打开最外层类型；状态机的 MoveNext 跟到原方法 |
| 源码与 IL 的语句映射 | `Decompiler/MethodDebugService.cs` | `BuildCodeStatements`、`BE/StatementIlRanges.cs`、IL 的调试信息、VB 的标记注释 | ✅ | C#、IL、IL with C#、VB 都有；调试器的帧行号按带默认选项（含 token 注释）的方法文档计算 |
| 异步反编译与取消 | `Documents/Tabs/AsyncShowResult.cs` | `WaitAdorner.tsx`、`cancelDocument`、`system/cancel` | ✅ | 「正在反编译…」与取消按钮，取消令牌传到 ILSpy、转换器与 BAML |
| 反编译缓存 | `Documents/Tabs/DecompilationCache.cs` | `FE/decompilation-cache.ts` | ✅ | 按工作区、语言、节点与所读选项页缓存，30 秒清理、5 分钟过期；编辑后按受影响的模块清除；带附件的文档不缓存（CanBeCached） |
| 换语言或编辑后刷新 | `Documents/Tabs/RedecompileTabs.cs`、`DecompilerAppSettingsModifiedListener`、`BamlRefresher` | `changeLanguage`、`refreshAfterEdit`、`refreshDocumentsForOptions` | ✅ | C# 页改动刷新 C#/VB/IL with C#，IL 页刷新 IL/IL with C#，BAML 页刷新 BAML 文档 |
| 多节点合并反编译 | `Documents/Tabs/DocumentTreeNodeDecompiler.cs` | RPC `document/decompileNodes`、`DocumentConcatenation` | ✅ | 节点之间空一行；资源写简短形式；span、语句、附件随文本平移 |
| 程序集 / 模块节点输出 | `CSharpDecompiler.Decompile(AssemblyDef/ModuleDef)` | `BE/WorkspaceManager.NodeDocuments.cs` 的 `DecompileContainer` | ✅ | 与 WPF 一样只写头部注释（路径、全名、入口点、架构、运行时、时间戳）和本级特性（`AddAssembly` 的 onlyAssemblyLevel），不再反编译整个模块；VB 的特性经转换 |
| 命名空间节点输出 | `DecompilerBase.DecompileNamespace` | 同上 | ✅ | C#/VB/IL 都只列出类型名，每个是引用 |
| 其他非代码节点 | `Documents/Tabs/NodeDecompiler.cs` | `CommentDocumentLines`、`DecompileResourcesFolder`、`DecompilePEInfo` 等 | ✅ | 引用、基类型/派生类型文件夹、资源文件夹、PE/未知文件按 WPF 写注释 |
| Save Code | `Documents/Tabs/NodeTabSaver.cs`、`BamlTabSaver.cs` | `saveCode` | ✅ | BAML 标签的命令名为 Save XAML.../Save BAML...，文件名照 `GetFilename` 换扩展名 |
| Export to Project | `Documents/Tabs/Dialogs/ExportToProjectDlg.xaml` | `ExportToProjectDialog.tsx`、RPC `project/export`、`BE/ProjectExport/` | ✅ | 与 WPF 对话框字段一致；导出实现从 `dnSpy.Console` 移到后端与命令行共用，C# 页的分支独有选项与 BAML 页的排版同样作用于导出 |
| `.resources` 条目显示 | `Documents/TreeView/Resources/BuiltInResourceElementNodeImpl.cs` | `DecompileResourceEntry` | ✅ | 字符串显示文本，图片显示图片，文本数据按扩展名着色，其他写 `名称 = N bytes` 行 |
| 图片资源预览 | `Resources/ImageResourceNode.cs` 等 | 后端附件 + `FE/document-attachments.ts` | 🟡 | BMP/GIF/PNG/ICO/JPEG 与序列化 Bitmap/Icon、ImageListStreamer 可预览并保存；超过 8 MB 或 TIFF 等 WIC 能解而 Chromium 不能解的格式不显示，也没有提示 |
| 嵌入资源文本识别 | `ResourceUtilities.cs` | `TextDocument`、`Search/ResourceTexts.cs` | ✅ | |
| 保存资源 | `AE/Resources/ResourceCommands.cs` | RPC `resource/getItems` | ✅ | 与 4.3 重复计入；BAML 条目按 BAML 页存为 `.xaml` 或反汇编的 `.baml` |
| Go to Resource | `Documents/Tabs/ResourceCommands.cs` | 树右键、代码视图右键 | ✅ | 与 4.3 重复计入 |
| BAML → XAML | `BamlDecompiler/XamlDecompiler.cs`、`XamlOutputCreator.cs` | `DecompileBamlToXaml`、`BE/XamlOutputCreator.cs` | ✅ | 照 `XamlOutputCreator` 写出（无 XML 声明、制表符或四空格、每行一个特性、标记扩展不转义），工程导出同样如此 |
| Disassemble BAML | `BamlDecompiler/BamlDisassembler.cs`、`MenuCommands.cs` | `BE/Baml/`、代码视图右键「Disassemble BAML」 | 🟡 | 记录逐条写出、按颜色着色，记录间的 id 互相关联，类型与成员可跟随；没有悬停提示（WPF 的 BamlToolTipProvider），Linux 上没有 WPF 程序集，内置类型的 id 只是文字 |
| BAML 选项页 | `BamlDecompiler/BamlSettings.cs` | `options-pages.ts` → `BamlDecompilerSettingsDto` | ✅ | 三项全部生效，改动后刷新 BAML 文档 |

测试：后端 `CSharpDecompilerOptionsTests.cs`（分支独有选项的默认与各开关、token 注释的 span、VB 的 token 注释）、`DecompilerSettingsMapperTests.cs`、`ILDisassemblerTests.cs`、`NodeDocumentTests.cs`（程序集/模块/命名空间文档、多节点文档）、`BamlDisassemblerTests.cs`、`WorkspaceManagerTests.cs`（XAML 排版、反汇编、BAML 存盘名）、`WorkspaceResourceDocumentTests.cs`、`DecompilationConcurrencyTests.cs`；前端 `decompilation-cache.test.ts`、`CodeEditorContextMenu.test.tsx`（Disassemble BAML）、`DocumentTabContextMenu.test.tsx`（Save XAML/BAML）、`app-store.test.ts`（BAML 文件名）；e2e `app.spec.ts`（切换 IL、Save Code、保存资源）、`export-project.spec.ts`。

### 4.5 代码编辑器与文档标签

完成度约 100%（✅ 31 / 🟡 0 / ❌ 0 / ⛔ 1）。WPF 范围：`WPF/Text/`、`WPF/Documents/Tabs/`（DocViewer、导航历史）。编辑器是 Monaco，右键菜单为自绘的 `FE/components/CodeEditorContextMenu.tsx`。

2026-10-19 补齐后按实现与测试复核；2026-10-20 补上选择边距与行压缩后再次复核，同日补上虚拟空格与 Quick Info 的图标后第三次复核。此前这一节是 ✅ 4 / 🟡 13 / ❌ 13，补上的部分：

- **标签模型照 `DocumentTabService`**：树的选中（单击、键盘、右键）显示在前面的标签里，替换它的内容并记入这个标签的历史；双击/Enter 只把焦点交给标签（`NodeActivated`）。新标签只来自 Ctrl+T、标签菜单的 New Tab、树和代码视图的 Open in New Tab、Ctrl+单击、Ctrl+F12/Ctrl+Enter。文档一换进标签就显示为加载中，同一节点的第二次请求直接复用；启动页、Hex 标签也会被换成文档。
- **每个标签自己的导航历史**（`TabHistory`）：记文档、语言、光标与滚动位置；同一文档内的跳转（局部变量、文档里已有定义的成员）也入历史；Alt+←/Backspace 后退，Alt+→/Shift+Backspace 前进，工具栏按钮跟随前面的标签。
- **引用的跟随**（`DocumentViewerMouseProcessor`、`DocumentViewerControl.GoTo`）：左键在同一字符上抬起才算单击；无修饰键时单击成员引用在本标签跟随，定义与局部变量只放光标；Ctrl+单击一律开新标签（局部变量是复制当前文档并把光标放到声明上）；Shift/Alt 不算单击；Ctrl 按下时定义与局部变量也显示手形。跟随时先找本文档里的定义，有就只移光标；否则打开目标，DecompileFullType（默认开）时打开最外层类型，光标选中定义名（`MoveCaretToSpan` 的规则：落在尾部，尾部紧接另一引用时落在头部）。IL 的操作码引用打开 MS Docs 页面（`OpCodeReferenceHandler`）。
- **快捷键**（`DocumentViewerCommandInfoProvider`、`TextReferenceCommandInfoProvider`）：F12/Enter 跟随、Ctrl+F12/Ctrl+Enter 新标签、Tab/Shift+Tab 与 Ctrl+Shift+↓/↑ 在同一引用（或同组关键字）间循环、Alt+↓/↑ 在成员定义间移动、Esc 清掉高亮与选区。
- **后端补齐 dnSpy 输出写在文本旁边的数据**（`BE/WorkspaceManager.DocumentText.cs`）：每个引用的颜色类（静态/实例方法、字段、属性、事件、各类类型、泛型参数，`TextColors`）、局部变量与参数的身份（按 ILVariable 对象）和 Quick Info、写入标记（赋值左边、自增自减、out/ref）、块结构（照 `CodeBracesRangeFlags` 的块类型：命名空间、类型、值类型、接口、方法、构造、访问器、属性、事件、条件、循环、try/catch/finally、lock、using、fixed、switch、case、匿名方法、局部函数）、过程分隔线（多行成员体的结束括号所在行）与相关关键字组（if/else 链、循环与它的 break/continue、switch 与 case/default/goto case、try/catch/finally、一个函数的 return/yield）。IL 视图有类型与方法的块、方法结束与最后一个字段后的分隔线、操作码引用和局部变量/参数操作数的引用。
- **VB 文档有了引用**（`BE/WorkspaceManager.VisualBasic.cs`）：VB 是 C# 文本的转换，转换器不保留引用，于是把转换结果用 Roslyn 对模块及其引用的程序集编译一遍：外部成员按文档 ID 回到元数据（工作区外的模块给出文件与 token），文本自己声明的成员按所在类型链、名称与参数类型对回模块里的成员；局部变量/参数按符号身份相连，并有 VB 写法的 Quick Info（“(local variable) sum As Integer”）；块结构、过程分隔线与相关关键字（If/ElseIf/Else/End If、For/Next、Do/Loop、Select/Case、Try/Catch/Finally、Exit/Continue/Return）来自 VB 语法树；名字的颜色来自 dnSpy 的 Roslyn 分类器。
- **Monaco contrib**：`FE/monaco.ts` 仍只导入 `editor.api`，按需加入查找、悬停、括号匹配三个 contrib；折叠、单词高亮、Monaco 自己的缩放与 Go to Line 面板不加载（dnSpy 没有或另有实现）。
- **其余编辑器能力**：引用高亮（定义、写入、读取三种主题色）与相关关键字高亮、Quick Info 悬停、Go to Line（Ctrl+G，dnSpy 的“行 [, 列]”与提示文字）、增量搜索（Ctrl+I/Ctrl+Shift+I）、块结构线（按主题的 BlockStructure* 颜色与选项里的虚线样式）、过程分隔线、所有文档视图共用并持久化的缩放（缩放框、Ctrl+滚轮、Ctrl+Shift+./Ctrl+=/Ctrl+小键盘+ 等）、显示空白（Ctrl+Shift+8、Ctrl+R Ctrl+W、Ctrl+E S）、带 HTML 的复制（无选区时复制整行，超过 1 MiB 只写纯文本）。
- **选择边距与行压缩（2026-10-20）**：dnSpy 的 `SpacerMargin` 是行号与文字之间 10 像素的空白条，`LeftSelectionMargin` 让按下（及随后的拖动、Shift）选择整行；Monaco 的行号本来就会选中整行，于是文档视图只在选择边距开启时把行装饰条加宽 10 像素，把那一段变成可点的选择边距，书签标记仍留在右侧 14 像素里。行压缩照 `LineCompressor` 分类（先看中间字符、超过 150 字符的行不动、全空白行与无字母数字行两类），命中的行用 Monaco 0.57 的逐行 `lineHeight` 装饰画成 75% 高；会折行的行不压缩，选项或布局变化时重算。Monaco 的命中测试、滚动与块结构线都读实际行高，所以压缩后光标与线都仍对得上。
- **虚拟空格（2026-10-20，`FE/virtual-space.ts`）**：Monaco 没有越过行尾的位置（microsoft/monaco-editor#919），于是照 dnSpy 的 `VirtualSnapshotPoint` 在 Monaco 的光标旁另记「行尾之后的虚拟空格数」（光标与选区锚点各一份），Monaco 的光标留在行尾、按空格宽度右移画出。照 `EditorOperations`/`TextCaret` 的规则：在行尾之后按下（及拖动、Shift、右键）把光标放到按下处（`Math.Round(距离 / 空格宽)`）；→ 在行尾继续进入虚拟空间而不换行，← 在虚拟空间里逐格退回、在行首不再退到上一行，无 Shift 时有选区先收拢到选区的尾/头；↑↓/PageUp/PageDown 保持光标的屏幕列（`preferredXCoordinate`，制表符取较近的一侧），短行落在虚拟空间；Home/End 回到真实位置；Esc 只清选区、光标留在虚拟空间。选区伸进虚拟空间的部分照 `MarkerHelper` 画成选区色的一段；光标越过最长行时视图的横向滚动范围随之加宽（`ViewportLeft` 的最大值含 `Caret.Right`）。虚拟空间里没有引用（`GetCurrentSpanReference`）：不高亮引用与关键字、F12/Enter/Tab/Ctrl+Shift+R 不动作、不匹配括号（`BracePairService`）。标签历史与会话恢复按 `CaretVirtualSpaces` 记下虚拟空格（列号超出行尾的部分）。选项与 Word wrap 照 `GeneralAppSettingsPageBase` 互斥，Word wrap 开着时不启用虚拟空格。
- **Quick Info 的图标（2026-10-20）**：照 `CodeToolTipProvider.SetImage`，成员的提示在签名前画它在树里的图标（后端 `DocumentQuickInfoResponse.Image`，即 `DotNetImages.Of`），局部变量、参数、数字分别画 LocalVariable、Parameter、ConstantPublic，按悬停框的背景着色；操作码没有图标，与 WPF 相同。
- **文档视图不再带 Monaco 的 sticky scroll 留白（2026-10-20）**：sticky scroll 的贡献虽未加载，它默认开着的选项仍让每次光标移动在光标下方留出 5 行，↑↓ 在视图中部也会滚动；现已关闭，光标只在将要离开视图时才滚动，与 dnSpy 的 `EnsureVisible` 相同。
- **Text Viewer 选项页的设置都由 `DocumentView` 读取**：自动换行（默认开，与 WPF 相同，View 菜单与 Ctrl+E W 改的就是它）、行号、高亮当前行、滚动条、制表符宽度、引用高亮、相关关键字、括号高亮、过程分隔线、块结构线与样式、行距、指示器边距、鼠标滚轮缩放、缩放框、选择边距、行压缩、虚拟空格。

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| 打开节点的标签模型 | `Documents/Tabs/DocumentTabService.cs` | `FE/App.tsx` 的 `addDocumentTab`、`showSelectedNode` | ✅ | 树的选中显示在前面的标签；多选时显示它们合在一起的文档（DocumentTreeNodeDecompiler，见 4.4） |
| 单击 / Ctrl+单击引用 | `DocViewer/DocumentViewerMouseProcessor.cs` | `DocumentView.tsx` 的 `onMouseDown`/`onMouseUp` | ✅ | 缺陷 #10 已修 |
| F12 / Ctrl+F12 / Enter | `Text/Editor/TextReferenceCommandInfoProvider.cs`、`DocViewer/DocumentViewerCommandInfoProvider.cs` | `DocumentView.tsx` | ✅ | 含 Ctrl+Enter |
| 跳转落点 | `Documents/Tabs/TreeNodeReferenceDocumentTabContentProvider.cs`、`DocViewer/DocumentViewerControl.cs` | `App.tsx` 的 `followReference`、`CaretReveal.definitionNodeId` | ✅ | DecompileFullType 打开最外层类型；文本里没有写出的成员（如自动属性的后备字段）光标留在开头，与 WPF 相同 |
| 引用指向未加载模块时按需打开 | `Documents/Tabs/DocTabReferenceNavigator.cs` | RPC `document/findMember` | ✅ | |
| IL/VB 引用、局部变量与参数引用 | `DocViewer/DocumentViewerDotNetSpanMap.cs` | `SpanTextOutput`、`ILFormatter`、`WorkspaceManager.VisualBasic.cs` | ✅ | VB 中被转换器改名的成员（只差大小写而改名的字段等）对不回元数据，没有引用 |
| 引用高亮、相关关键字高亮 | `DocViewer/DocumentViewerHighlightReferencesTagger.cs` | `FE/document-viewer.ts`、`DocumentView.tsx` | ✅ | |
| 在引用间移动（Tab、Ctrl+Shift+↑↓、Alt+↑↓） | `DocViewer/DocumentViewerCommandTargetFilter.cs` | `document-viewer.ts` 的 `nextReference`、`nextDefinition` | ✅ | |
| Quick Info 悬停 | `Documents/Tabs/DocViewer/ToolTips/*` | `FE/document-editor.ts`、RPC `document/quickInfo` | ✅ | 成员按文档语言（C#/VB/IL）写签名并附 XML 文档摘要（找模块旁、文化子目录与 .NET 参考包）；局部变量、操作码、数字（四种进制）；签名前照 `CodeToolTipProvider` 画成员、局部变量、参数或常量的图标（2026-10-20 起） |
| 后退 / 前进 | `Documents/Tabs/NavigationCommands.cs`、`TabHistory.cs` | `App.tsx` 的 `stepHistory` | ✅ | 每个标签一份，记光标与滚动 |
| 查找 / F3 | `Text/Editor/Search/SearchService.cs` | Monaco find contrib、`editor-registry.ts` | ✅ | 文档只读，与 WPF 一样没有替换 |
| 增量搜索 | `Text/Editor/Search/SearchService.cs`（IncrementalSearch） | `DocumentView.tsx` 的 `startIncrementalSearch` | ✅ | 键入的文字显示在视图上方一行，WPF 显示在查找框里 |
| 转到行 | `Text/Editor/GoToCommand.cs` | `EditDialogs.tsx` 的 `GoToLineDialog` | ✅ | “, 列”在 WPF 因正则判断失误不可用，这里按其本意可用 |
| 折叠 / 大纲 | — | Monaco 折叠关闭 | ⛔ | WPF 的文档视图没有折叠（无 outlining 边距），此前列在 `BlockStructureService` 名下是误列 |
| 块结构线 | `Text/Editor/BlockStructureService.cs` | `DocumentView.tsx` 的 `drawBlockStructure` | ✅ | |
| 括号匹配 | `DocViewer/BracePairService.cs` | Monaco bracketMatching | ✅ | 按词法配对；“Highlight braces”选项控制 |
| 方法分隔线 | `DocViewer/LineSeparator*` | `line-separator` 整行装饰 | ✅ | |
| 缩放 | `Text/Editor/ZoomControlMargin.cs` | `DocumentView.tsx` 的 `ZoomControl`、`document-viewer-options.ts` | ✅ | 缩放框在视图上方一行的右端（WPF 在底部边距），以免占用文字区高度；非文本标签仍按 `TabElementZoomer` 整体缩放 |
| 行号 | `Text/Editor/LineNumberMargin.cs` | Monaco `lineNumbers` | ✅ | |
| 高亮当前行 | `DocViewer/Commands.cs` | `renderLineHighlight` | ✅ | |
| 自动换行 | `DocViewer/Commands.cs` | `documentViewer.general.wordWrap` | ✅ | 与选项页同一个设置 |
| 显示空白 | `Text/Editor/DefaultTextEditorCommandInfoProvider.cs` | `useVisibleWhitespace` | ✅ | |
| 带格式复制 | `Text/Editor/CopyWpfTextViewCreationListener.cs` | `FE/document-clipboard.ts` | ✅ | 纯文本 + HTML，颜色取视图显示的颜色 |
| 语法着色 | `DocViewer/DecompilerTabContentClassifierContext.cs` | 引用的 `tc-*` 装饰叠在 Shiki/Monarch 词法着色上 | ✅ | |
| 文本编辑器选项与字体 | `Text/Settings/*`、`DocViewer/Settings/*` | `DocumentView.tsx` | ✅ | Text Viewer 页的设置都生效；2026-10-20 起补上选择边距（10 像素空白条，点击/拖动选择整行）、行压缩（`LineCompressor` 的 75% 行高，Monaco 逐行 `lineHeight` 装饰）与虚拟空格（下一行） |
| 虚拟空格（Use virtual space） | `Text/Editor/TextCaret.cs`、`Text/Operations/EditorOperations.cs`、`Text/Editor/MarkerHelper.cs` | `FE/virtual-space.ts`、`DocumentView.tsx` | ✅ | 2026-10-20 起：Monaco 无此能力（microsoft/monaco-editor#919），由视图在 Monaco 光标旁另记虚拟空格数并按 dnSpy 的规则处理鼠标、方向键、↑↓ 的首选列、选区与横向滚动；虚拟空间里没有引用；标签历史与会话恢复记下虚拟空格；与 Word wrap 按 WPF 互斥 |
| 右键 Open in New Tab / Copy Token / Full Name / MSDN | `TabCommands.cs` 等 | `CodeEditorContextMenu.tsx` | ✅ | Open in New Tab 的手势文字照 WPF 写 Ctrl+Click |
| 右键 Go to Token / Entry Point / Resource | `GoToTokenCommand.cs`、`EntryPointCommands.cs`、`ResourceCommands.cs` | `CodeEditorContextMenu.tsx` | ✅ | 入口点与 `<Module>` 构造只在模块有它们时出现；Go to 命令在前面的标签里跟随，树的选中随之而动 |
| 标签右键与快捷键 | `Documents/Tabs/TabCommands.cs` | `DocumentTabContextMenu.tsx` | ✅ | 与 4.1 重复计入 |
| 标签组与 Window 菜单 | `Tabs/TabGroupService.cs` | `FE/App.tsx` | ✅ | 与 4.1 重复计入 |
| 会话恢复标签 | `Documents/Tabs/DocumentTabSerializer.cs` | `buildSession`、`loadSession` | ✅ | 每个标签恢复成自己的标签，含语言、光标与滚动；与 4.1 重复计入 |
| Show Code | `Documents/Tabs/Commands.cs` | `showCode` | ✅ | 只把焦点交给前面的标签（F7、Esc、Ctrl+Alt+0），不再切换语言 |

测试：后端 `DocumentViewerDataTests.cs`（C# 的局部变量身份、写入、颜色、块、分隔线与关键字组，IL 的操作码与块，VB 的成员与局部变量引用、块与关键字，Quick Info 的三种语言写法、成员图标与操作码）；前端 `document-viewer.test.ts`（命中测试、同一引用、高亮种类、Tab/Alt 移动、光标落点、Go to Line 解析、块结构线、行压缩分类、数字提示、操作码地址、复制 HTML）、`virtual-space.test.ts`（屏幕列、首选列的落点与制表符、按下处的虚拟空格数、虚拟空间里的选区段）、`CodeEditorContextMenu.test.tsx`（Open in New Tab 手势、令牌组的三个 Go to、增量搜索）、`OptionsDialog.test.tsx`（虚拟空格与 Word wrap 的互斥）；e2e `app.spec.ts`（引用高亮与 Tab、单击/Ctrl+单击跟随与 Alt+← 后退、Quick Info 与数字提示、Go to Line、缩放框、块结构线与分隔线、增量搜索、F12 与标签历史、Ctrl+T 后树的选中进入新标签、空白行压缩与选项开关、选择边距整行选择、虚拟空格里的按下/→/←/↓/Shift 选区/Esc 与选项关闭、↓ 不滚动视图、Quick Info 的图标）。

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

完成度 100%（✅ 21）。WPF 范围：`AE/Hex/Nodes/`、`AE/Hex/PE/`、`WPF/Metadata/`、`WPF/Disassembly/`。ELF 结构视图和右键「Module Information」是移植版新增的，不计入。

2026-10-19 随 4.12 补齐 PE 与元数据结构的编辑（此前约 38%：✅ 7 / 🟡 2 / ❌ 12）：PE 结构节点、表流、元数据表与表行打开的不再是文本，而是 WPF 的字段表单与表格；字段经 hex 补丁写入，撤销与保存与其他编辑一致。本机反汇编随调试器（4.13）在 2026-10-17 实现、2026-10-20 改为文档标签，这里的三行随之更新。

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| 托管模块下的 PE 节点 | `AE/Hex/Nodes/PETreeNodeDataProvider.cs` | `GetPEChildren` | ✅ | |
| 本机 PE 文件的 PE 节点 | 同上 | `GetPeDocumentChildren`、`BE/PeOnlyModuleEntry.cs` | ✅ | |
| PE 节点整体文档 | `AE/Hex/Nodes/PENode.cs` | `AppendPeStructures` | ✅ | |
| DOS / File / Optional 头 | `AE/Hex/Nodes/ImageDosHeaderNode.cs` 等 | `BE/PeStructureFormatter.cs` | ✅ | |
| 节表头 | `AE/Hex/Nodes/ImageSectionHeaderNode.cs` | 同上 | ✅ | |
| COR20 头 | `AE/Hex/Nodes/ImageCor20HeaderNode.cs` | 同上 | ✅ | |
| Storage Signature / Header / 流 | `AE/Hex/Nodes/Storage*Node.cs` | 同上 | ✅ | |
| 字段网格与就地编辑 | `AE/Hex/Nodes/HexDocumentTabContent.cs`、`AE/Hex/PE/HexField.cs` | `HexStructureView.tsx`，RPC `hex/getStructure`；`BE/PeHexStructures.cs`、`BE/HexStructures.cs` | ✅ | 每个字段一行：偏移、名称、值框（`SimpleTypeConverter` 格式，字符串为带引号的字面量），Flags 字段下列出位域（复选框或下拉框）；失去焦点或回车时写入，撤销后重读 |
| #~ 表流头 | `AE/Hex/Nodes/TablesStreamNode.cs` | 节点 `tablesstream`，同上 | ✅ | Heaps、Valid、Sorted 位域与各表行数 |
| 元数据表节点 | `AE/Hex/Nodes/MetadataTableNode.cs` | 节点 `metadatatable` | ✅ | 标签 `02 TypeDef (12)`，只列有行的表 |
| 元数据表视图（行×列） | `AE/Hex/PE/MetadataTableVM.cs` | `MetadataTableView.tsx`，RPC `metadata/getTable`、`metadata/getTableRows` | ✅ | RID、Token、Offset、各列与 Info 列；按视口分页读取，单元格可改，扩展多选 |
| 元数据行节点 | `AE/Hex/Nodes/MetadataTableRecordNode.cs` | 节点 `metadatarecord`，`HexStructureView.tsx` | ✅ | 标签带 WPF 的 Info（如 `2 - Library - SearchTarget`）；表单的每列附列说明与标志位域 |
| Sort Table / Sort Selection | `AE/Hex/MDTableContextMenuCommands.cs` | RPC `metadata/sortTable`（移植 `TableSorter`） | ✅ | 排序结果作为一次补丁写回 |
| Go to RID | 同上 | `AskDialog` | ✅ | Ctrl+G；校验同 `SimpleTypeConverter.ParseUInt32(s, 1, rows)` |
| MD 表 Show in Hex Editor | 同上 | `showHexAt` | ✅ | 连续选区才可用 |
| MD 表 Copy as Text / Copy / Paste | 同上 | RPC `metadata/tableText`；剪贴板十六进制 | ✅ | 粘贴按 `ClipboardUtils` 解析，必须是整行且落在表内 |
| Go to MD Table Row | `AE/Hex/Commands.cs` | RPC `metadata/findRecord` | ✅ | Ctrl+Shift+D 询问标记；Shift+Alt+R 去选中行自己的标记；不存在的标记按 WPF 报错 |
| PE 结构节点 Show in Hex Editor | 同上 | `HexTargetResponse.Structure` / `StructureData` | ✅ | 结构自身的字节，以及节表头与流头的「Show Data in Hex Editor」 |
| 本机反汇编查看器 | `WPF/Disassembly/Viewer/*`、`DBG/dnSpy.Debugger/Disassembly/*` | `DebugNativeWindows.tsx` 的 `DisassemblyDocumentView`；`CDS/CorDebugSession.Native.cs`（Iced） | ✅ | 与 WPF 一样是以方法名命名的只读文档标签，按主题的汇编颜色着色，可选择、复制、查找；内容来自停住的进程（JIT 后的代码），与 4.13 重复计入 |
| Disassembler 选项页 | `WPF/Disassembly/Viewer/DisassemblyAppSettingsPage.cs` | `options-pages.ts`，经 `disassemble` 请求交给引擎 | ✅ | 地址、字节、IL、源码注释、基本块间空行、标签等开关都生效 |
| Code Style（MASM/NASM/GAS） | `WPF/Disassembly/X86/*` | `options-pages.ts`，`CDS/CorDebugSession.Native.cs` 的 Iced 格式化器 | ✅ | 各方言的 Code Style 选项都交给 Iced 的格式化器 |

`docs/linux-release-1.0.md` 中的「ECMA-335 Metadata Tables」在 2026-10-19 之前实际只是 Module Information 里的各表行数，现在有了完整的表视图。

测试：后端 PE 结构 5 条、ELF 5 条、`WorkspaceMetadataStructureTests.cs` 13 条；前端 `HexStructureView.test.tsx`、`hex-fields.test.ts`；e2e `pe-structure.spec.ts`（结构表单、字段改写与撤销、表格、Go to RID、Go to MD Table Row）、`elf-structure.spec.ts`。

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
| 跟随结果（含方法体内定位） | `SearchService.FollowResult` | `SearchPane.tsx`、`findSearchResultCaret` | ✅ | C# 与 VB 定位到语句起点（VB 的语句表见第 2 节第 3 条），IL 定位到那条指令（IL 视图的语句即指令） |
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
| 显示方法内的引用 | `AnalyzerService.GoTo` | `findReferenceCaret` | ✅ | C# 定位到语句里对目标的引用；IL 定位到那条指令的操作数（IL 视图现有操作数引用 span）；VB 按语句表定位到所在语句（见第 2 节第 3 条） |
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

完成度 100%（✅ 22）。WPF 范围：`Extensions/dnSpy.StringSearcher/`。2026-10-16 按实现与测试复核：此前标的 100% 那一版后端编译不过（`WorkspaceManager.StringReferences.cs` 十几处错误）、前端引用了未安装的 `react-i18next`、树右键入口恒不可见，已整体重写。2026-10-20 补齐剩余两项：来源列按工具栏语言书写；IL/VB 视图有了语句表（见第 2 节第 3 条）后，跟随 ldstr 在三种视图里都定位到语句，并有 e2e 实测。

跨平台实现：`BE/WorkspaceManager.StringReferences.cs`（扫描、来源格式化、跟随目标、`StringLiteralFormatter` 即 WPF 的 `StringFormatter`；`ReferrerWriter` 即 WPF 的 `Context.Decompiler.Write`，按语言选 `CSharpMemberFormatter` 或 `VisualBasicMemberFormatter`），RPC `stringReferences/search` 与进度通知 `stringReferences/progress`；`FE/string-references-store.ts`（扫描、刷新、跟随工作区）、`FE/string-references-model.ts`（过滤与 WPF 各比较器）、`FE/components/StringReferencesPane.tsx`、`StringReferencesContextMenu.tsx`。

| 功能点 | WPF 来源 | 状态 | 备注 |
|---|---|---|---|
| 树右键与编辑菜单入口 | `Commands.cs` | ✅ | 选中项里有 .NET 模块中的行时出现（`GetModule()`），打开窗口、焦点进搜索框、扫描 |
| 工具窗口 | `StringReferencesToolWindowContent.cs` | ✅ | 停靠在工具窗口区；关掉后由命令重新打开 |
| 扫描所选节点所在程序集的全部模块 | `StringReferencesService.Analyze` | ✅ | 含 netmodule；记住扫过的模块供刷新 |
| 未扫描时，在搜索框输入或改选项即扫描树的选中项 | `StartSearchIfNotStarted` | ✅ | |
| IL ldstr（每条一行，带 IL 偏移） | `ILStringReference.cs` | ✅ | 空字符串不列 |
| 常量（字段、属性、参数默认值） | `ConstantStringReference.cs` | ✅ | |
| 自定义特性参数 | `CustomAttributeStringReference.cs` | ✅ | 构造参数（Argument #n）、命名参数、数组逐项；模块、程序集、类型、方法、字段、属性、事件、参数（含返回值）、泛型参数上的特性。字段等成员的特性按 WPF 归在类型名下，跟随仍到成员本身 |
| 按当前反编译器隐藏编译器生成成员 | `Decompiler.ShowMember` | ✅ | C#/VB 隐藏 lambda、状态机等，IL 全部列出；C#/VB 打开「显示隐藏的编译器生成类型和方法」（`ForceShowAllMembers`）时也全部列出，与 WPF 一样在下次扫描时生效；切换语言自动重扫 |
| 子串过滤 | `ApplyFilter` | ✅ | 绑定延迟 100 ms，与 WPF 相同 |
| 区分大小写 | `SearchCaseSensitive` | ✅ | |
| 正则表达式 | `SearchIsRegex` | ✅ | 非法模式时保留原过滤、搜索框标红并在提示里写原因。用的是 JavaScript 正则，个别 .NET 专有语法不同 |
| 按格式化后的字符串匹配 | `SearchMatchFormattedString` | ✅ | |
| 四列（种类、文本、来源、模块） | `StringsControl.xaml` | ✅ | WPF 的列序与列宽；字面量按普通/逐字字符串着色，来源带容器图标与语法着色，「parameter」「attribute」「generic」等用 dnSpy 的灰色并随界面语言翻译 |
| 来源列随当前语言格式化 | `Decompiler.Write(...)` | ✅ | 用 WPF `StringReference.DefaultFormatterOptions` 的选项，经所选反编译器的 `Write`：VB 用 VB 格式化器（`Function Holder.Greet([String])+IL_0000`、`Holder.Constant As String`），C#、IL 与 IL with C#（两者不重写 `Write`）用 C# 格式化器；特性类型与泛型参数也经同一格式化器（WPF 的 `Write(IMemberRef)`）。请求带上语言，切换语言即重扫重写 |
| 列头排序 | `StringsControlVM.UpdateSortDescriptions` | ✅ | 升序 → 降序 → 还原；无排序时按种类、令牌、IL 偏移；文本与来源列忽略大小写，模块列只在 IL 行之间比模块（照 WPF 的 `ModuleComparer` 写法） |
| 列拖动重排与调整列宽 | `GridView AllowsColumnReorder` | ✅ | |
| 跟随（双击、Enter，Ctrl/Shift 新标签） | `FollowReference` | ✅ | ldstr 按当前视图的语句表定位到包含该 IL 偏移的语句起点（WPF `FindByCodeOffset` 后 `MoveCaretToPosition`）：C# 的 `return "Hello, " + name;`、VB 的 `Return "Hello, " & name`、IL 的 `ldstr` 指令行 |
| 右键菜单 | `Commands.cs` | ✅ | 复制字符串文本（格式化，Ctrl+C）/（原始）；转到代码中的引用 / 在新标签页中转到 |
| Ctrl+C 复制格式化文本 | `StringSearcherCommandLoader` | ✅ | |
| 刷新按钮 | `RefreshCommand` | ✅ | 有已扫描模块时重扫，否则扫描树的选中项 |
| 自动刷新 | `DocumentModified`、`CollectionChanged`、`DecompilerChanged` | ✅ | 编辑、撤销/重做、重载、增删程序集、切换语言时重扫；移除的模块自动剔除；关闭工作区清空 |
| 设置持久化（3 项） | `StringReferencesSettingsImpl` | ✅ | 存在应用选项里 |

扫描在工作区锁内按类型分片进行，结果分批推送到列表（对应 WPF 边扫边加），新扫描会取消正在进行的那次。

测试：后端 `WorkspaceStringReferencesTests.cs` 14 条（夹具 `backend/tests/StringTarget`：三类来源与来源文字、按语言书写来源（VB 与两种 IL）、字面量格式化规则、编译器生成成员、跟随目标、整程序集扫描、按模块刷新、分批结果与一次扫描一致）；前端 `string-references-model.test.ts`（排序与过滤）、`string-references-store.test.ts`（扫描、批次、取消、刷新、跟随工作区、请求带语言、`ForceShowAllMembers`）、`StringReferencesPane.test.tsx`（列、过滤延迟、非法正则、排序、列重排、跟随与复制、右键菜单、焦点）、`AssemblyExplorerContextMenu.test.tsx` 与 `MenuBar.test.tsx` 的入口；e2e「the String References window」2 条，新增「writes its rows in the language the toolbar picks and follows an ldstr to its statement in each view」覆盖 C#→VB→IL 的来源列重写与三种视图里光标落到语句行（去掉定位调用时该条失败）。2026-10-20 本机真实构建后：后端 617、前端单测 1454、e2e 107 通过 3 跳过，全绿。

### 4.12 程序集编辑（AsmEditor）与保存

整体完成度 100%（✅ 71 / ⛔ 1）。WPF 范围：`Extensions/dnSpy.AsmEditor/` 全部子目录。2026-10-20 随调试器的内存模块补上 Close Old In-Memory Modules（此前 ⛔）。

2026-10-19 补齐全部剩余差距后按实现与测试复核（2026-10-18 时约 82%：✅ 52 / 🟡 11 / ❌ 7 / ⛔ 2；更早约 53%：✅ 31 / 🟡 11 / ❌ 27 / ⛔ 2）。前两轮补上的主体（方法体三页编辑器、资源编辑、Edit Assembly / Module、C# 源码编辑、写出选项）见各表；2026-10-19 这一轮补上的是：

- **文档与保存点**（`BE/WorkspaceManager.Saving.cs`、`BE/HexPatches.cs`）：撤销历史的每一步有 dnSpy 的命令编号，文档记下保存时所在的那一步（`SavedHistoryId`），撤销/重做回到保存点即恢复为未修改；只写过字节的文档按 dnSpy 保存 hex 缓冲区的方式写出（原文件 + 补丁），原地保存后补丁覆盖过的原字节留作基底，保存后再撤销仍显示原值。
- **保存窗口**（`FE/components/SaveModuleOptionsDialog.tsx`、`SaveModulesDialog.tsx`）：Save Module 的 Main / MD Writer Options / Metadata / Cor20 / PE 五页与 WPF 的 `SaveModuleOptionsVM` 字段一一对应（含 PE 头、元数据头与各堆、Cor20 覆盖值与混合模式），hex 文档只有文件名；Save All 列出全部修改过的文档，有文件与总进度、日志、取消；退出时询问「保存后退出」。
- **新建文档**（`BE/WorkspaceManager.Documents.cs`）：Create Assembly、Create NetModule、Add New / Add Existing NetModule to Assembly、Remove NetModule from Assembly；新建的文档在保存前没有文件（没有 PE 节点与 hex 视图），第一次保存时取得所存的文件。
- **指令列表与操作数**（`FE/components/MethodBodyDialog.tsx`、`il-body-clipboard.ts`、`IlOperandDialogs.tsx`）：WPF 列表的右键菜单与快捷键，Cut/Copy/Paste（跨方法、跨模块粘贴时导入成员引用并带上局部变量）、复制为文本；TypeSpec、MethodSig（calli）、MemberRef、MethodSpec 四个操作数窗口。
- **Copy IL Bytes**（`BE/WorkspaceManager.IlBytes.cs`）：代码视图选中的语句按 dnSpy 的读取器编码，方法改过时未知字节写作 `??` 并给出 WPF 的提示。
- **编译器设置**（`options-pages.ts` 的 Compiler 页、`BE/WorkspaceManager.Compiler.cs`）：C# 与 VB 的条件编译符号、优化、溢出检查、unsafe、Option Explicit/Infer/Strict/Compare、嵌入 VB 运行时；编辑窗口随所选语言用 C# 或 VB 编译。
- **图像资源**（`BE/ImageResources.cs`、`FE/components/ImageResourceDialogs.tsx`）：序列化的 Bitmap/Icon 与装着图片文件的字节数组/流用 `ImageResourceElementDlg` 编辑；ImageListStreamer 用 `ImageListDlg` 编辑（色深、透明色、尺寸、图片列表的增删改与上下移），`image-list-streamer.ts` 照 WinForms 与 comctl32 读写其数据；Create System.Data.Bitmap/Icon Resource 与 Create System.Windows.Forms.ImageListStreamer Resource 两个命令。
- **PE 与元数据结构**（`BE/PeHexStructures.cs`、`BE/MetadataHexStructures.cs`、`BE/WorkspaceManager.MetadataStructures.cs`、`FE/components/HexStructureView.tsx`、`MetadataTableView.tsx`）：PE 头、节表头、Cor20、存储头/流头、表流头与元数据行按 WPF 各 `*VM.cs` 的字段与位域显示成表单，表是逐行按需读取的网格；改动都是 hex 补丁，经过撤销与保存。表的 Sort Table / Sort Selection（移植 `TableSorter`）、Go to RID、Show in Hex Editor、Copy as Text、Copy、Paste，以及 Go to MD Table Row（Ctrl+Shift+D 与按选中行标记的 Shift+Alt+R）。
- **非 .NET 文件**：PE-only、ELF 与未知文件可以在 hex 视图里改写，hex 标签的 Save（Ctrl+S）按 hex 文档保存。

| 子模块 | 完成度 | ✅ | 🟡 | ❌ | ⛔ |
|---|---|---|---|---|---|
| Assembly | 100% | 4 | 0 | 0 | 1 |
| Module | 100% | 3 | 0 | 0 | 0 |
| Namespace | 100% | 3 | 0 | 0 | 0 |
| Types / Method / Field / Property / Event | 100% | 5 | 0 | 0 | 0 |
| MethodBody | 100% | 9 | 0 | 0 | 0 |
| Compiler（C# / VB 编辑） | 100% | 6 | 0 | 0 | 0 |
| Resources | 100% | 7 | 0 | 0 | 0 |
| Hex（修改能力） | 100% | 8 | 0 | 0 | 0 |
| SaveModule | 100% | 6 | 0 | 0 | 0 |
| UndoRedo | 100% | 6 | 0 | 0 | 0 |
| 通用对话框（DnlibDialogs、ViewHelpers） | 100% | 7 | 0 | 0 | 0 |
| Commands（菜单落位与杂项命令） | 100% | 6 | 0 | 0 | 1 |

#### Assembly、Module、Namespace

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| Edit Assembly… | `AE/Assembly/AssemblyCommands.cs`、`AssemblyOptionsVM.cs` | `AssemblyOptionsDialog.tsx`，RPC `assembly/getOptions`、`assembly/setOptions` | ✅ | 名称、区域、公钥（可从文件读）、哈希算法、处理器架构、内容类型、四段版本、五个标志位、自定义特性与安全声明；改名后行标签随之刷新 |
| Create Assembly… | 同上 | `AssemblyModuleDialogs.tsx` 的新建模式，RPC `assembly/create` | ✅ | 与 Edit Assembly 同一窗口另加 .NET 版本；模块按 dnSpy 的 `ModuleUtils.CreateModule` 建，在保存前是没有文件的文档，撤销把它拿走 |
| Remove Assembly | 同上 | RPC `workspace/removeModules` | ✅ | 作用于选中的全部根行；撤销历史涉及的文档，移除记为可撤销的一步，见 4.3 |
| NetModule 新建、添加、移除 | 同上、`NetModuleOptionsVM.cs` | `NetModuleOptionsDialog.tsx`，RPC `module/createNetModule`、`module/addNetModule`、`module/removeNetModule` | ✅ | Create NetModule、Add New / Add Existing NetModule to Assembly（非 netmodule 文件按 WPF 拒绝）、Remove NetModule from Assembly；树把程序集的 netmodule 列在主模块之后 |
| Disable Memory Mapped I/O | 同上 | 隐藏 | ⛔ | 后端没有内存映射 |
| Edit Module… | `AE/Module/ModuleCommands.cs`、`ModuleOptionsVM.cs` | `ModuleOptionsDialog.tsx`，RPC `module/getOptions`、`module/setOptions` | ✅ | Main / Metadata / Cor20 / PE / 自定义特性五页；模块名、MVID、入口点、版本串、标头版本、Cor20 标志与运行时版本、Machine、Characteristics 与 DllCharacteristics |
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
| 删除类型与成员 | `*DefCommands.cs`、`AE/Commands/Deleted*Updater.cs` | RPC `edit/delete` | ✅ | 删除属性/事件会连带删除访问器；多选时整个选区一步删除 |

另新增了 WPF 没有的简易重命名框（RPC `edit/rename`）。

#### 方法体（MethodBody）

「Edit Method Body…」打开 `MethodBodyDialog.tsx`，三页签与 WPF 的 `MethodBodyDlg` 对应；读取与写回走 `edit/getIlBody`、`edit/replaceIlBody`，指令命令走 `edit/transformIlBody`。

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| 方法体类型（None/CIL/Native）、给无体方法加 body | `AE/MethodBody/MethodBodyVM.cs` | 下拉框切换；无体方法可以从 CIL 开始编辑 | ✅ | `CodeType` 与 body 类型都写回 `MethodImplAttributes` |
| CIL 头选项 | `CilBodyVM.cs` | MaxStack、InitLocals、KeepOldMaxStack、LocalVarSigTok（只读）、Header RVA/Offset | ✅ | `KeepOldMaxStack` 原样传给 dnlib；不勾选时由 dnlib 重算栈深 |
| 指令表编辑 | `InstructionsListHelper.cs` | 可编辑的标签/操作码/操作数网格，WPF 的右键菜单与快捷键 | ✅ | 插入、删除、上下移、Cut/Copy/Paste（选区前后、跨方法与跨模块）、复制为文本与复制操作数标记；跨模块粘贴时导入成员引用并带上局部变量 |
| 操作数编辑 | `InstructionOperandVM.cs`、`SwitchOperandDlg`、`MemberRefVM.cs`、`MethodSpecVM.cs` | 数字/字符串/分支/switch、局部变量与参数下拉、成员/类型选择器，`IlOperandDialogs.tsx` | ✅ | 操作数右键按 WPF 列出 Type… / TypeSpec… / Method… / MethodSpec… / Field… / MemberRef…，`calli` 用 MethodSig 窗口 |
| 局部变量页 | `LocalVM.cs` | 增删、名称、Pinned、编译器生成、类型编辑器；右键菜单与剪贴板 | ✅ | 类型用 `TypeSigEditor`，与局部变量类型创建对话框一致 |
| 异常处理器页 | `ExceptionHandlerVM.cs` | 增删、四个处理器类型、五个位置、捕获类型；右键菜单与剪贴板 | ✅ | 编辑带 try/catch 的方法不再丢 EH |
| 指令宏（Simplify/Optimize、NOP、反转分支等） | `InstructionsListHelper.cs` | 后端 `edit/transformIlBody` 的七个命令 | ✅ | 栈指令（Convert to Unconditional Branch、Remove and Add Pops）按操作数签名计算栈效应 |
| Edit IL Instructions（按选中语句） | `MethodBodyCommands.cs` | 代码视图右键「Edit IL Instructions…」 | ✅ | 以语句的 IL 范围预选指令 |
| Replace Method Body with stub | `MethodBodyCommands.cs` | RPC `edit/replaceMethodBodyWithStub`、`BE/MethodBodyStub.cs` | ✅ | |

#### Compiler（Roslyn 源码编辑）

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| Edit Method (C#/VB) | `AE/Compiler/EditMethodCodeVM.cs` | `EditCodeDialog.tsx`，RPC `compiler/compile`；`BE/WorkspaceManager.Compiler.cs`、`BE/Editing/Compiler/ModuleImporter.cs` | ✅ | 反编译外层类型、编辑后编译并只导入该方法；工具栏语言为 VB 时以 VB 编辑与编译 |
| Edit Class | `AE/Compiler/EditClassVM.cs` | 同上，模式 `editClass` | ✅ | 整个类型合并，可增删成员 |
| Add Class Members | `AE/Compiler/AddClassMembersCommands.cs` | 同上，模式 `addMembers` | ✅ | 只加入源里新出现的成员，不改已有成员 |
| Add Class | `AE/Compiler/AddClassCommands.cs` | 同上，模式 `addClass` | ✅ | 从空类模板开始；新类型加入模块 |
| Edit Assembly Attributes | `AE/Compiler/EditAssemblyVM.cs` | 同上，模式 `editAssembly` | ✅ | 程序集与模块特性、安全声明、版本写回；VB 由 C# 转换得到 `<Assembly: …>` / `<Module: …>` |
| Merge with Assembly | `AE/Compiler/MergeWithAssemblyCommand.cs` | 主进程选文件，RPC `compiler/merge` | ✅ | 与 WPF 一样不合并依赖程序集 |
| 编译器选项页（Compiler settings） | `AE/Compiler/CompilerAppSettingsPageContainer.cs` | Options › Compiler 的 C# 与 Visual Basic 两页 | ✅ | 条件编译符号、优化、溢出检查、unsafe，Option Explicit/Infer/Strict/Compare Binary、嵌入 VB 运行时；编译时随请求交给后端 |

#### 资源、Hex 修改、保存、撤销

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| Delete Resource | `AE/Resources/ResourceCommands.cs` | RPC `edit/delete` | ✅ | |
| Delete Resource Element | 同上 | 同一 RPC，重写 `.resources` 后删去条目 | ✅ | 撤销恢复整份文件 |
| Edit Resource（名称、可见性、链接属性） | `ResourceVM.cs` | `ResourceOptionsDialog.tsx`，RPC `resource/getOptions`、`resource/setOptions` | ✅ | 名称、Public/Private、程序集链接、文件链接（名称/哈希/无元数据）、自定义特性 |
| Edit Resource Element（字符串、图片、序列化对象等） | `ResourceElementVM.cs`、`ImageResourceElementVM.cs`、`ImageListVM.cs` | `ResourceElementDialog.tsx`、`ImageResourceDialogs.tsx`，RPC `resource/getElementOptions`、`resource/setElementOptions` | ✅ | 内置类型、字节与流、用户类型；序列化的 Bitmap/Icon 与装着图片的字节数组/流用图像窗口，按原序列化格式写回；ImageListStreamer 用图像列表窗口 |
| Create File / Multi File Resource | `ResourceCommands.cs` | `CreateResourceDialog.tsx`，RPC `resource/create` | ✅ | 多文件资源写成一个 `.resources`，每个文件一个 `byte[]` |
| Create Assembly / File Linked Resource | 同上 | 同上 | ✅ | 程序集名或文件名可直接输入 |
| 新建资源元素 | 同上 | `CreateResourceElementDialog.tsx`、`CreateImageListDialog`，RPC `resource/createElement` | ✅ | 字符串、布尔/数值、字节数组、流、null；Create System.Data.Bitmap/Icon Resource（多选图片一步加入）与 Create System.Windows.Forms.ImageListStreamer Resource，仅在 `.resources` 内显示 |
| Hex Write return true/false/空方法体 | `AE/Hex/Commands.cs` | `hex-menu.ts` → RPC `edit/hexPatch` | ✅ | |
| Hex Copy / Paste Method Body | 同上 | 剪贴板传十六进制文本 | ✅ | |
| Hex 修改接入撤销与保存 | `AE/Hex/HexBufferUndoRedo.cs` | 补丁作为事务操作，保存时重定位 | ✅ | 见缺陷 #7 |
| Hex 视图里直接改写、粘贴、填充 | `WPF/Hex/ContextMenuCommands/Commands.cs` | `HexView` → `hexWriteBytes`、`edit/hexPatch` | ✅ | 键入、粘贴（含粘贴特殊）、填充与清零，每次一个事务；PE-only、ELF 与未知文件同样可写 |
| Go to Offset / Metadata / 选择 | 同上 | `HexGoToPositionDialog`、`HexGoToMetadataDialog`、`HexSelectDialog` | ✅ | 见 4.7 |
| 单独保存 Hex 文档、改非 .NET 文件 | `AE/Hex/HexTabSaver.cs` | hex 标签的 Save（Ctrl+S）、Save All；`WriteFileWithPatches` | ✅ | 文件原样读出、补丁写上去；原地保存后补丁覆盖的原字节留作基底，保存后再撤销显示原值 |
| 编辑 PE 头与元数据表字段 | `AE/Hex/Nodes/*`、`AE/Hex/PE/*VM.cs` | `HexStructureView.tsx`、`MetadataTableView.tsx`，RPC `hex/getStructure`、`metadata/getTable`、`metadata/getTableRows` | ✅ | 字段按 WPF 的名称、偏移与 `SimpleTypeConverter` 格式显示，位域是复选框或下拉框，失去焦点时写入；值经补丁读出，撤销后表单与网格重读，见 4.8 |
| MD 表命令与 Go to MD Table Row | `AE/Hex/MDTableContextMenuCommands.cs`、`AE/Hex/Commands.cs` | 表的右键菜单与 Edit 菜单，RPC `metadata/sortTable`、`metadata/tableText`、`metadata/findRecord` | ✅ | Sort Table（Ctrl+Shift+T）、Sort Selection、Go to RID（Ctrl+G）、Show in Hex Editor（Ctrl+X）、Copy as Text（Ctrl+Shift+C）、Copy、Paste；Go to MD Table Row（Ctrl+Shift+D）与 Go to MD Table Row (标记)（Shift+Alt+R）在 Edit、树与代码视图菜单中 |
| Save Module… | `AE/SaveModule/SaveModuleCommand.cs` | `SaveModuleOptionsDialog.tsx`，RPC `module/getSaveOptions`、`module/saveDocuments` | ✅ | 打开时是模块自己的文件，「...」另选文件名 |
| Save All | 同上、`SaveMultiModuleVM.cs` | `SaveModulesDialog.tsx`，进度通知 `module/saveProgress` | ✅ | 列出全部修改过的文档，每项可改选项；文件进度与总进度、写出日志（dnlib 的警告与错误）、可取消，取消时不留下半写的文件 |
| 原地覆盖原文件 | `AE/SaveModule/DocumentSaver.cs` | 同上 | ✅ | 写临时文件、重新加载校验后原子替换；`.config` 随另存一并复制 |
| Mixed-mode 保存 | `SaveModuleOptionsVM.cs` | `NativeModuleWriterOptions` | ✅ | 勾选 Mixed-Mode Module 后按原 PE 布局写出，各页按 WPF 重新初始化 |
| 写 PDB | 同上 | `ModuleWriterOptions.WritePdb`（portable PDB） | ✅ | 仅当模块读到了 `PdbState` 时可用；PDB 写在目标文件旁 |
| 写出选项（PE 头、元数据、Cor20、堆） | 同上、`MetadataOptionsVM.cs`、`Cor20HeaderOptionsVM.cs`、`PEHeadersOptionsVM.cs` | `WriterOptionsDto` | ✅ | WPF 五页的全部字段：MetadataFlags 各位、各堆选项、元数据头版本串、Cor20 覆盖值与标志、PE 头各字段，可空数字框留空即用 dnlib 默认 |
| Undo / Redo | `AE/UndoRedo/*` | RPC `edit/undo`、`edit/redo` | ✅ | 编译器导入也在事务里保存快照，撤销恢复成员与类型 |
| 编辑命令统一进撤销栈并刷新界面 | `UndoCommandService.cs` | `refreshAfterEdit` | ✅ | 后端有版本冲突检测 |
| 修改标记 | 同上 | `EditCommitResponse.ModifiedDocuments` | ✅ | 每个文档按保存点计算，撤销回保存点即复位（缺陷 #3 已修） |
| 退出时询问保存 | `AE/UndoRedo/Commands.cs` | 主进程 `app:askExitUnsaved` | ✅ | 「是否保存？」是 / 否 / 取消，选「是」走 Save All 窗口，保存完成才退出 |
| 重新加载前提示 | `UndoRedoDocumentListListener.cs` | `FE/App.tsx` 的 `reloadAll` | ✅ | dnSpy 原话：「有 N 个尚未被保存的文件。是否要重新载入所有程序集并放弃所有修改？」 |
| 移除已修改的程序集时询问 | `AE/Assembly/AssemblyCommands.cs`、`AE/SaveModule/DocumentSaver.cs` | `FE/App.tsx` 的 `removeDocuments`，`app:askSaveModified` | ✅ | 「是否要在继续之前保存？」是 / 否 / 取消；选「是」原地保存，保存失败则不移除 |

#### 通用对话框与命令

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| 签名构造器（TypeSig、MethodSig、属性签名） | `AE/DnlibDialogs/TypeSigCreatorVM.cs` 等 | `widgets/TypeSigEditor.tsx` 等、`BE/Editing/SignatureCodec.cs` | ✅ | |
| 成员选择器 | `MemberPickerVM.cs`、`ViewHelpers/DnlibTypePicker.cs` | `TypePickerDialog.tsx` | ✅ | 搜索框（Ctrl+E / Ctrl+F）与结果列表、打开程序集、语言下拉框、按模块选择 |
| 自定义特性、命名参数、常量 | `CustomAttributeVM.cs`、`ConstantVM.cs` | `widgets/CustomAttributeDialog.tsx` 等 | ✅ | |
| 泛型参数、DeclSecurity、TypeDefOrRefAndCA | `GenericParamVM.cs`、`DeclSecurityVM.cs` | 对应的 Dialog 与 Codec | ✅ | |
| ParamDef、P/Invoke、Marshal、MethodOverride | `ParamDefVM.cs`、`ImplMapVM.cs`、`MarshalTypeVM.cs` | 对应的 Dialog 与 Editor | ✅ | |
| 手工构造 MemberRef / MethodSpec | `MemberRefVM.cs`、`MethodSpecVM.cs` | `IlOperandDialogs.tsx`、`BE/Editing/MemberRefCodec.cs` | ✅ | MemberRef 的类（类型/TypeSpec/方法定义/模块引用）、名称、签名与特性；MethodSpec 的泛型实参与特性 |
| 列表编辑控件 | `ListVM.cs` | `ListEditor.tsx` | ✅ | |
| 命令在三处菜单里的落位 | `AE/Commands/*MenuHandler.cs` | `edit-menu.ts`、两个右键菜单 | ✅ | 删除命令的标题随选区（「Delete N types」等）与图标随语言变化 |
| 多选批量操作 | `AE/Commands/DeletableNodes.cs` | 树支持多选 | ✅ | Remove Assembly 与删除类型/成员都作用于整个选区，一步撤销 |
| Copy MD Token / Full Name | `WPF/Documents/Tabs/CopyTokenCommand.cs` | 树和代码视图菜单 | ✅ | |
| Copy IL Bytes | `AE/Commands/InstructionCommands.cs` | 代码视图右键与 Ctrl+B，RPC `document/getIlBytes` | ✅ | 改过的方法里未知的字节写作 `??` 并给出 WPF 的提示 |
| Load Dependencies | `AE/Compiler/LoadDependenciesCommands.cs` | RPC `workspace/loadDependencies` | ✅ | 与 4.3 重复计入 |
| Close All Framework Assemblies / Missing Files | `AE/Commands/CloseAll*Command.cs` | File 菜单 | ✅ | 与 4.3 重复计入 |
| Close Old In-Memory Modules | `AE/Commands/CloseOldInMemoryModulesCommand.cs` | File 菜单，`closeOldInMemoryModules` | ✅ | 关闭从进程内存读出、其进程已不在调试的模块（WPF 的 `IInMemoryDocument.IsActive` 为 false），按 Remove Assembly 的流程（含保存询问）移除 |

测试：后端 `WorkspaceEditCreateTests.cs`、`WorkspaceEditOptionsTests.cs`、`Editing/NodeOptionsRoundTripTests.cs`、`Editing/SignatureRoundTripTests.cs`、`WorkspaceIlBodyTests.cs`（方法体三页、七个指令命令、跨模块粘贴、MemberRef、Copy IL Bytes）、`WorkspaceResourceEditingTests.cs`（含图像与 ImageListStreamer）、`WorkspaceAssemblyModuleOptionsTests.cs`、`WorkspaceSaveOptionsTests.cs`、`WorkspaceSavingTests.cs`（保存点、hex 文档保存、非 .NET 文件原地保存后撤销、写出选项、进度与取消）、`WorkspaceDocumentTests.cs`（新建程序集与 netmodule）、`WorkspaceMetadataStructureTests.cs`（PE/元数据结构、表行、排序、Go to MD Table Row、Show in Hex 范围）、`WorkspaceCompilerTests.cs`（含 VB 与编译器设置），以及 `WorkspaceManagerTests.cs` 中的方法体、资源、hex、保存用例；前端 `*OptionsDialog.test.tsx`、`MethodBodyDialog.test.tsx`、`il-body-clipboard.test.ts`、`ResourceDialogs.test.tsx`、`ImageResourceDialogs.test.tsx`、`image-list-streamer.test.ts`、`AssemblyModuleDialogs.test.tsx`、`NetModuleOptionsDialog.test.tsx`、`SaveModuleOptionsDialog.test.tsx`、`SaveModulesDialog.test.tsx`、`HexStructureView.test.tsx`、`hex-fields.test.ts`、`EditCodeDialog.test.tsx` 与 `widgets/*.test.ts(x)`；e2e 覆盖新建类型并经 Save Module 窗口另存、IL 与元数据编辑、hex 写入并撤销、模块转换、PE 头字段改写并撤销、元数据表网格、Go to RID 与 Go to MD Table Row。

### 4.13 调试器

整体完成度约 97%（✅ 82 / 🟡 1 / ❌ 2 / ⛔ 5）。WPF 范围：`Extensions/dnSpy.Debugger/` 全部子项目、`dnSpy/Roslyn/Roslyn.ExpressionCompiler`。

2026-10-20 按 WPF 补齐后按实现与测试复核（2026-10-17 复核时约 83%：✅ 63 / 🟡 16 / ❌ 7 / ⛔ 4；更早约 47%）。跨平台版只有一个引擎：后端进程内直连 ICorDebug（`CDS/`），只支持 CoreCLR。没有 PDB 时，断点、单步落点和局部变量名都来自反编译语句到 IL 偏移的映射（`BE/StatementIlRanges.cs`）。

2026-10-17 那一轮补上的主体是表达式求值器（`CDS/Evaluation/`）：用 Roslyn 按被调试进程已加载的模块建 C#/VB 编译（`MetadataImportOptions.All`，C# 打开 `IgnoreAccessibility` 读私有成员），把表达式编译进一个以局部变量和 `this` 为参数的合成方法，再解释它的 IOperation 树；字段、数组、算术、转换、模式匹配等在调试器侧直接算，属性、方法调用、`new`、装箱与字符串用 func-eval（`ICorDebugEval`，冻结其他线程，超时后 Abort / RudeAbort）。值的格式化、DebuggerDisplay / DebuggerTypeProxy、Raw / Results / Dynamic View、格式说明符（`h`、`d`、`nq`、`raw`、`results`、`ac` 等）、`$exception`、`$ReturnValue`、`$N` 对象 ID 都按 WPF 的 `CSharpValueFormatter` 与值节点提供者实现，三列按 dnSpy 的颜色类型着色。断点条件与跟踪点的 `{表达式}` 也改走这个求值器。

2026-10-20 这一轮补齐其余部分：

- **断点是 IL 位置。** 与 WPF 的 `DbgDotNetCodeLocation` 一样，断点记的是模块、方法标记与 IL 偏移；C#、VB、IL 三种视图各按自己的语句表把它画在包含该偏移的语句上，所以哪种语言里都能下断点、切换语言不丢。VB 的语句表来自 C#→VB 转换时插入的标记注释（`BE/VisualBasicConversion.cs`），方法文档不再变成空壳类。字形按 `BreakpointImageUtilities` 分普通、高级（有条件/命中计数/筛选器）、跟踪点，调试时未绑定的显示警告或错误；语句本身按主题的断点标记着色。
- **Breakpoints 窗口**是 WPF 的七列可排序表格，带搜索（`-n -l -c -h -f -w -m` 与 `!`）、工具栏、右键菜单、就地编辑标签；导入导出改为 WPF 的 XML 断点文件，两边互通。
- **跨 await 单步**照 `DbgEngineStepperImpl`：在调用自己的线程上监视 yield 点、按任务身份认出恢复后的同一次调用，到达 `SetResult` 时让任务在被等待时通知调试器，再走出任务管线回到 await 处；Step Out 直接回到等待者。
- **多进程**：可以同时启动、附加多个进程；一个进程中断时按「中断所有进程」选项暂停其他进程（引擎侧实现），当前进程随中断切换；Processes、Threads、Modules 窗口列出所有进程，后两者带 WPF 的「进程」下拉框；关闭 Break All Processes 时 Debug 菜单出现「(当前进程)」三个单步命令。
- **Memory 窗口**改为 hex 编辑器本身（`HexView` 的字节源模式），**Disassembly** 改为文档标签，与 WPF 相同。
- **动态模块**：Reflection.Emit 建的模块由运行时为调试器保存的元数据与进程内的方法体拼成 PE 映像（`CDS/CorDebugSession.DynamicModules.cs`），可以打开、反编译、下断点；从内存打开的模块有 Reload All Method Bodies，「使用内存模块」选项生效。

| 子模块 | 完成度 | ✅ | 🟡 | ❌ | ⛔ |
|---|---|---|---|---|---|
| 变量与表达式求值 | 100% | 12 | 0 | 0 | 0 |
| 异常设置 | 100% | 10 | 0 | 0 | 1 |
| 调试器选项 | 100% | 9 | 0 | 0 | 1 |
| 调试工具窗口 | 100% | 9 | 0 | 0 | 0 |
| 单步与执行点 | 100% | 8 | 0 | 0 | 0 |
| 断点 | 100% | 17 | 0 | 0 | 0 |
| 运行时与代码映射 | ~92% | 5 | 1 | 0 | 2 |
| 会话控制 | ~86% | 12 | 0 | 2 | 1 |

剩下的两个 ❌ 是 Mono / Unity：那是另一套调试引擎（Mono 的软调试协议），不在 1.0 的范围内，这一轮也明确不做（2026-10-20 与需求方确认）。

#### 会话控制

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| Debug Program 对话框（.NET 页） | `DBG/dnSpy.Debugger/Dialogs/DebugProgram/*`、`dnSpy.Debugger.DotNet.CorDebug/Dialogs/DebugProgram/DotNetStartDebuggingOptionsPage.cs` | `DebugProgramDialog.tsx`，RPC `debug/launch` | ✅ | 支持宿主可执行文件；缺 ConnectionTimeout |
| Break at（4 种） | `DotNetCommonStartDebuggingOptionsPage.cs` | `CDS/CorDebugSession.Entry.cs` | ✅ | `ModuleCctorOrEntryPoint` 的帧按 WPF 写成 `<Module>.<Module>()` |
| .NET Framework 启动页 | `DotNetFrameworkStartDebuggingOptionsPage.cs` | 无 | ⛔ | Linux 上没有 .NET Framework |
| Mono / Unity 启动与 connect | `dnSpy.Debugger.DotNet.Mono/Dialogs/DebugProgram/*` | 无 | ❌ | 另一套引擎，不在 1.0 范围，本轮明确不做 |
| 启动选项 MRU | `DbgUI/StartDebuggingOptionsMru.cs` | `DebugProgramDialog.tsx`（`dnspy.debugProgramMru.v1`） | ✅ | 按程序路径记住参数、目录、环境、宿主与 Break at，最多 20 个 |
| Start Without Debugging | `DbgUI/DebugMenuCommands.cs` | 同一对话框，主进程 `debug:startWithoutDebugging` | ✅ | Ctrl+F5；与引擎一样对 `.dll` 走 dotnet 宿主 |
| Attach to Process | `Dialogs/AttachToProcess/*` | `AttachDialog.tsx`，RPC `debug/listProcesses`、`debug/attach` | ✅ | WPF 的七列（进程、ID、标题、类型 `CoreCLR <版本>`、体系架构、文件名、命令行），可排序、按列搜索、多选一次附加多个、Refresh（F5）、Ctrl+C/Ctrl+A；已在调试的进程不列出。版本取自 libcoreclr.so 所在目录，体系架构读可执行文件的 ELF 头，命令行读 `/proc/<pid>/cmdline`；Linux 进程没有窗口标题，「标题」列为空 |
| Unity 附加 | `dnSpy.Debugger.DotNet.Mono/Dialogs/AttachToProcess/Unity*` | 无 | ❌ | 同 Mono，本轮不做 |
| Continue | `DebugMenuCommands.cs` | `continueDebug` | ✅ | 同 `RunAll`：所有暂停的进程都继续 |
| Break All | 同上 | `pauseDebug` | ✅ | Ctrl+Alt+Break，所有运行中的进程 |
| Stop Debugging | 同上 | `stopDebug` | ✅ | 同 `StopDebuggingAll`：按每个进程的「调试停止时分离」决定分离还是终止（附加的进程默认分离） |
| Detach All / Terminate All | 同上 | `detachDebug`、`terminateDebug` | ✅ | 作用于所有进程 |
| Restart | 同上 | `restartDebug` | ✅ | Ctrl+Shift+F5，按上次的参数重启；附加的进程不可用 |
| 多进程调试 | `Impl/DbgManagerImpl.cs` | `debugSessions`、`setCurrentDebugSession`；`CDS/CorDebugSessionManager.cs` 的 `BreakOtherProcesses` | ✅ | 调试中仍可启动与附加；「中断所有进程」由引擎在任一进程中断时暂停其余进程；当前进程无事可显示时切到中断的进程；进程退出后切到另一个（优先已暂停的）；断点同时下到所有进程。命中计数各进程分别计 |
| 调试状态提示 | `DbgUI/DebuggerImpl.cs` | 状态栏 | ✅ | 中断时按选项把窗口带到前台 |

#### 单步与执行点

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| Step Into / Over / Out | `Steppers/DbgStepperImpl.cs` | `CDS/CorDebugSession.Stepping.cs` | ✅ | 按 3 项统计；在源级顺序点挂临时断点；Step Into 按选项跳过属性与运算符（并按 OutputLogger 写「Step into: Stepping over property …」）、Just My Code 之外的模块；落在隐藏顺序点上时继续单步；也有「(当前进程)」变体（Ctrl+Alt+F11 / F10、Ctrl+Shift+Alt+F11）。F5/F10/F11 等在代码视图里同样生效 |
| 跨 await 单步 | `dnSpy.Debugger.DotNet/Steppers/Engine/DbgEngineStepperImpl.cs` | `CDS/CorDebugSession.AsyncStepping.cs` | ✅ | yield 断点、按任务身份过滤的恢复断点、`SetNotificationForWaitCompletion` + `Task.NotifyDebuggerOfWaitCompletion` 回到等待者；await 信息来自反编译器的 `AsyncDebugInfo` |
| Show Next Statement | `DbgUI/DocumentViewerCommands.cs` | `revealStoppedLocation` | ✅ | Alt+Num *，Debug 菜单与编辑器右键 |
| Set Next Statement | 同上 | `setNextStatement`，`CDS/CorDebugSession.Control.cs`（`ICorDebugILFrame.SetIP`） | ✅ | Ctrl+Shift+F10；先 `CanSetIP` 检查，只能在当前方法内 |
| Run to Cursor | `ToolWindows/CallStack/CallStackOperations.cs`、`DocumentViewerCommands.cs` | `runToCursor` | ✅ | Ctrl+F10：编辑器里是光标处语句上的临时 IL 断点，Call Stack 里是该帧返回地址上的本机断点 |
| Unwind To This Frame | `ToolWindows/CallStack/Commands.cs` | Call Stack 右键 | ✅ | 与 WPF 一样有菜单项而永远禁用（`CanUnwindToFrame` 恒为 false） |
| 当前语句与调用栈帧高亮 | `CallStack/TextEditor/ActiveStatementService.cs` | `FE/debugger-markers.ts` | ✅ | 当前语句（黄）、切换到的调用方帧的返回语句（绿）、其他帧的活动语句（灰），颜色取自主题；各语言视图都按 IL 位置定位，不再强制切回 C# |
| 停在工作区外的模块时自动加载 | `dnSpy.Debugger.DotNet/Modules/DbgLoadModuleReferenceHandlerImpl.cs` | `openDebugModule` | ✅ | 切换到的帧保持为活动帧；动态、内存模块与「使用内存模块」时从进程内存读 |

#### 断点

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| 行断点 | `Breakpoints/Code/TextEditor/GlyphMarginOperations.cs` | `toggleLineBreakpoint`、`CDS/CorDebugSession.Breakpoints.cs` | ✅ | 存 IL 位置；C#、VB、IL 视图都能下，按 `ToggleCreateBreakpoint` 的语义（全部启用则删除、否则启用） |
| 启用 / 禁用 | `DbgUI/DocumentViewerCommands.cs` | 右键、Ctrl+F9、窗口复选框 | ✅ | |
| 绑定状态 | `Breakpoints/Code/BoundCodeBreakpointsService.cs` | `breakpoint` 事件 | ✅ | 运行时拒绝偏移时退回顺序点；未绑定的显示警告/错误字形与提示 |
| 断点字形外观 | `BreakpointGlyphTextMarkerHandler.cs`、`BreakpointImageUtilities.cs` | `FE/debugger-markers.ts` | ✅ | 普通、高级、跟踪点、警告、错误各自的 dnSpy 图像；语句按主题的断点标记着色 |
| 边距右键与悬停工具条 | `GlyphMarginCommands.cs`、`BreakpointGlyphPopupControl` | `DocumentView.tsx`、`BreakpointGlyphPopup.tsx` | ✅ | Delete / Disable-Enable（Ctrl+F9）/ Settings… / Export…；悬停的设置与开关按钮、WPF 格式的提示 |
| Add Method Breakpoint | `dnSpy.Debugger.DotNet/Breakpoints/Code/TextEditor/ClassBreakpointCommands.cs` | `addMethodBreakpoints`，RPC `debug/codeTargets` | ✅ | 按标记在方法开头下断点，重载各自独立；属性与事件按访问器；树、代码视图、分析器、搜索都有 |
| Add Class Breakpoint / Tracepoint | 同上 | `addClassBreakpoint` | ✅ | 类型的每个有代码的方法；Tracepoint 先开设置对话框 |
| 条件 | `Breakpoints/Code/CondChecker/DbgCodeBreakpointConditionChecker.cs` | `BreakpointSettingsDialog.tsx`、`CDS/CorDebugSession.BreakpointChecks.cs` | ✅ | 完整的 C#/VB 表达式；设置对话框照 WPF 的四行布局与帮助 |
| 命中计数 | `CondChecker/DbgCodeBreakpointHitCountChecker.cs` | `CDS/BreakpointBreakDecision.cs` | ✅ | 窗口显示当前次数，Reset Hit Count |
| 筛选器 | `CondChecker/DbgCodeBreakpointFilterChecker.cs` | `CDS/CorDebugSession.BreakpointChecks.cs` | ✅ | 对话框里即时校验（RPC `debug/verifyFilter`），无效时不能确定 |
| 跟踪点消息 | `CondChecker/TracepointMessageParser.cs` | `CDS/TracepointMessage.cs` | ✅ | `{表达式}` 走求值器 |
| 标签 | Breakpoints 窗口 | 窗口内就地编辑、多行时对话框 | ✅ | |
| Enable / Disable / Delete All | `DebugMenuCommands.cs` | `MenuBar.tsx` | ✅ | |
| Breakpoints 窗口 | `ToolWindows/CodeBreakpoints/*` | `BreakpointsWindow.tsx`、`FE/breakpoints-model.ts` | ✅ | 七列可排序表格（名称按 C# 格式化器与显示选项写）、搜索与高亮、工具栏、右键菜单（含 Go To Disassembly、Show… 选项）；另有按名称的函数断点输入行 |
| 导入 / 导出 | `Breakpoints/Code/BreakpointsSerializer.cs` | `BE/WorkspaceManager.Breakpoints.cs`，RPC `breakpoints/export`、`breakpoints/import` | ✅ | WPF 的 XML 格式；导入时方法名对不上的行与动态/内存模块的行照 WPF 丢弃 |
| 持久化 | 同上 | `dnspy.breakpoints.v1` | ✅ | |
| 模块断点 | `Breakpoints/Modules/*` | `ModuleBreakpointsPane`，RPC `setModuleBreakpoints`，`CDS/CorDebugSession.ModuleBreakpoints.cs` | ✅ | 模块名、顺序、动态、内存、应用程序域、进程，名称支持通配符；持久化在 `dnspy.moduleBreakpoints.v1` |

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
| 右键 Break When Thrown | `dnSpy.Debugger.DotNet/Exceptions/BreakWhenThrownExceptionCommand.cs` | 树与代码视图右键，`breakWhenThrown` | ✅ | 只对派生自 `System.Exception` 的类型出现；已有的行打开首次机会中断，没有的按两种机会都中断加入 |

#### 调试工具窗口

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| Call Stack | `ToolWindows/CallStack/*` | `DebugToolWindows.tsx` 的 `CallStackPane`；`CDS/CorDebugSession.Stack.cs` 的 `StackFrameFormatter` | ✅ | 帧名按 `CSharpStackFrameFormatter` 着色书写；右键的 Copy、Switch To Frame、Go To Code/Disassembly、Run To Cursor、Unwind To This Frame（禁用，同 WPF）、Breakpoint（Insert Breakpoint/Tracepoint，已有时 Delete/Disable/Settings/Export，F9）与十个显示开关。弹出菜单没有子菜单，Breakpoint 子菜单的各项平铺成一组 |
| Threads | `ToolWindows/Threads/*` | `ThreadsPane`；`CDS/CorDebugSession.Threads.cs` | ✅ | WPF 的全部列；列出所有进程的线程，多进程时有「进程」下拉框；冻结/解冻、重命名、切换（其他进程的线程先切换当前进程）。类别与优先级在 Linux 上取自 `/proc/<pid>/task` |
| Modules | `ToolWindows/Modules/*` | `ModulesPane` | ✅ | WPF 的全部列；所有进程的模块与「进程」下拉框；Go To Module、Open Module from Memory、Load All Modules、Save Module |
| Processes | `ToolWindows/Processes/*` | `ProcessesPane` | ✅ | 每个进程一行，当前进程带标记；双击切换当前进程；Continue/Break/Detach/Terminate Process、Detach When Debugging Stopped、Attach to Process。Linux 进程没有窗口标题，「标题」列为空 |
| Memory 1–4 | `ToolWindows/Memory/*` | `DebugNativeWindows.tsx` 的 `MemoryPane`，`HexEditor.tsx` 的字节源模式，RPC `readMemory`、`writeMemory` | ✅ | 就是 hex 编辑器：光标、选区、改写、Copy/Paste Special、查找、Go to Offset（输入地址）、每行字节数与值格式，读 Memory 窗口自己的 hex 选项；不可读的页显示 `??`；右键的 Process 子菜单选进程。视图一次映射 16 MiB，滚动或光标到边缘、跳到范围外的地址时整体移动，可以走遍整个地址空间 |
| Disassembly | `Disassembly/*` | `DisassemblyDocumentView`（文档标签）；`CDS/CorDebugSession.Native.cs`（Iced） | ✅ | 与 WPF 一样是以方法名命名的文档标签，按 Disassembler 选项与各方言 Code Style 输出，带 IL 与源码注释、标签、未优化提示；与 WPF 一样不能在里面下断点。Alt+8、Call Stack 与 Breakpoints 窗口的 Go To Disassembly 打开它。与 4.8 重复计入 |
| Output：程序 stdout/stderr | `ToolWindows/Logger/OutputLogger.cs` | `output` 事件 | ✅ | 附加的进程不能重定向 |
| Output：Debugger.Log | 同上 | `LogMessage` 回调 | ✅ | |
| Output：模块、线程、进程消息与过滤开关 | `ToolWindows/Logger/Commands.cs` | Debug 窗格右键的八个开关（`outputLogger` 设置） | ✅ | 异常、单步过滤、模块加载/卸载、进程/线程退出、程序输出、MDA；开始调试时按 ShowDebugOutputLog 切到 Debug 窗格 |

#### 变量与表达式求值

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| Locals | `ToolWindows/Locals/*` | `DebugVariablesWindows.tsx` 的 `LocalsPane`；`CDS/CorDebugSession.Variables.cs` | ✅ | 变量名来自反编译器，无需 PDB；`this`、参数、状态机与闭包里提升的局部变量、Type variables；按选项排序与分组 |
| Autos | `ToolWindows/Autos/*` | `AutosPane`，RPC `autos` | ✅ | 由 IL 找出前后语句读写的变量、字段与静态字段 |
| Watch 1–4 | `ToolWindows/Watch/*` | `WatchPane` | ✅ | 底部空行输入，名称列可编辑、Paste、Delete Watch、Clear All；Ctrl+Alt+W, 1–4 |
| Static Fields | `ToolWindows/StaticFields/*` | `StaticFieldsPane`，RPC `staticFields` | ✅ | |
| 表达式求值（C#/VB） | `dnSpy/Roslyn/Roslyn.ExpressionCompiler`、`Evaluation/*` | `CDS/Evaluation/ExpressionCompiler.cs`、`OperationInterpreter.cs` | ✅ | 语言随调试器选项的 Language；有副作用的表达式在 Locals/Autos 里不自动求值 |
| 编辑变量值 | Locals 的 EditValue | `setExpression` | ✅ | 双击或 F2，值是任意表达式 |
| 属性求值、ToString、函数调用 | `dnSpy.Debugger.DotNet.CorDebug/Impl/Evaluation` | `CDS/CorDebugSession.FuncEval.cs`、`Evaluation/EvalRuntime.cs` | ✅ | 1 秒超时后 Abort；遵守「属性求值与函数调用」「ToString」选项；装箱的值按其值类型显示 |
| DebuggerDisplay / DebuggerTypeProxy | `dnSpy.Debugger.DotNet/Evaluation/Engine/*` | `Evaluation/ValueFormatter.cs`、`ValueNodes.cs` | ✅ | 还有 DebuggerBrowsable、元组、KeyValuePair、Nullable |
| Raw / Results / Dynamic View | `dnSpy/Roslyn/dnSpy.Roslyn/Debugger/ValueNodes/*` | `ValueNodes.cs` | ✅ | |
| 十六进制显示 | 各窗口命令 | 各窗口右键的 Hexadecimal Display、Digit Separators | ✅ | 默认十六进制，与 WPF 相同 |
| Make Object ID | `Evaluation/DbgObjectIdServiceImpl.cs` | `makeObjectId`、`deleteObjectId` | ✅ | 强句柄，`$N` 可在表达式里用 |
| 显示返回值 | ShowReturnValues 设置 | `CDS/CorDebugSession.ReturnValues.cs` | ✅ | 单步越过的调用在 Locals 里显示「X returned」并可用 `$ReturnValue`（`GetReturnValueLiveOffset` + `GetReturnValueForILOffset`）。返回结构体的调用没有：运行时对它回 `CORDBG_E_UNSUPPORTED`，WPF 同样没有 |

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
| 焦点相关选项 | ✅ | 中断时把窗口带到前台；「把焦点给被调试进程」照 `SwitchToDebuggedProcess` 在进程持续运行 1 秒后激活它的窗口（X11 下经 xdotool；Wayland 合成器不允许，无效果） |
| 重定向 GUI 程序的控制台输出 | ✅ | 按 PE 头的子系统判断：GUI 程序（WinExe）只在选项打开时把输出写进 Output。WPF 给控制台程序开独立控制台，Linux 没有可给的控制台，控制台程序的输出总写进 Output |
| 启用 MDA | ⛔ | 只存在于 .NET Framework |

#### 运行时、平台与代码映射

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| Windows 反反调试（IsDebuggerPresent 等） | `DBG/dnSpy.Debugger/AntiAntiDebug/*` | 选项在，无实现 | ⛔ | Windows API，计划明确不支持 |
| 阻止托管代码检测调试器 | `dnSpy.Debugger.DotNet.CorDebug/AntiAntiDebug/ManagedDebuggerHook.cs` | 选项在，无实现 | ⛔ | WPF 的钩子只挂在 .NET Framework 的 `clr.dll`（`ExportDbgNativeFunctionHook("clr.dll", …)`，限 Windows），CoreCLR 进程在 WPF 里同样不处理 |
| 从内存打开模块 | `Code/GoToInMemoryModuleStatement.cs` | `openModuleFromMemory`，`saveModule`（按节还原文件布局） | ✅ | Modules 窗口的 Open Module from Memory 与 Go To Module；副本存于 `dnSpy-memory-modules/<pid>/<序号>/`，文件名即模块名，栈帧与断点按模块名对应到副本 |
| 动态模块 | `dnSpy.Debugger.DotNet/Metadata/DynamicModuleDefDocument.cs`、`ClassLoader.cs` | `CDS/CorDebugSession.DynamicModules.cs` | 🟡 | 运行时为调试器保存的元数据（`IMetaDataTables2.GetMetaDataStorage`）加上进程内每个方法体（IL 前的胖头与其后的异常节）拼成 PE；类型加载时引擎发 `classLoaded`，下一次中断时重新读入。WPF 在原文档上增量加入新类型，这里是整个副本替换，开着的该模块标签会关闭 |
| Reload All Method Bodies | `dnSpy.Debugger.DotNet/Metadata/Commands.cs` | 树与代码视图右键，`reloadMethodBodies` | ✅ | 只对从内存打开、进程仍在调试的模块出现；重新从进程读入并替换副本 |
| 使用内存模块 | `DebuggerSettings.UseMemoryModules` | `openDebugModule` | ✅ | 打开时从进程内存读模块而不是磁盘文件；动态与内存模块总是如此 |
| 反编译源码上的断点、单步、定位 | `dnSpy.Debugger.DotNet/Code/DbgMethodDebugInfoProvider.cs` | `BE/StatementIlRanges.cs`、`BE/VisualBasicConversion.cs`、`IDebugSymbolResolver` | ✅ | C#、VB、IL 视图都有语句表 |
| 无 PDB 时变量名取自反编译器 | `Evaluation/DbgLocalsValueNodeProviderImpl.cs` | `GetVariableNamesAsync` | ✅ | |

Linux 新增（不计入）：以 root 身份重启（pkexec）、随包提供 `libdbgshim.so` 并在缺失时按能力降级、按名称的函数断点。附加失败时没有 ptrace 权限诊断，只返回 HRESULT。

测试：后端 `DebugEvaluationTests.cs`（求值局部变量、成员与运算符，func-eval 调属性与方法，装箱值，十六进制与格式说明符，对象展开与改值，错误作为值，Locals、Autos、对象 ID、`$exception`，内存与反汇编，线程，Run to Cursor，Set Next Statement，模块断点，返回值）、`DebugSessionManagerTests.cs`（启动、Break kind、附加与分离、进程列表的各列、单步、Step Out 回到调用语句、跨 await 单步与回到等待者、异常中断、多进程时中断其余进程、动态模块保存为可读的 PE 并对应到工作区副本、`classLoaded`）、`BreakpointCommandsTests.cs`（方法/类断点目标、Break When Thrown、XML 断点文件往返）、`WorkspaceManagerTests.cs`（VB 文档的语句表）、`BreakpointExpressionTests.cs`、`BreakpointBreakDecisionTests.cs`、`TracepointMessageTests.cs`、`ExceptionSettingsTests.cs`；前端 `DebugVariablesWindows.test.tsx`、`app-store.test.ts`（debugger commands、断点种类与切换、方法/类断点、多进程的事件路由与 Continue/Stop、内存模块与 Reload All Method Bodies）、`BreakpointsPane.test.tsx`、`AttachDialog.test.tsx`、`MemoryPane.test.tsx`、`DebugToolWindows.test.tsx`（多进程的 Processes、Threads、Modules）、`ToolWindows.test.tsx`（Output 的过滤开关）、`DebugProgramDialog.test.tsx`、`ExceptionSettingsPane.test.tsx`、`CodeEditorContextMenu.test.tsx`、`MenuBar.test.tsx`、`MAIN/focus-process.test.ts`；e2e 覆盖断点（边距、Debug 菜单、方法/类断点与跟踪点、字形菜单、持久化）、单步、帧切换与调用返回标记、Locals、异常中断，以及 `--evaluate` 夹具上的 DebuggerDisplay、展开、改值、Watch 调用属性、Autos、Disassembly 标签、Threads。多进程的界面、Attach 对话框、Memory 窗口与 Output 的过滤开关只有单测，没有 e2e。

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
- 前端：`FE/roslyn-classification.ts`（分类结果画成 `tc-*` 内联装饰，供 REPL 与代码编辑器共用）、`FE/roslyn-language-service.ts`（各 provider 与 `attachRoslynDocument`，连同它要的 Monaco contrib：`FE/roslyn-editor-contribs.ts`；`FE/monaco.ts` 仍只导入 `editor.api` 并按需加入 find、hover、bracketMatching，之前那版改成整包导入后代码视图的右键光标定位回归了，已改回）、`FE/components/CSharpInteractive.tsx`、`FE/components/ColoredText.tsx` 的 `ClassifiedText`；`tc-*` 的颜色、加粗与斜体由主题服务（`FE/theme-service.ts`）按当前 `.dntheme` 写出

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
- 导出实现（`ProjectExporter`、VB 转换修正）已移到后端 `BE/ProjectExport/`，GUI 的「Export to Project」与 CLI 共用（见 4.4）。GUI 的导出还带上 C# 页的分支独有选项与 BAML 页的排版；CLI 的 stdout 输出仍用自己的语言选项子集，不写 token 注释等分支独有输出。

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

1. ~~修 Save / Save Module 的目标模块（缺陷 #1），以及保存单个模块清掉全局 `dirty`（缺陷 #3）~~ 已完成（2026-10-18、2026-10-19）。
2. ~~停止调试时区分启动的进程与附加的进程，后者走 Detach，并在菜单里加 Detach All（缺陷 #2）~~ 已完成（2026-10-17）。
3. ~~关闭窗口前，有未保存修改时弹出「保存 / 放弃 / 取消」对话框~~ 已完成（2026-10-14）。
4. ~~修 PE-only/ELF 文件的 hex 读取（缺陷 #6）~~ 已完成（2026-10-18）。Raw Save Resource（缺陷 #5）已修。
5. ~~IL 编辑器默认重算 MaxStack（缺陷 #4）~~ 已完成（2026-10-18）。

**P1：让已有界面生效**（UI 已经做好，只差接线）

1. ~~给 `DecompileRequest` 加反编译设置 DTO，接通 C#/VB、IL、BAML 选项页与 DecompileFullType~~ 已完成（2026-10-20，C# 页的分支独有选项见 4.4）；随后接文本编辑器、Hex、调试器等页面，并把 `UseMemoryMappedIO` 落到后端读文件的方式上。主题、字体、RestoreTabs、背景图片、Output 窗口这几页已于 2026-10-14 接通。
2. Monaco 改为完整导入（或按需导入 contrib），补一条查找功能的 e2e 防回归。
3. ~~调试器选项传给后端：JIT 优化抑制、Just My Code、忽略 Debugger.Break、忽略未处理异常~~ 已完成（2026-10-17）。
4. ~~绑定菜单上已标出的快捷键，修正 Go to Token 的键位与 Shift+Alt+Enter 冲突~~ 已完成（2026-10-14）。
5. ~~记忆窗口位置和尺寸；接受裸文件路径参数并加单实例锁~~ 已完成（2026-10-14；单实例默认关闭，与 WPF 的 `AllowMoreThanOneInstance` 默认值一致）。
6. ~~CI 增加前端 vitest 单测~~ 已完成（2026-10-14）。

**P2：补齐核心能力**

1. ~~IL 输出改用 `ReflectionDisassembler` 并生成 span 与语句表，一次解决 IL 视图的跳转、断点、书签持久化~~ 已完成（2026-10-20，见 4.4）。
2. ~~方法体编辑器支持局部变量与异常处理器，以及指令插入、移动和操作数选择器~~ 已完成（2026-10-18，见 4.12）。
3. ~~调试器的表达式求值与 func-eval、对象字段展开（Watch、Autos、DebuggerDisplay、完整断点条件都依赖它）~~ 已完成（2026-10-17）。
4. ~~Roslyn 源码编辑（Edit Method / Class (C#)），连带 ModuleImporter 与 Merge with Assembly~~ 已完成（2026-10-18）；编译设置页与 VB 编辑于 2026-10-19 补上。
5. ~~元数据表子树与表格视图~~ 已完成（2026-10-19，见 4.8）；Hex 视图的结构信息与 F12 跳转仍未做（光标、选区与直接改写已于 2026-10-18 完成，见 4.7）。
6. ~~GUI 的 Export to Project 接线~~ 已完成（2026-10-20，导出实现移到后端与命令行共用，见 4.4、4.17）。
7. ~~保存选项：保留 RID/堆、写 PDB、混合模式模块~~ 已完成（2026-10-18）；~~PE/Metadata/Cor20 覆盖页与 Save All 的进度/取消~~ 已完成（2026-10-19）。

**P3：扩展范围**

~~字符串引用窗口；程序集与模块属性对话框；资源新建与元素编辑~~（2026-10-18 前两项与元素编辑的主体已完成，图片与 ImageListStreamer 专用对话框于 2026-10-19 补上）；~~Memory、Disassembly、Processes 等调试窗口；Set Next Statement 与 Run to Cursor~~（2026-10-17 已完成）；~~脚本 `Resolve<T>` API~~（2026-10-18 已完成）；Mono/Unity 调试；扩展系统；更新检查。

## 6. 测试基线

2026-10-20 代码编辑器与文档标签补上选择边距、行压缩、虚拟空格与 Quick Info 图标后在本机重新跑过（真实构建 `dotnet build dnSpy.Backend.Host`、`pnpm build`）：后端 617 通过，前端 `tsc` 0 错误、vitest 1460 通过，e2e 110 通过、3 跳过、0 失败。这一轮给 `Protocol.cs` 中间的 `DocumentQuickInfoResponse` 加了 `Image`，e2e 钉死的 `get_Code @06000AD6` 变为 `@06000AD8`（Go to Token 的 `0x06000AD8` 同改），`RpcException @0200008D` 未动。并行跑时偶发的几条 e2e 一并修了测试一侧：Ctrl+End 之后点 Monaco 里的标记改为等标记的位置稳定后用鼠标坐标点击（`clickEditorToken`）——定位器的 `click()` 会先让 Chromium 把元素滚进视图，它滚的是 Monaco 那个 overflow:hidden 的可滚动元素，Monaco 下一次滚动事件才复位，按下却已落在偏移后的位置、而 Monaco 的命中测试仍按自己的滚动位置算，于是落到上方几行；主题子菜单的选择在窗口刚启动、菜单被关掉时整体重试。

此前，2026-10-20 反编译与语言补齐后在本机重新跑过（后端与前端都是真实构建：`dotnet build dnSpy.Backend.Host`、`pnpm build`）：

| 套件 | 结果 |
|---|---|
| 后端 `dotnet test` | 616 通过（反编译与语言补齐后；此前为 556、546、512、484、462、459、438、425、406、403、359）。连跑 10 次中有 2 次各失败一条：一次是 `ShowsThreadsAndTheirManagedFacts` 启动调试时 `DebugActiveProcess` 回 `CORDBG_E_TIMEOUT`（0x80131C08），另一次没有留下用例名；都是多个被调试进程并行启动时的偶发超时，重跑即过 |
| 前端 `tsc --noEmit`（`tsconfig.json`、`tsconfig.node.json`） | 0 错误 |
| 前端 vitest | 1452 通过（反编译与语言补齐后；此前为 1398、1369、1297、1279、1243、1225、1214、1201、1103、1095、1041） |
| e2e（Playwright Electron） | 106 通过、3 跳过、0 失败（反编译与语言补齐后重跑；此前为 101） |

反编译与语言这一轮改了 `Protocol.cs` 中间的记录（C# 设置 DTO 加反编译顺序并改为分支的默认值、IL 设置加 `MaxStringLength`、BAML 设置加 `DisassembleBaml`、`ResourceItemsRequest` 加 BAML 设置），连同此前未提交的导出项目等记录，e2e 钉死的标记变为 `RpcException @0200008D`、`get_Code @06000AD6`。C# 文档默认带 dnSpy 的 token 注释后，方法文档多出一行，调试器帧的行号（`DebugTarget.dll:N`）随之各加 1；IL 视图改为分支反汇编器的格式后，读 IL 着色与定位指令的 e2e 改为逐页翻到目标行再读（Monaco 只画视口内的行），IL 里单引号括起的名称按名称而不是字符串着色；等待遮罩的 e2e 改为反编译一个大类型（程序集节点照 WPF 只写头部，太快）。

这一轮 `Protocol.cs` 只在文件末尾追加（调试目标、断点文件、异步单步信息、可附加进程、内存模块目录），e2e 钉死的 `get_Code @06000ABA`、`RpcException @0200008C` 没有移动。DebugTarget 夹具新增 `ZDynamicFixture.cs`（`--emit` 时在模块初始化器里用 Reflection.Emit 建模块后退出），它的类型排在 `Program @02000002` 之后，Program 的嵌套类型因此各后移一行，方法标记不变。e2e 里断点行的名称改为 Breakpoints 窗口按 C# 格式化器写的「方法 + IL 偏移」；Debug 菜单的 Toggle Breakpoint 改为按代码视图的光标；Disassembly 改为文档标签；字形边距的右键只在有断点时出现断点菜单；关上下文菜单的 Escape 要等焦点进了菜单再按（并行跑时菜单晚一步取得焦点）。

2026-10-19 程序集编辑与元数据/PE 视图补齐后的记录：后端 546、前端 vitest 1369、e2e 101 通过 3 跳过。这一轮改了 `Protocol.cs` 中间的记录（`EditCommitResponse` 加修改文档列表、`OpenedModule` 加 `InMemory`、`HexTargetResponse` 加两个范围等），e2e 钉死的标记随之变为 `get_Code @06000ABA`（`RpcException @0200008C` 未动）。删除类型与成员按 WPF 先询问，e2e 用 `DNSPY_E2E_ASK_ANSWER=first` 回答「是」；Save Module 窗口打开时是模块自己的文件，e2e 经「...」（`DNSPY_E2E_SAVE_PATH`）改成测试的副本。PE 结构节点改为表单后，`pe-structure.spec.ts` 原先断言文本与「没有 IL」的两条改为字段改写并撤销、元数据表格与 Go to MD Table Row。

2026-10-18 程序集编辑补齐时的记录：

程序集编辑这一轮新增的 `Protocol.cs` 记录全部追加在文件末尾（方法体、资源、程序集/模块、保存选项、编译器），因此 e2e 钉死的 `RpcException @02000088`、`get_Code @06000A56` 没有移动。Hex 编辑器这一轮改了 `Protocol.cs`（三个请求/响应记录：位置解析、元数据定位、查找），e2e 里钉死的标记随之变为 `RpcException @02000088`、`get_Code @06000A56`（此前为 `@02000082`/`@060009EC`）。调试器这一轮把变量窗口的数字改成与 WPF 一样默认十六进制，e2e 里 Locals 的断言随之写成 `0x0000002A` 等。C# 交互窗口那一轮改了 `Protocol.cs` 的脚本记录（输出加颜色、评估响应加 generation、Reset 请求/响应、完整性请求、反向请求）。引擎的 JSON 回复改为驼峰命名（`DebugJson`），着色片段到前端是 `{ text, color }`。

复核前 HEAD 后端和前端都构建不过（见 4.11），所以那之前记的数字都来自更早的构建。改 `Protocol.cs` 后 e2e 里钉死的元数据标记变为 `RpcException @02000079`、`get_Code @0600095C`；整包导入 Monaco 带来的右键光标定位回归（「keeps the caret on what it was right-clicked on」）随 `monaco.ts` 改回 `editor.api` 消失。这一轮新增的用例见 4.10、4.11、4.14、4.15 各节末尾；分析器这次改 `Protocol.cs`（两个请求加语言参数、`TextColors.ILModule`）没有挪动这两个标记。

应用壳复核（2026-10-14）时前端新增的用例：窗口状态（`window-state.test.ts`）、窗口标题（`app-info.test.ts`）、命令行选项解析（`command-line-options.test.ts`）、缩放档位（`zoom.test.ts`）、背景图片的尺寸与位置（`background-image.test.ts`）、消息框的「不再提示」（`message-box.test.ts`）、工具窗口菜单（`ToolWindowTabContextMenu.test.tsx`）、输出窗口的命令栏（`ToolWindows.test.tsx`）、关于对话框与它引用的两份文本是否与出处一致（`AboutDialog.test.tsx`、`about-resources.test.ts`）。CI 现在会跑前端单测（`.github/workflows/cross-platform.yml` 的 Test frontend 步骤）。

此前记录的「后端 336 通过」之后的一次「346 通过」是 `--no-build` 跑在旧 DLL 上得到的；真实构建下当时有 22 条失败，已逐条按 WPF 行为修正（1 处后端缺陷、21 条过期断言），见 `docs/assembly-tree-frontend-integration.md`。

覆盖较好的部分：元数据编辑对话框、签名与自定义特性编解码、搜索、分析器、程序集树（键盘、图标、最近文件、命令行、Reload、移除与撤销）、断点判定与跟踪点、异常设置、书签。

明显的测试盲区：Monaco 编辑器功能（查找、悬停、折叠）、`JsonRpcServer` 的握手与分帧、方法体编辑器组件、调试器的 Pause；附加对话框、Memory 窗口、多进程的窗口与 Output 的过滤开关只有单测，没有 e2e（2026-10-20）。应用壳里，`--settings-file` 与 `-p`/`-pn` 只有单测、没有 e2e，系统高对比度切换只在单测里模拟；窗口状态与关闭询问有单测，但没有 e2e。

## 7. 与现有文档的出入

| 文档 | 说法 | 实际情况 |
|---|---|---|
| `docs/linux-release-1.0.md` | 调试「不含异常断点与表达式求值」 | 两者都已实现（4.13，表达式求值于 2026-10-17 补上） |
| `docs/linux-release-1.0.md` | 稳定版功能包含「ECMA-335 Metadata Tables」 | 2026-10-19 起属实：PE 树下有表流、各元数据表与表行，可查看与编辑（4.8） |
| `docs/linux-release-1.0.md` | 验证结果：.NET 13/13、Vitest 2/2、Electron 7/7 | 当前为 616 / 1452 / 106（见第 6 节） |
| `docs/linux-release-1.0.md` | 能力包含「嵌入资源替换」「结构化 IL 方法体编辑」 | 均属实；方法体现在可编辑局部变量、异常处理器与指令宏（4.12） |
| `docs/linux-support-plan.md` §3.2 | C#/VB 交互窗口在「独立子进程隔离执行环境」中运行 | 脚本在后端 Host 进程内执行，没有 VB（4.14） |
| `docs/linux-support-plan.md` §14 | 验收条件包含「恢复窗口尺寸」「查看监视表达式」 | 窗口尺寸与位置自 2026-10-14 起会恢复（4.1）；监视表达式仍未实现 |
| `docs/linux-support-plan.md` §8.2 | DTO 由 schema 生成 C# 与 TypeScript，CI 检查漂移 | 两边手写，没有生成与漂移检查（4.2） |
| `CrossPlatform/ASSEMBLY_EXPLORER_CHANGES.md` | PE 与 Type References 节点为「占位实现」 | 两者均已完整实现（4.3） |
