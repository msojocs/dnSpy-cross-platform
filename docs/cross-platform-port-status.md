# dnSpy 跨平台移植进度（对照 WPF 版）

> 审计日期：2026-10-12；程序集树（4.3）于 2026-10-13 按实现与测试复核，2026-10-14 补齐剩余差距后再次复核；应用壳与通用 UI（4.1）于 2026-10-14 按实现与测试复核；字符串引用窗口（4.11）与 Roslyn 语言服务（4.15）于 2026-10-16 按实现与测试复核；分析器（4.10）于 2026-10-16 补齐剩余差距后按实现与测试复核
>
> 代码基线：`linux` 分支，提交 `adeb8c1a9`
>
> 对照对象：WPF 版 `dnSpy/dnSpy/`、`Extensions/*`、`dnSpy/Roslyn/`、`dnSpy/dnSpy.Console/`；跨平台版 `CrossPlatform/`

本文按模块逐项对照 WPF 版用户可见功能，记录跨平台版（Electron/React 前端 + .NET 10 后端）的移植状态。结论来自只读代码审计，没有运行构建或测试；标「代码推断」的条目没有实测。4.1（应用壳）、4.3（程序集树）、4.10（分析器）、4.11（字符串引用窗口）与 4.15（Roslyn 语言服务）另有按实现与测试复核的一轮，这几节的结论以本机跑过的单测与 e2e 为准，见表内备注。

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
| 搜索窗口 | ~88% | 24 | 3 | 2 | 0 | 24 种搜索类型、选项、快捷键齐全；全局函数可搜；关闭窗口停止搜索；命令行参数缺失 |
| 应用壳与通用 UI | ~97% | 32 | 5 | 0 | 3 | 窗口状态、单实例、退出询问、工具窗口与标签组命令、缩放、背景图片、会话恢复（含光标与滚动位置）齐备；反编译设置已接通后端；Options 里 Environment 的字体只有一组 |
| 程序集树 | 100% | 30 | 0 | 0 | 1 | 全部功能点对齐 WPF：dnSpy 自己的图标集、完整键盘导航与输入查找、单文件最近列表、命令行打开与 `--select`、Reload All 恢复标签、移除程序集进撤销栈、GAC 解析 |
| 调试器 | ~47% | 30 | 21 | 35 | 4 | 启动、单步、断点、异常设置可用；没有表达式求值，多个窗口是占位 |
| 程序集编辑（AsmEditor） | ~51% | 29 | 12 | 28 | 2 | 元数据对话框完整；没有 C# 编辑，方法体编辑器很弱，保存无选项 |
| C# 交互窗口 | ~44% | 6 | 10 | 9 | 2 | REPL 主流程可用，输入有语义着色；脚本访问不到 dnSpy，输出一次性返回 |
| 元数据/PE 视图与本机反汇编 | ~38% | 7 | 2 | 12 | 0 | PE 头只读文本可看；元数据表子树完全缺失，反汇编未实现 |
| 反编译与语言 | ~44% | 6 | 11 | 9 | 1 | C# 完整；工具栏语言为全局并持久化；IL 格式简化但有定义/引用 span 与逐指令语句表，VB 无 span；无导出项目 |
| 代码编辑器与文档标签 | ~35% | 4 | 13 | 13 | 0 | F12、标签组可用；Monaco contrib 未打包，查找/悬停/折叠都不可用 |
| Hex 编辑器（浏览） | ~31% | 6 | 7 | 18 | 0 | 只读分页转储；没有光标、选区、直接改写 |
| Roslyn 语言服务 | ~69% | 3 | 5 | 0 | 0 | C# Interactive 有 WPF 同款语义着色；补全、Quick Info、签名帮助、诊断、智能缩进、选区已做成后端服务与可复用绑定，宿主 Edit Method (C#) 属 4.12 未移植 |
| 字符串引用窗口 | ~95% | 20 | 2 | 0 | 0 | 三类来源、过滤与选项、WPF 的排序语义、列重排与列宽、右键菜单、自动刷新齐备；来源列只按 C# 书写，IL/VB 视图跟随不定位语句 |
| dnSpy.Console 命令行 | 0% | 0 | 0 | 12 | 0 | 没有对应 CLI，后端也没有导出项目能力 |
| 扩展系统 | 不计 | 1 | 0 | 1 | 9 | 按计划首版不支持第三方扩展；内置功能直接编进程序 |
| 其他杂项 | 不计 | 3 | 3 | 1 | 7 | 多为 WPF/Windows 基础设施；更新检查缺失 |
| 工程基础设施（新增） | ~83% | 8 | 4 | 0 | 0 | 协议、安全、三平台打包、CI 发布已就绪；CI 不跑前端单测 |

**整体**：除「工程基础设施」外，把上表各模块（含「不计」的两行）逐行相加，合计 ✅ 248 / 🟡 94 / ❌ 140 / ⛔ 30，完成度约 **61%**（2026-10-16 分析器补齐前为 ✅ 243 / 🟡 99 / ❌ 140 / ⛔ 30；2026-10-14 程序集树复核后为 ✅ 200 / 🟡 109 / ❌ 170 / ⛔ 30；2026-10-14 晚反编译设置接通后为 ✅ 218 / 🟡 98 / ❌ 163 / ⛔ 30；2026-10-15 会话恢复光标与滚动位置后为 ✅ 219 / 🟡 97 / ❌ 163 / ⛔ 30；2026-10-14 字符串引用窗口完成后为 ✅ 238 / 🟡 97 / ❌ 144 / ⛔ 30；2026-10-15 Roslyn 语言服务完成后为 ✅ 242 / 🟡 96 / ❌ 141 / ⛔ 30——这两次「完成」都没有接通，2026-10-16 按实现与测试复核、重写后即为本行的数字）。这一行由上表直接求和，不再逐次增减维护。

### 1.2 按工作流看

| 工作流 | 可用程度 | 说明 |
|---|---|---|
| 打开程序集、浏览树、看 C# 代码、F12 跳转 | 日常可用 | 交互模型与 WPF 不同：双击才打开，每个节点一个标签 |
| 看 IL / VB | 能看，不好用 | IL 是简化格式，指令的操作数可以跳转，但不能下断点；VB 不能跳转 |
| 搜索、分析引用 | 日常可用 | 两块是移植最完整的部分 |
| 改名、改元数据、增删成员 | 日常可用 | 五类成员的选项对话框与 WPF 逐页对齐 |
| 改方法体 | 风险大 | 无 C# 编辑；IL 编辑器不能编辑局部变量和异常处理器，带 try/catch 的方法会丢 EH |
| 保存 | 基本可用，有缺陷 | 多模块时保存目标错误；无写出选项，不保留 RID，混合模式程序集无法正确保存 |
| 调试 .NET (CoreCLR) 程序 | 基础可用 | 断点、单步、调用栈、Locals 可用；看不了对象字段，没有 Watch |
| 元数据表、Hex 修改 | 基本不可用 | 只有 PE 头只读文本与只读 hex 转储 |
| 脚本、批处理导出 | 很有限 | REPL 不能操作已打开的程序集，没有 CLI，也没有导出项目 |

## 2. 跨模块问题

这些问题不属于某一个模块，但拉低了多个模块的完成度，修一处能同时改善好几块。

1. ~~**仍有一组选项页只保存、不生效。**~~ **已修复（2026-10-14）**：`DecompileRequest` 现在包含 `DecompilerSettingsDto` 字段，前端在调用反编译时会传递用户的 C#、IL 和 BAML 设置，后端通过 `DecompilerSettingsMapper` 应用这些设置。`DecompileFullType` 和 `UseMemoryMappedIO` 现在会被传递给后端。注意：由于使用的是 NuGet 版 `ICSharpCode.Decompiler 11.1`，某些 WPF dnSpy 特有的选项（如 `ShowTokenAndRvaComments`、`SortMembers` 等）在基础 ILSpy 中不存在，暂时被忽略。仍改了没效果的是：
   - 文本编辑器、Hex 编辑器、Disassembler / Code Style、书签语法高亮、REPL；
   - 调试器选项（JIT 优化抑制、Just My Code、忽略 Debugger.Break、忽略未处理异常等）；
   - Output 的来源、General 的版本号与 PublicKeyToken 等程序集树页选项。

   此外 General 页的 `CheckForUpdatesOnStartup` 没有对应功能（⛔）。

2. **Monaco 的 contrib 没有打包。** `FE/monaco.ts` 只导入 `monaco-editor/editor/editor.api`，构建产物里也找不到 find、hover、folding、wordHighlighter、gotoLine、bracketMatching 等模块。因此所有 Monaco 实例（代码视图、C# Interactive）都没有查找替换、悬停、折叠、括号匹配、转到行、缩放。Edit→Find 已经接线，但 `getAction('actions.find')` 返回 undefined，什么也不做。修法是改为导入 `editor.main`，或按需导入 `contrib/*`。

3. **VB 文档没有 span 与语句表，IL 的只有一部分。** C# 反编译生成引用 span 和语句到 IL 的映射（`BE/StatementIlRanges.cs`）。IL 视图（含 IL with C#）有逐指令的语句表、成员声明处的定义 span，以及（2026-10-16 起）每条指令操作数所指成员的引用 span，所以 IL 里可以跳转、书签可以挂到指令上、分析器的「显示方法内的引用」会落到操作数上；但断点仍只按 C# 的语句表下。VB 是 C# 文本的转换，没有任何 span 与语句表（方法文档还会变成空壳类），因此 VB 视图里不能跳转、不能下断点，搜索和分析器结果只打开方法。IL 输出由自写的简化 `ILFormatter` 生成（没有 `.try`、`.custom` 等），改用 ICSharpCode 的 `ReflectionDisassembler` 可以解决格式。

4. ~~**菜单上标了快捷键却没有绑定。**~~ 2026-10-14 已修：菜单上标出的快捷键都接上了——Ctrl+Alt+L、Alt+2、Ctrl+D（转到元数据标记，dnSpy 在树上和文档视图里都用这个键）、Ctrl+E Ctrl+W、Alt+Numpad*、Ctrl+Alt+P、Ctrl+Alt+Break、Ctrl+Alt+B/E/C/H/U/Z、Alt+4、Alt+8，Shift+Alt+Enter 不再被 Alt+Enter 的分支截住（原先还有个 WPF 没有的 F11 全屏，一并去掉），Ctrl+Tab 与 Ctrl+Shift+Tab 也补上了。仍未绑的只剩十六进制只读视图里的几个（Ctrl+X、Ctrl+Shift+D 等，本移植版不能改字节）。主菜单现在可以用键盘操作。

5. **程序集树的多选只有部分命令用上。** 树已支持 Ctrl/Shift 多选和键盘扩选，Remove Assembly、保存资源、Search MSDN、分析（2026-10-16 起）作用于整个选区；但位置为「选中文件 / 选中类型」的搜索、删除类型与成员、多节点合并反编译仍只看一个节点。

6. ~~**未保存修改的保护不完整。**~~ 2026-10-14 已修：有未保存修改时关闭窗口，主进程会拦下这次关闭并反问「是否要在继续之前保存？」（是 / 否 / 取消），取消则留在原地。Reload All 与移除程序集仍按 WPF 各自询问，措辞与本移植版的其它对话框一致。

7. **图标与本地化。** 程序集树、分析器、搜索结果、类型选择器、工具栏、工具窗口菜单与输出窗口按钮都已用 dnSpy 自己的图标集（`dnSpy/dnSpy.Images` 的 XAML 矢量图转成 SVG，按 dnSpy 的 ThemedImageCreator 算法随主题背景换色）；主菜单、其余工具窗口内部仍是 lucide-react。界面语言只有 English 和简体中文，WPF 有 15 种。

## 3. 审计中发现的疑似缺陷

下表是审计过程中顺带发现的行为问题，不是缺失功能。「已核实」表示读代码确认了因果链，「代码推断」表示没有完整核实或依赖运行时行为。

| # | 问题 | 位置 | 依据 |
|---|---|---|---|
| 1 | 打开多个程序集时，File→Save / Save Module… 总是保存第一个模块。`currentModule` 要求选中节点是 `module` 且 id 等于 `OpenedModule.id`，但 `OpenedModule.id` 是 `assembly` 根节点的 id，二者永远对不上，总是退回 `modules[0]`。单测夹具把模块行当成了根节点，所以没暴露 | `FE/app-store.ts` 的 `currentModule`；`BE/WorkspaceManager.cs` 中 `module.Id = root.Id` | 已核实 |
| 2 | 停止调试会杀掉附加的进程。WPF 对附加的进程默认分离；移植版 `stopDebug` 一律以 `terminateDebuggee=true` 断开，前端也没有 Detach 入口 | `FE/app-store.ts` 的 `stopDebug` | 已核实 |
| 3 | 保存单个模块会清掉全局 `dirty`，即使其他模块仍有修改 | `FE/app-store.ts` 保存逻辑 | 代码推断 |
| 4 | IL 编辑器从不重算 MaxStack。前端总是回传 `maxStack`，后端因此设 `KeepOldMaxStack = true`，加指令后栈深可能不够 | `BE/WorkspaceManager.cs` 方法体替换 | 代码推断 |
| 5 | ~~Raw Save Resource 与 Save Resource 写出相同的字节：主进程丢掉了 `raw` 参数~~ 已修复（2026-10-13）：改走 `resource/getItems`，`raw` 一路传到后端 | `MAIN/index.ts` 的 `edit:saveResource` | 已核实 |
| 6 | PE-only、ELF、未知文件的 Open Hex Editor 读不出数据：`GetHexLength` / `ReadHexAsync` 走 `GetModule()`，对这三类文件抛异常 | `BE/WorkspaceManager.cs` | 代码推断 |
| 7 | 不属于任何成员的 Raw hex 补丁，保存时仍用原文件偏移；dnlib 重写文件后可能写错位置 | `BE/WorkspaceManager.cs` 保存时的补丁重定位 | 代码推断 |
| 8 | C# Interactive 的 Reset 不能恢复不响应取消的脚本：`ResetAsync` 不释放执行信号量，后续提交排队到 600 秒 IPC 超时；被重置会话的旧输出仍会追加到日志 | `BE/Scripting/CSharpScriptService.cs` | 代码推断 |
| 9 | ~~基类型行不能分析：前端 `isAnalyzableNode` 不含 `basetype`，而后端已支持~~ 已修复（2026-10-16）：基类型行可分析，菜单打开前向后端确认引用能解析（WPF 的 CanAnalyze），解析不了的不显示「分析」 | `FE/components/CodeEditorContextMenu.tsx`、`FE/components/AssemblyExplorer.tsx` | 已核实 |
| 10 | 编辑器里单击引用时光标显示为手形，但只有 Ctrl+单击才跳转，而且在同一标签里跳（WPF 单击跳转，Ctrl+单击开新标签） | `FE/components/DocumentView.tsx` 的 `onMouseDown` | 代码推断 |

## 4. 各模块明细

### 4.1 应用壳与通用 UI 框架

完成度约 97%（✅ 32 / 🟡 5 / ❌ 0 / ⛔ 3）。WPF 范围：`WPF/MainApp`、`Menus`、`ToolBars`、`ToolWindows`、`Tabs`、`Themes`、`Settings`、`Culture`、`BackgroundImage`、`Output`、`FileLists`、`Commands`。

2026-10-14 按实现与测试复核。此前这一节有 7 个 ❌ 与 17 个 🟡；补上的部分：窗口状态记忆、单实例与参数转发、退出时的未保存询问、工具窗口与标签组的右键命令、标签内容缩放、背景图片渲染、Environment 的字体与 RestoreTabs、主菜单键盘操作、标签快捷键与全局快捷键、关于与帮助菜单、输出窗口的命令栏、消息框的「不再提示」、工具栏与部分图标、**反编译器设置传递给后端（2026-10-14 晚）**。

仍有的差距集中在三处：dnSpy 的 `.dntheme` 主题文件不能加载，界面语言只有两种；菜单与部分工具窗口的图标仍是 lucide；部分 WPF dnSpy 特有的反编译选项在 NuGet 版 ILSpy 中不存在。

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| 主窗口与自绘标题栏 | `MainApp/MainWindow.xaml`、`AppWindow.cs` | `MAIN/index.ts`（`frame:false`）、`FE/components/WindowControls.tsx` | ✅ | 标题按 `AppWindow.GetDefaultTitle` 写成 "dnSpy 6.6.0 (64-bit, .NET, Administrator)"，随界面语言变 |
| 窗口位置、尺寸、最大化记忆 | `MainApp/SavedWindowState.cs` | `MAIN/window-state.ts` | ✅ | `userData/window-state.json`；还原前按 dnSpy 的 50×50 规则看是否仍落在某个显示器上，落不上用默认的 10,10,1300,730；最大化与全屏各记各的，取其一 |
| 命令行参数 | `MainApp/AppCommandLineArgs.cs` | `MAIN/command-line.ts`、`FE/command-line-options.ts` | 🟡 | 文件路径、`--`、`--multiple`、`--dont-activate`、`-l`、`--culture`、`--select`、`--new-tab`、`--theme`、`--search*`、`--no-load-files`、`--full-screen`、`--show/hide-tool-window`（含 `!location`）、`--show-startup-time` 都生效；`-p`/`-pn`/`-e` 是 Windows 的 JIT 调试入口，`--settings-file` 与 `--extension-directory` 没有对应物，只被读下不生效 |
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
| 主题 | `Themes/ThemeService.cs`、`*.dntheme` | `FE/App.tsx`、`styles.css` | 🟡 | 四个主题可切换，且与 Options 的 Theme 共用同一份存储（原先两套）；仍不能加载 `.dntheme`，Blue 主题的编辑器配色与 WPF 不同 |
| 界面语言 | `Culture/CultureService.cs` | `FE/localization.tsx` | 🟡 | 只有 English、简体中文（WPF 15 种） |
| Options 对话框框架 | `Settings/Dialog/AppSettingsDlg.xaml` | `OptionsDialog.tsx`、`options-pages.ts`、`app-options.ts` | ✅ | 框架完整；反编译器设置现已传递给后端并生效（见第 2 节第 1 条更新）；仍有页面不生效的是文本编辑器、Hex 编辑器、调试器等 |
| Environment › General | `MainApp/Settings/GeneralAppSettingsPage.cs` | `options-pages.ts` | ✅ | Theme、Allow more than one instance、RestoreTabs、DecompileFullType、UseMemoryMappedIO 均已生效；CheckForUpdates 没有对应功能，选项仍在（⛔） |
| Environment › Font | `MainApp/Settings/FontAppSettingsPage.cs` | `options-pages.ts`、`CodeEditor` 的 options | 🟡 | 字体族与字号现在驱动代码视图与 C# 交互窗口（此前写死 Cascadia Mono 13）；WPF 那一页是按外观分类（文本编辑器、UI、Hex…）逐项配字体与颜色，本移植版只有一组，对应其中的文本编辑器 |
| 背景图片 | `BackgroundImage/*` | `FE/components/BackgroundImage.tsx`、`MAIN/background-images.ts` | ✅ | 图片与文件夹路径、九个位置、四边百分比边距、偏移、不透明度、Stretch 与 StretchDirection、最大尺寸、缩放、随机轮播与间隔；主进程展开文件夹并把图片读成 data URL。图片开启时编辑器背景透明，图片显示在代码后面（dnSpy 画在每个文本视图里）；Hex 视图仍是不透明的 |
| Output 窗口 | `Output/*` | `FE/components/ToolWindows.tsx` 的 `OutputPane` | 🟡 | 有清空、另存为、自动换行（按窗口单独记录）；没有来源切换——本移植版只有一路日志，没有多条缓冲可切 |
| 消息框 | `MainApp/MessageBoxService.cs` | `FE/message-box.ts`、`MAIN/index.ts` | 🟡 | 「不再提示」已实现（`ShowIgnorableMessage` 的语义：抑制后按「继续」，抑制清单随选项一起存，Reset 会清掉）；dnSpy General 页的「Enable all warning messages」按钮没有对应物，只有一条消息用它 |
| 关于 | `MainApp/AboutScreen.cs`、`LicenseInfo/*` | `AboutDialog.tsx` | ✅ | 标题按 `AboutScreen` 写成 "dnSpy <版本> (.NET)"，版本读打包版本；鸣谢与第三方许可折在对话框里，内容取自 `dnSpy/dnSpy/LicenseInfo/CREDITS.txt` 与 `CrossPlatform/packaging/licenses/THIRD-PARTY-NOTICES.md`（有单测比对副本是否过期）。dnSpy 那一页还会列出已加载的扩展程序集与一个「Check for updates」按钮：本移植版没有扩展可列，更新也不在范围内 |
| 帮助链接 | `MainApp/AboutCommands.cs` | `MenuBar.tsx` | ✅ | 与 dnSpy 的项一致：最新发布、问题、Wiki、源代码 |
| 启动时检查更新 | `MainApp/StartupUpdateCheck.cs` | 无 | ⛔ | 计划写明「更新机制不进入 MVP」；但 General 页仍留着无效的复选框 |
| Windows 资源管理器集成 | `MainApp/Settings/WindowsExplorerIntegration.cs` | 无 | ⛔ | 注册表功能；Linux 的 .desktop 也没声明 MimeType |
| MEF 扩展加载 | `Extension/ExtensionService.cs` | 无 | ⛔ | 见 4.16 |
| 图标服务 | `Images/ImageService.cs` | `FE/ds-image.ts`、`FE/components/DsIcon.tsx`；其余 lucide-react | 🟡 | 树类行、工具栏、工具窗口菜单、输出窗口按钮用 dnSpy 图标集并按主题换色；主菜单与其余工具窗口仍是 lucide |
| 全局快捷键 | `Commands/CommandService.cs` | `FE/App.tsx` 的 keydown 处理 | ✅ | 菜单上标出的都已绑定；Go to Token 改回 dnSpy 的 Ctrl+D；Shift+Alt+Enter 不再被 Alt+Enter 截住。仍未绑定的是十六进制只读视图里的几个（Ctrl+X 等，本移植版不能改字节） |
| 设置存储 | `Settings/SettingsService.cs` | localStorage 的 `dnspy.*` 键 | ✅ | 不支持 `--settings-file` 和便携模式 |

测试：`MenuBar.test.tsx`、`OptionsDialog.test.tsx`、`DockPane.test.tsx`、`DocumentTabContextMenu.test.tsx`、`ToolWindowTabContextMenu.test.tsx`、`WindowsDialog.test.tsx`、`AboutDialog.test.tsx`、`ToolWindows.test.tsx`、`command-line-options.test.ts`、`zoom.test.ts`、`background-image.test.ts`、`message-box.test.ts`、`window-state.test.ts`、`app-info.test.ts`、`app-settings.ts`（无单测）、`app-store-session.test.ts`（含光标与滚动位置恢复测试） 等；e2e `layout.spec.ts`、`session-close.spec.ts`。反解码器选项是否生效、Output 的来源切换、`.dntheme`、图标替换的其余部分都还没有测试。

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
| Export to Project | `Documents/Tabs/Dialogs/ExportToProjectDlg.xaml` | `file-menu.ts`（恒灰） | ❌ | 库自带的 `WholeProjectDecompiler` 没用上 |
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

完成度约 31%（✅ 6 / 🟡 7 / ❌ 18）。WPF 范围：`WPF/Hex/`，以及 `AE/Hex/` 中的「Show in Hex Editor」等定位命令。从节点出发的 Hex 写入见 4.12。

Hex 视图（`FE/components/SpecialDocuments.tsx` 的 `HexView`）是只读的分页转储：每页 4 KiB、每行 16 字节，带 ASCII 列，可以高亮一段范围，没有光标和选区。

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| Open Hex Editor | `AE/Hex/Commands.cs` | `hex-menu.ts`，RPC `hex/getLength`、`hex/readRange` | 🟡 | 托管模块可用；PE-only/ELF/未知文件读不出（缺陷 #6） |
| Show Instructions in Hex Editor（当前语句） | 同上 | RPC `hex/resolveStatement` | ✅ | |
| Show Instructions / Method Body / Initial Value | 同上 | RPC `hex/resolveTarget`、`BE/HexTargets.cs` | ✅ | |
| Show in Hex Editor（资源） | 同上 | `ResolveResourceTarget` | 🟡 | 只认 EmbeddedResource |
| Show in Hex Editor（地址引用） | 同上 | 隐藏 | ❌ | |
| Hex Write return true/false/空方法体 | 同上 | `edit/hexPatch` | ✅ | 与 4.13 重复计入 |
| Hex Copy / Paste Method Body | 同上 | `hexCopyMethodBody` 等 | ✅ | 与 4.13 重复计入 |
| 字节显示 | `Hex/Editor/WpfHexViewImpl.cs` | `HexView` | 🟡 | 每行字节数、大小写写死；列不能开关 |
| 滚动 | `Hex/Editor/HexViewScrollerImpl.cs` | 翻页按钮 | 🟡 | 只能按 4 KiB 翻页 |
| Go to Position | `Hex/Commands/GoToPositionDlg.xaml` | 工具栏偏移框 | 🟡 | 只认十六进制文件偏移 |
| Go to Metadata | `Hex/Commands/GoToMetadataDlg.xaml` | 无 | ❌ | |
| Select | `Hex/Commands/SelectDlg.xaml` | 无 | ❌ | |
| 光标与选区 | `Hex/Editor/HexCaretImpl.cs`、`HexSelectionImpl.cs` | 无 | ❌ | |
| 直接键入改字节 | `Hex/Operations/HexEditorOperationsImpl.cs` | 无 | ❌ | 后端 `edit/hexPatch` 已能接受模块级补丁，缺界面 |
| 撤销 / 重做 | `AE/Hex/HexBufferUndoRedo.cs` | `edit/undo`、`edit/redo` | ✅ | |
| 删除 / 清零 | `Hex/ContextMenuCommands/Commands.cs` | 无 | ❌ | |
| Fill Selection | 同上 | 无 | ❌ | |
| Copy / Copy Special | 同上、`Hex/Operations/ClipboardUtils.cs` | 无 | ❌ | |
| Paste / Paste Special | 同上 | 无 | ❌ | |
| 查找 / 替换 | `Hex/Editor/Search/HexViewSearchService.cs` | 无 | ❌ | |
| 右键「每行字节数」「值格式」 | `Hex/ContextMenuCommands/Commands.cs` | 无 | ❌ | 视图没有右键菜单 |
| 本地设置对话框 | `Hex/Commands/LocalSettingsDlg.xaml` | 无 | ❌ | |
| Save Selection | `Hex/ContextMenuCommands/Commands.cs` | 无 | ❌ | |
| 只显示选中字节 | 同上 | 无 | ❌ | |
| Refresh | 同上 | 编辑后自动重读 | 🟡 | |
| 结构信息（悬停、结构高亮） | `Hex/Files/*`、`Hex/Intellisense/*` | 无 | ❌ | |
| F12 跳到代码、Follow 引用、Edit Field | `Hex/ContextMenuCommands/*` | 无 | ❌ | |
| 命中范围高亮 | `Hex/Editor/HexMarkerService.cs` | `hex-byte-marked` | ✅ | |
| Hex 选项页 | `Hex/HexEditor/*AppSettingsPage.cs` | `options-pages.ts` | 🟡 | 不生效 |
| 当前行高亮、列分隔线、缩放 | `Hex/Editor/CurrentLineHighlighter.cs` 等 | 无 | ❌ | |
| Hex 标签跨会话恢复 | `AE/Hex/HexViewUIStateSerializer.cs` | 无 | ❌ | |

测试：后端 `WorkspaceManagerTests.cs`（有界读取、目标解析、补丁读回）；`SpecialDocuments.test.tsx`；e2e 覆盖 hex 写方法体并撤销、在 hex 中打开指令、`4D 5A` 断言。PE-only/ELF 的读取没有测试。

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

完成度约 88%（✅ 24 / 🟡 3 / ❌ 2）。WPF 范围：`WPF/Search/`。后端的匹配器、过滤器、遍历器（`BE/Search/`）逐段对照 WPF 移植。

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| 打开窗口（Ctrl+Shift+K、菜单、工具栏） | `Search/Commands.cs` | `FE/App.tsx`、`edit-menu.ts`、`ToolBar.tsx` | ✅ | |
| 打开后聚焦并全选 | `Search/SearchService.cs` | `search-store.ts` 的 `requestFocus` | ✅ | |
| 边输入边搜（500ms） | `Search/SearchControlVM.cs` | `search-store.ts` | ✅ | 另加 Enter 立即搜 |
| 搜索类型 24 项 | `Search/SearchType.cs` | `FE/search-model.ts`、`BE/Search/SearchFilter.cs` | ✅ | 原生 select，下拉项无图标 |
| 位置 4 项 | `Search/SearchControlVM.cs` | `BE/WorkspaceManager.Search.cs` | 🟡 | 树单选，只按一个节点算 |
| 选项 6 个复选框 | `Search/SearchControl.xaml` | `SearchPane.tsx` | ✅ | |
| 名称匹配（分词、全词、大小写、正则） | `dnSpy.Contracts.DnSpy/Search/SearchComparers.cs` | `BE/Search/SearchComparers.cs` | ✅ | |
| 字面量匹配 | 同上、`Search/FilterSearcher.cs` | `SearchComparers.cs`、`FilterSearcher.cs` | ✅ | |
| 遍历与过滤语义 | `Search/FilterSearcher.cs` | `BE/Search/FilterSearcher.cs` | ✅ | 包含 `<Module>` 全局函数和字段；模块引用结果无法跳转 |
| 资源搜索（含 BAML） | `Search/FilterSearcher.cs` | `ResourceTexts.cs`、`DecompileBaml` | ✅ | |
| 在框架程序集中搜索 | `FrameworkFileUtils` | `BE/Search/FrameworkAssemblies.cs` | ✅ | |
| 搜索编译器生成的成员 | `FilterSearcher.IsCompilerGenerated` | `BE/Search/CompilerGeneratedMembers.cs` | ✅ | 不随反编译器选项变化 |
| 结果列表（图标、高亮、排序） | `Search/SearchResult.cs` | `SearchResultFormatter.cs`、`SearchPane.tsx` | ✅ | 按视口渲染 |
| 结果文本随语言变化 | `Search/SearchService.cs` | 无 | 🟡 | 固定 C# 写法 |
| 结果提示 | `SearchResult.CreateToolTipUI` | `SearchToolTip` | 🟡 | 纯文本，缺成员签名 |
| 边搜边出 | `Search/DocumentSearcher.cs` | RPC `search/run` + `search/progress` | ✅ | 单线程切片 |
| 上限 10,000 与红框 | 同上 | `BE/Search/SearchRun.cs` | ✅ | |
| 跟随结果（含方法体内定位） | `SearchService.FollowResult` | `SearchPane.tsx`、`findSearchResultCaret` | 🟡 | 只在 C# 视图定位到语句 |
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
| 命令行 `--search*` | `Search/AppCommandLineArgsHandler.cs` | 无 | ❌ | |

测试：后端 `WorkspaceSearchTests.cs` 21 条（新增全局函数和字段测试）；前端 `search-model.test.ts`、`search-store.test.ts`、`SearchPane.test.tsx`；e2e 3 条。

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

整体完成度约 51%（✅ 29 / 🟡 12 / ❌ 28 / ⛔ 2）。WPF 范围：`Extensions/dnSpy.AsmEditor/` 全部子目录。

元数据编辑最完整：五类成员的编辑、新建、删除对话框与 WPF 逐页对齐，命名空间操作和事务式撤销也很扎实。差距集中在 Roslyn 源码编辑、方法体编辑器、资源新建与元素编辑、程序集/模块对话框、保存选项。

| 子模块 | 完成度 | ✅ | 🟡 | ❌ | ⛔ |
|---|---|---|---|---|---|
| Namespace | ~100% | 3 | 0 | 0 | 0 |
| Types / Method / Field / Property / Event | ~100% | 5 | 0 | 0 | 0 |
| 通用对话框（DnlibDialogs、ViewHelpers） | ~79% | 5 | 1 | 1 | 0 |
| Commands（菜单落位与杂项命令） | ~75% | 4 | 1 | 1 | 1 |
| UndoRedo | ~83% | 4 | 2 | 0 | 0 |
| Hex（修改能力） | ~44% | 3 | 1 | 4 | 0 |
| Module | ~38% | 1 | 1 | 2 | 0 |
| SaveModule | ~33% | 1 | 2 | 3 | 0 |
| MethodBody | ~28% | 1 | 3 | 5 | 0 |
| Resources | ~21% | 1 | 1 | 5 | 0 |
| Assembly | ~33% | 1 | 0 | 2 | 1 |
| Compiler（C# 编辑） | 0% | 0 | 0 | 5 | 0 |

#### Assembly、Module、Namespace

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| Edit Assembly… | `AE/Assembly/AssemblyCommands.cs`、`AssemblyOptionsVM.cs` | `edit-menu.ts`（灰显） | ❌ | 后端选项模型不含 assembly |
| Create Assembly… | 同上 | 灰显 | ❌ | |
| Remove Assembly | 同上 | RPC `workspace/removeModules` | ✅ | 作用于选中的全部根行；撤销历史涉及的文档，移除记为可撤销的一步，见 4.3 |
| Disable Memory Mapped I/O | 同上 | 隐藏 | ⛔ | 后端没有内存映射 |
| Edit Module… | `AE/Module/ModuleCommands.cs`、`ModuleOptionsVM.cs` | 灰显 | ❌ | |
| NetModule 新建、添加、移除 | 同上、`NetModuleOptionsVM.cs` | 隐藏 | ❌ | 树分不清 netmodule 与程序集模块 |
| 程序集转 NetModule | 同上 | RPC `edit/convertModule` | ✅ | 可撤销 |
| NetModule 转程序集 | 同上 | 后端已实现，前端无入口 | 🟡 | |
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

「Edit Method Body…」打开的是 `FE/components/EditDialogs.tsx` 的 `MethodBodyEditor`：四列文本网格，通过 RPC `edit/replaceMethodBody` 整体替换。

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| 方法体类型（None/CIL/Native）、给无体方法加 body | `AE/MethodBody/MethodBodyVM.cs` | 无体时直接报错 | ❌ | 只能先 Replace with stub 再编辑 |
| CIL 头选项 | `CilBodyVM.cs` | MaxStack、InitLocals | 🟡 | 实际恒保留旧 MaxStack（缺陷 #4） |
| 指令表编辑 | `InstructionsListHelper.cs` | 文本网格 | 🟡 | 只能追加或删除行；没有插入、移动、剪贴板 |
| 操作数编辑 | `InstructionOperandVM.cs`、`SwitchOperandDlg` | 十六进制 token、标签、索引 | 🟡 | 没有选择器；不能新建 MemberRef；不支持 calli 的 `InlineSig` |
| 局部变量页 | `LocalVM.cs` | 无 | ❌ | 不能增删局部变量 |
| 异常处理器页 | `ExceptionHandlerVM.cs` | 只有「清空异常处理器」 | ❌ | 编辑带 try/catch 的方法必然丢掉全部 EH |
| 指令宏（Simplify/Optimize、NOP、反转分支等） | `InstructionsListHelper.cs` | 无 | ❌ | |
| Edit IL Instructions（按选中语句） | `MethodBodyCommands.cs` | 隐藏 | ❌ | |
| Replace Method Body with stub | `MethodBodyCommands.cs` | RPC `edit/replaceMethodBodyWithStub`、`BE/MethodBodyStub.cs` | ✅ | |

#### Compiler（Roslyn 源码编辑）

以下 5 项全部未实现，菜单只有灰显占位：Edit Method (C#)、Edit Class / Add Class Members / Add Class (C#)、Edit Assembly Attributes (C#)、Merge with Assembly、编译器选项页。WPF 实现在 `AE/Compiler/`（`EditMethodCodeVM.cs`、`ModuleImporter.cs`、`ModulePatcher.cs` 等）。

文档里没有「不做」的决定，后端也已引用 `Microsoft.CodeAnalysis.CSharp.Scripting`，Roslyn 在 Linux 上可用，所以记为 ❌ 而不是 ⛔。这是 dnSpy 最常用的编辑方式之一，也是本模块最大的缺口。编辑器要用的语言服务（补全、Quick Info、签名帮助、诊断、智能缩进、选区）已在 4.15 做成后端服务与 `attachRoslynDocument` 绑定，移植这个编辑器时可以直接接上。

#### 资源、Hex 修改、保存、撤销

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| Delete Resource | `AE/Resources/ResourceCommands.cs` | RPC `edit/delete` | ✅ | |
| Delete Resource Element | 同上 | 灰显 | ❌ | |
| Edit Resource（名称、可见性、链接属性） | `ResourceVM.cs` | 同名菜单实为「用文件替换字节」，RPC `edit/replaceResource` | 🟡 | 属性改不了；字节替换是新增能力 |
| Edit Resource Element（字符串、图片、序列化对象等） | `ResourceElementVM.cs` 等 | 灰显 | ❌ | |
| Create File / Multi File Resource | `ResourceCommands.cs` | 灰显 | ❌ | |
| Create Assembly / File Linked Resource | 同上 | 灰显 | ❌ | |
| 新建资源元素 | 同上 | 灰显 | ❌ | |
| Hex Write return true/false/空方法体 | `AE/Hex/Commands.cs` | `hex-menu.ts` → RPC `edit/hexPatch` | ✅ | |
| Hex Copy / Paste Method Body | 同上 | 剪贴板传十六进制文本 | ✅ | |
| Hex 修改接入撤销与保存 | `AE/Hex/HexBufferUndoRedo.cs` | 补丁作为事务操作，保存时重定位 | ✅ | 见缺陷 #7 |
| Hex 视图里直接改写、粘贴、填充 | `WPF/Hex/ContextMenuCommands/Commands.cs` | 无 | ❌ | |
| Go to Offset / Metadata / 选择 | 同上 | 偏移输入框 | 🟡 | |
| 单独保存 Hex 文档、改非 .NET 文件 | `AE/Hex/HexTabSaver.cs` | 后端拒绝 PE-only 文件 | ❌ | |
| 编辑 PE 头与元数据表字段 | `AE/Hex/Nodes/*`、`AE/Hex/PE/*VM.cs` | 无 | ❌ | |
| MD 表命令与 Go to MD Table Row | `AE/Hex/MDTableContextMenuCommands.cs` | 灰显 | ❌ | |
| Save Module… | `AE/SaveModule/SaveModuleCommand.cs` | 原生另存为对话框，RPC `module/saveAs` | 🟡 | 没有选项；多模块时目标错误（缺陷 #1） |
| Save All | 同上、`SaveMultiModuleVM.cs` | RPC `module/saveAll` | 🟡 | 不列出模块、无进度、不能取消 |
| 原地覆盖原文件 | `AE/SaveModule/DocumentSaver.cs` | RPC `module/save` | ✅ | 写临时文件、重新加载校验后原子替换 |
| Mixed-mode 保存 | `SaveModuleOptionsVM.cs` | 只调 `Module.Write` | ❌ | C++/CLI 程序集无法正确保存 |
| 写 PDB | 同上 | 无 | ❌ | |
| 写出选项（保留 RID/堆、校验和、Win32 资源等） | 同上 | 无，全用 dnlib 默认值 | ❌ | 保存后 token 会被重排 |
| Undo / Redo | `AE/UndoRedo/*` | RPC `edit/undo`、`edit/redo` | ✅ | |
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
| 手工构造 MemberRef / MethodSpec | `MemberRefVM.cs`、`MethodSpecVM.cs` | 无 | ❌ | |
| 列表编辑控件 | `ListVM.cs` | `ListEditor.tsx` | ✅ | |
| 命令在三处菜单里的落位 | `AE/Commands/*MenuHandler.cs` | `edit-menu.ts`、两个右键菜单 | ✅ | |
| 多选批量操作 | `AE/Commands/DeletableNodes.cs` | 树支持多选 | 🟡 | Remove Assembly 作用于整个选区；删除类型/成员仍只删一个 |
| Copy MD Token / Full Name | `WPF/Documents/Tabs/CopyTokenCommand.cs` | 树和代码视图菜单 | ✅ | |
| Copy IL Bytes | `AE/Commands/InstructionCommands.cs` | 无 | ❌ | |
| Load Dependencies | `AE/Compiler/LoadDependenciesCommands.cs` | RPC `workspace/loadDependencies` | ✅ | 与 4.3 重复计入 |
| Close All Framework Assemblies / Missing Files | `AE/Commands/CloseAll*Command.cs` | File 菜单 | ✅ | 与 4.3 重复计入 |
| Close Old In-Memory Modules | `AE/Commands/CloseOldInMemoryModulesCommand.cs` | 灰显 | ⛔ | 不建模内存模块 |

测试：后端 `WorkspaceEditCreateTests.cs`、`WorkspaceEditOptionsTests.cs`、`Editing/NodeOptionsRoundTripTests.cs`、`Editing/SignatureRoundTripTests.cs`，以及 `WorkspaceManagerTests.cs` 中的方法体、资源、hex、保存用例；前端 `*OptionsDialog.test.tsx` 与 `widgets/*.test.ts(x)` 约 430 条；e2e 覆盖新建类型并保存、IL 与元数据编辑、hex 写入并撤销、模块转换。`MethodBodyEditor` 没有组件测试，退出提示和修改标记粒度没有测试。

### 4.13 调试器

整体完成度约 47%（✅ 30 / 🟡 21 / ❌ 35 / ⛔ 4）。WPF 范围：`Extensions/dnSpy.Debugger/` 全部子项目、`dnSpy/Roslyn/Roslyn.ExpressionCompiler`。

跨平台版只有一个引擎：后端进程内直连 ICorDebug（`CDS/`），只支持 CoreCLR。核心思路是在没有 PDB 的情况下，用反编译语句到 IL 偏移的映射（`BE/StatementIlRanges.cs`）提供断点、单步落点和局部变量名。

| 子模块 | 完成度 | ✅ | 🟡 | ❌ | ⛔ |
|---|---|---|---|---|---|
| 异常设置 | ~85% | 8 | 1 | 1 | 1 |
| 断点 | ~68% | 7 | 9 | 1 | 0 |
| 单步与执行点 | ~60% | 5 | 2 | 3 | 0 |
| 会话控制 | ~46% | 5 | 3 | 6 | 1 |
| 运行时与代码映射 | ~40% | 2 | 0 | 3 | 1 |
| 调试工具窗口 | ~33% | 1 | 4 | 4 | 0 |
| 调试器选项 | ~28% | 2 | 1 | 6 | 1 |
| 变量与表达式求值 | ~4% | 0 | 1 | 11 | 0 |

按计数是 47%，但缺口集中在最常用的变量窗口，实际调试体验比这个数字差。

#### 会话控制

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| Debug Program 对话框（.NET 页） | `DBG/dnSpy.Debugger/Dialogs/DebugProgram/*`、`dnSpy.Debugger.DotNet.CorDebug/Dialogs/DebugProgram/DotNetStartDebuggingOptionsPage.cs` | `DebugProgramDialog.tsx`，RPC `debug/launch` | ✅ | 支持宿主可执行文件；缺 ConnectionTimeout |
| Break at（4 种） | `DotNetCommonStartDebuggingOptionsPage.cs` | `CDS/CorDebugSession.Entry.cs` | ✅ | |
| .NET Framework 启动页 | `DotNetFrameworkStartDebuggingOptionsPage.cs` | 无 | ⛔ | Linux 上没有 .NET Framework |
| Mono / Unity 启动与 connect | `dnSpy.Debugger.DotNet.Mono/Dialogs/DebugProgram/*` | 无 | ❌ | 计划列为后续方向 |
| 启动选项 MRU | `DbgUI/StartDebuggingOptionsMru.cs` | 无 | ❌ | 参数每次重填 |
| Start Without Debugging | `DbgUI/DebugMenuCommands.cs` | 无 | ❌ | |
| Attach to Process | `Dialogs/AttachToProcess/*` | `AttachDialog.tsx`，RPC `debug/listProcesses`、`debug/attach` | 🟡 | 列出所有进程，不按 CLR 过滤；信息列少 |
| Unity 附加 | `dnSpy.Debugger.DotNet.Mono/Dialogs/AttachToProcess/Unity*` | 无 | ❌ | |
| Continue | `DebugMenuCommands.cs` | `continueDebug` | ✅ | |
| Break All | 同上 | `pauseDebug` | ✅ | |
| Stop Debugging | 同上 | `stopDebug` | 🟡 | 附加的进程也会被杀掉（缺陷 #2） |
| Detach All / Terminate All | 同上 | 后端支持 Detach，前端无入口 | ❌ | |
| Restart | 同上 | 停止后重新打开对话框 | 🟡 | 不保留参数 |
| 多进程调试 | 同上 | 只有一个会话 | ❌ | |
| 调试状态提示 | `DbgUI/DebuggerImpl.cs` | 状态栏 | ✅ | |

#### 单步与执行点

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| Step Into / Over / Out | `Steppers/DbgStepperImpl.cs` | `CDS/CorDebugSession.Stepping.cs` | ✅ | 按 3 项统计；在源级顺序点挂临时断点 |
| 跨 await 单步 | `dnSpy.Debugger.DotNet/Steppers` | 语句级断点 | 🟡 | continuation 不做判定，分支或异常路径上可能多停一次 |
| Show Next Statement | `DbgUI/DocumentViewerCommands.cs` | `revealStoppedLocation` | ✅ | 快捷键未绑定 |
| Set Next Statement | 同上 | 隐藏；后端没有 SetIP | ❌ | |
| Run to Cursor | `ToolWindows/CallStack/CallStackOperations.cs` | 无 | ❌ | |
| Unwind To This Frame | `ToolWindows/CallStack/Commands.cs` | 无 | ❌ | |
| 当前语句与调用栈帧高亮 | `CallStack/TextEditor/ActiveStatementService.cs` | `DocumentView.tsx` | 🟡 | 不区分当前语句与其他帧；总切到 C# 视图 |
| 停在工作区外的模块时自动加载 | `dnSpy.Debugger.DotNet/Modules/DbgLoadModuleReferenceHandlerImpl.cs` | `openDebugModule` | ✅ | |

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
| 条件 | `Breakpoints/Code/CondChecker/DbgCodeBreakpointConditionChecker.cs` | `BreakpointSettingsDialog.tsx`、`CDS/BreakpointExpression.cs` | 🟡 | 自研子集：没有成员访问与调用 |
| 命中计数 | `CondChecker/DbgCodeBreakpointHitCountChecker.cs` | `CDS/BreakpointBreakDecision.cs` | ✅ | |
| 筛选器 | `CondChecker/DbgCodeBreakpointFilterChecker.cs` | `CDS/CorDebugSession.BreakpointChecks.cs` | ✅ | |
| 跟踪点消息 | `CondChecker/TracepointMessageParser.cs` | `CDS/TracepointMessage.cs` | 🟡 | `{表达式}` 同样是子集 |
| 标签 | 设置对话框 | 设置对话框 | ✅ | |
| Enable / Disable / Delete All | `DebugMenuCommands.cs` | `MenuBar.tsx` | ✅ | |
| Breakpoints 窗口 | `ToolWindows/CodeBreakpoints/*` | `BreakpointsPane` | 🟡 | 无多列、搜索、双击跳转、右键菜单 |
| 导入 / 导出 | `Breakpoints/Code/BreakpointsSerializer.cs` | 面板按钮 | 🟡 | JSON 格式，与 WPF 的 XML 不互通 |
| 持久化 | 同上 | `dnspy.breakpoints.v1` | ✅ | |
| 模块断点 | `Breakpoints/Modules/*` | 占位面板 | ❌ | |

另新增：Breakpoints 面板可按名称输入函数断点。

#### 异常设置

后端读取与 WPF 相同的 `DotNet.ex.xml`，客户端只持久化与默认值的差异，开会话时重放给引擎。`docs/linux-release-1.0.md` 中「不含异常断点」的说法已经过时。

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| 异常列表 | `ToolWindows/Exceptions/*`、`Exceptions/DefaultExceptionDefinitionsProvider.cs` | `ExceptionSettingsPane.tsx`，RPC `exceptions/get`；`CDS/ExceptionSettingsService.cs` | ✅ | 工具栏代替右键菜单 |
| 勾选「抛出时中断」与批量开关 | 同上 | RPC `exceptions/apply` | ✅ | |
| 添加 / 删除异常 | 同上 | `addExceptionDefinition` 等 | ✅ | |
| 条件（模块名） | `Exceptions/ExceptionConditionsChecker.cs` | 条件对话框 | ✅ | |
| 搜索、类别筛选、只显示已启用 | `ToolWindows/Exceptions` | 有 | ✅ | |
| 恢复默认 | 同上 | RPC `exceptions/reset` | ✅ | |
| 设置持久化 | `Exceptions/ExceptionListSettings.cs` | `dnspy.exceptions.v1` | ✅ | |
| 首次机会 / 未处理异常中断 | CorDebug 异常回调 | `CDS/CorDebugSession.Exceptions.cs` | ✅ | |
| MDA 类别 | `DotNet.ex.xml` | 列出但不会触发 | ⛔ | MDA 只存在于 .NET Framework |
| 异常中断后的提示 | `DbgUI/DebuggerImpl.cs` | Output 与状态栏 | 🟡 | 未处理异常没有对话框；读不到 Message；没有 `$exception` |
| 右键 Break When Exception Thrown | `dnSpy.Debugger.DotNet/Exceptions/BreakWhenThrownExceptionCommand.cs` | 隐藏 | ❌ | |

#### 调试工具窗口

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| Call Stack | `ToolWindows/CallStack/*` | `DebugToolWindows.tsx` 的 `CallStackPane` | 🟡 | 只解析前 24 帧的名称；无 Copy、显示选项 |
| Threads | `ToolWindows/Threads/*` | `ThreadsPane` | 🟡 | 只显示编号；无冻结/解冻、重命名 |
| Modules | `ToolWindows/Modules/*` | `ModulesPane` | 🟡 | 只有名称、路径；无 Go to Module、从内存打开 |
| Processes | `ToolWindows/Processes/*` | 占位面板 | ❌ | |
| Memory 1–4 | `ToolWindows/Memory/*` | 占位面板 | ❌ | |
| Disassembly | `Disassembly/*` | 占位面板 | ❌ | 与 4.8 重复计入 |
| Output：程序 stdout/stderr | `ToolWindows/Logger/OutputLogger.cs` | `output` 事件 | ✅ | 附加的进程不能重定向 |
| Output：Debugger.Log | 同上 | 后端没有 LogMessage 分支 | ❌ | |
| Output：模块、线程、进程消息与过滤开关 | `ToolWindows/Logger/Commands.cs` | 只有退出码与异常 | 🟡 | |

#### 变量与表达式求值

后端的 `evaluate` 直接返回 `MethodNotFound`，能力声明 `supportsEvaluate=false`。Locals 只能读基元、字符串和数组，对象显示为 `{object}` 且不能展开（`CDS/ManagedValueFormatter.cs`）。

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| Locals | `ToolWindows/Locals/*` | `LocalsPane` | 🟡 | 变量名来自反编译器，无需 PDB；对象不能展开 |
| Autos | `ToolWindows/Autos/*` | 占位面板 | ❌ | |
| Watch 1–4 | `ToolWindows/Watch/*` | 一个禁用输入的 `WatchPane` | ❌ | |
| Static Fields | `ToolWindows/StaticFields/*` | 占位面板 | ❌ | |
| 表达式求值（C#/VB） | `dnSpy/Roslyn/Roslyn.ExpressionCompiler`、`Evaluation/*` | 无 | ❌ | 断点条件用的是自研子集 |
| 编辑变量值 | Locals 的 EditValue | 无 | ❌ | |
| 属性求值、ToString、函数调用 | `dnSpy.Debugger.DotNet.CorDebug/Impl/Evaluation` | 无 | ❌ | |
| DebuggerDisplay / DebuggerTypeProxy | `dnSpy.Debugger.DotNet/Evaluation/Engine/*` | 无 | ❌ | |
| Raw / Results / Dynamic View | `dnSpy/Roslyn/dnSpy.Roslyn/Debugger/ValueNodes/*` | 无 | ❌ | |
| 十六进制显示 | 各窗口命令 | 无 | ❌ | |
| Make Object ID | `Evaluation/DbgObjectIdServiceImpl.cs` | 无 | ❌ | |
| 显示返回值 | ShowReturnValues 设置 | 无 | ❌ | |

#### 调试器选项

`options-pages.ts` 一对一还原了 WPF `Settings/DebuggerAppSettingsPage.cs` 的全部分组，但只有「启动时显示 Locals」被读取，其余设置不传给后端。

| 功能点 | 状态 | 备注 |
|---|---|---|
| 选项页界面与持久化 | ✅ | |
| 启动调试时显示 Locals | ✅ | |
| 抑制 JIT 优化 | ❌ | 后端未调用 `SetJITCompilerFlags` |
| Just My Code 与步进过滤 | ❌ | `stepper.SetJMC(false)` 写死 |
| 忽略 Debugger.Break() | ❌ | |
| 忽略未处理异常 | ❌ | |
| 变量窗口显示选项 | ❌ | |
| 焦点相关选项 | ❌ | |
| 重定向 GUI 程序的控制台输出 | 🟡 | 总是重定向，不读选项 |
| 启用 MDA | ⛔ | 只存在于 .NET Framework |

#### 运行时、平台与代码映射

| 功能点 | WPF 来源 | 跨平台实现 | 状态 | 备注 |
|---|---|---|---|---|
| Windows 反反调试（IsDebuggerPresent 等） | `DBG/dnSpy.Debugger/AntiAntiDebug/*` | 选项在，无实现 | ⛔ | Windows API，计划明确不支持 |
| 阻止托管代码检测调试器 | `dnSpy.Debugger.DotNet.CorDebug/AntiAntiDebug/ManagedDebuggerHook.cs` | 选项在，无实现 | ❌ | 在 Linux CoreCLR 上同样有意义 |
| 从内存打开模块 | `Code/GoToInMemoryModuleStatement.cs` | 只按磁盘路径 | ❌ | |
| 动态模块与 Reload All Method Bodies | `dnSpy.Debugger.DotNet/Metadata/Commands.cs` | 无 | ❌ | |
| 反编译源码上的断点、单步、定位 | `dnSpy.Debugger.DotNet/Code/DbgMethodDebugInfoProvider.cs` | `BE/StatementIlRanges.cs`、`IDebugSymbolResolver` | ✅ | 只有 C# |
| 无 PDB 时变量名取自反编译器 | `Evaluation/DbgLocalsValueNodeProviderImpl.cs` | `GetVariableNamesAsync` | ✅ | |

Linux 新增（不计入）：以 root 身份重启（pkexec）、随包提供 `libdbgshim.so` 并在缺失时按能力降级、按名称的函数断点。附加失败时没有 ptrace 权限诊断，只返回 HRESULT。

测试：后端 `DebugSessionManagerTests.cs`（启动、Break kind、附加与分离、单步、异常中断）、`BreakpointExpressionTests.cs`、`BreakpointBreakDecisionTests.cs`、`TracepointMessageTests.cs`、`ExceptionSettingsTests.cs`；前端 `DebugProgramDialog.test.tsx`、`ExceptionSettingsPane.test.tsx`、`BreakpointsPane.test.tsx`；e2e 覆盖断点、单步、帧切换、Locals、异常中断、断点持久化。Pause、附加对话框、断点设置对话框、Modules/Threads 面板没有测试。

### 4.14 C# 交互窗口（Scripting）

完成度约 44%（✅ 6 / 🟡 10 / ❌ 9 / ⛔ 2）。WPF 范围：`Extensions/dnSpy.Scripting.Roslyn/`、`WPF/Scripting/`。跨平台实现：`FE/components/CSharpInteractive.tsx`、`BE/Scripting/CSharpScriptService.cs`，RPC `script/evaluate`、`script/reset`、`script/classify`。

脚本在后端 Host 进程内执行；计划文档 §3.2 写的是「独立子进程隔离执行环境」，与实现不符。

| 功能点 | WPF 来源 | 状态 | 备注 |
|---|---|---|---|
| 打开窗口（Ctrl+Alt+N） | `CSharp/CSharpToolWindowContent.cs` | ✅ | |
| 持久会话，变量跨提交保留 | `Common/ScriptControlVM.cs` | ✅ | |
| 返回值、诊断、异常格式化 | 同上 | ✅ | |
| 横幅与提示语 | `CSharp/CSharpControlVM.cs` | ✅ | |
| `#help` | `Common/HelpCommand.cs` | ✅ | |
| 清屏 | `Common/ClearCommand.cs` | 🟡 | 没有 Ctrl+L 和右键菜单 |
| 重置 | `Common/ResetCommand.cs` | 🟡 | 见缺陷 #8 |
| `#r` / `#load` 与搜索路径 | `ScriptControlVM.cs` | 🟡 | 相对路径只在后端安装目录解析 |
| 预置引用与 `.rsp` | `CSharpInteractive.rsp` | 🟡 | 写死 9 个 using，用户不能配置 |
| 提交键（按完整性提交） | `WPF/Text/Editor/ReplEditor.cs` | 🟡 | Enter 无条件提交 |
| 历史 | `Text/Editor/ReplCommandInfoProvider.cs` | 🟡 | 只有 Alt+↑/↓，没有前缀匹配 |
| Escape 清空输入、Ctrl+A 两段选择 | `ReplCommandTargetFilter.cs` | ❌ | |
| 输入代码语义着色 | `ScriptControlVM.cs` | ✅ | `script/classify` 按会话的下一次提交编译输入，用 `RoslynClassifier` 的映射给出 dnSpy 主题色，未绑定的名字为红色；回显保留输入时的颜色（见 4.15） |
| Print / PrintLine / PrintError | `dnSpy.Contracts.DnSpy/Scripting/Roslyn/IScriptGlobals.cs` | 🟡 | 每次 Print 单独成行；缺部分重载 |
| 彩色输出 API | `Common/ScriptGlobals.cs`、`CachedWriter.cs` | ❌ | |
| 输出实时出现 | 同上 | 🟡 | 整次提交结束后一次返回 |
| PrintOptions | `Common/PrintOptionsImpl.cs` | ❌ | |
| `Resolve<T>` 访问 dnSpy 服务 | `WPF/Scripting/ServiceLocator.cs` | ❌ | 脚本读不到已打开的程序集 |
| 消息框与输入框 | `ScriptGlobals.cs` | ❌ | |
| UI 线程（UIDispatcher、`UI(...)`） | 同上 | ⛔ | WPF Dispatcher 专属 |
| 生命周期与协作取消（Token、Break） | 同上 | ❌ | |
| 复制、Copy Code、剪切、粘贴 | `Common/Commands.cs` | 🟡 | 没有 Copy Code 和右键菜单 |
| 保存文本 / 保存代码 | `Commands/RoslynReplIds.cs` | ❌ | |
| 自动换行开关 | `Common/ReplSettings.cs` | ❌ | 写死为开 |
| 显示行号开关 | `Common/Commands.cs` | ❌ | 写死为关 |
| REPL 选项页 | `WPF/Text/Repl/*AppSettingsPage.cs` | 🟡 | 不生效 |
| VB Interactive | `VisualBasic/*` | ⛔ | WPF 自己在 csproj 中排除了 VB 文件 |

测试：后端 `CSharpScriptServiceTests.cs` 16 条（含 5 条着色）；前端 `app-store.test.ts` 中约 13 条；e2e 2 个场景（提交与会话、语义着色）。

### 4.15 Roslyn 语言服务

完成度约 69%（✅ 3 / 🟡 5 / ❌ 0）。WPF 范围：`dnSpy/Roslyn/dnSpy.Roslyn*`。2026-10-16 按实现与测试复核；此前标的 95% 是一份没有接通的骨架（后端 `JsonRpcServer` 没有分发 `languageService/*`，签名帮助直接返回 null，前端 provider 挂在所有 csharp 模型上），已整体重写。

WPF 里这些能力分属两个宿主：C# Interactive 只用 `RoslynClassifier` 给输入做语义着色（`ScriptControlVM.OnCommandUpdatedAsync`，REPL 缓冲区不在 Roslyn Workspace 里，所以没有补全、悬停、签名帮助、智能缩进）；补全、Quick Info、签名帮助、智能缩进、结构导航、编译诊断只服务于「Edit Method / Class (C#)」编辑器。跨平台版按同样的划分移植：

- **C# Interactive 的语义着色**已接到界面上：`script/classify` 把输入当作会话的下一次提交编译（引用、导入、前面提交声明的变量都在），用 WPF 同一套映射给出 dnSpy 主题色；绑定不上的名字按 WPF 的默认色画成红色；提交后的回显保留输入时的颜色（WPF 的 REPL 缓冲区也保留）。
- **代码编辑器的其余能力**做到「后端服务 + 可复用的前端绑定」为止：`languageService/*` 每个文档一个 AdhocWorkspace（对应 `RoslynLanguageCompiler` 每次编辑会话一个 workspace），前端 `attachRoslynDocument(monaco, editor, { references, options })` 把一个 Monaco 编辑器接成 Roslyn 文档。它们的宿主 Edit Method (C#) 编辑器属于 4.12 的 Compiler 子模块，目前未移植，所以这些能力还没有界面入口。provider 只回答绑定过的模型，反编译文档和 C# Interactive 从不向后端发请求。

实现文件：

- 后端：`BE/LanguageService/RoslynClassifier.cs`（`RoslynClassifier` 的移植）、`RoslynTextParts.cs`（`TextTagsHelper`、符号显示部件着色、`GlyphHelper` 的图标名）、`RoslynLanguageService.cs`（文档、补全、Quick Info、诊断、缩进、结构导航）、`SignatureHelpProvider.cs`、`LanguageServiceHost.cs`（MEF 宿主、引用程序集与 XML 文档）、`DocumentationText.cs`；`BE/Scripting/CSharpScriptService.cs` 的 `ClassifyAsync`
- RPC：`script/classify`；`languageService/open`、`update`、`close`、`classify`、`completion`、`completionDescription`、`quickInfo`、`signatureHelp`、`diagnostics`、`indentation`、`selectionRanges`
- 前端：`FE/roslyn-classification.ts`（分类结果画成 `tc-*` 内联装饰，供 REPL 与代码编辑器共用）、`FE/roslyn-language-service.ts`（各 provider 与 `attachRoslynDocument`，连同它要的 Monaco contrib：`FE/roslyn-editor-contribs.ts`；`FE/monaco.ts` 仍只导入 `editor.api`，之前那版改成整包导入后代码视图的右键光标定位回归了，已改回）、`FE/components/CSharpInteractive.tsx`、`FE/components/ColoredText.tsx` 的 `ClassifiedText`；`FE/styles.css` 里只在代码中出现的颜色（注释、字符串、局部变量、参数加粗、预处理、XML 文档注释等，取自 dark/light.dntheme）

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

完成度 0%（❌ 12）。WPF 范围：`dnSpy/dnSpy.Console/Program.cs`。

`dnSpy.CrossPlatform.slnx` 里没有 CLI 项目；`dnSpy.Backend.Host` 只接受内部用的 `--nonce`、`--parent-pid`，只能以 stdio JSON-RPC 方式运行。后端也没有导出项目的能力，所以 GUI 的「Export to Project」同样缺失。WPF 的以下功能全部没有对应：

- 批量导出为项目（`-o`）、递归与通配符（`-r`）、生成 .sln（`--sln-name`、`--no-sln`）；
- 项目格式（`--sdk-project`、`--vs`、`--project-guid`）、语言选择（`-l`）、反编译器选项透传；
- 资源开关（`--no-resources`、`--no-resx`、`--no-baml`）、程序集解析（`--asm-path`、`--no-stdlib` 等）；
- 单个类型或成员输出到 stdout（`-t`、`--md`）、彩色输出、`--spaces`、`--threads`、用法帮助。

后端引用的 `ICSharpCode.Decompiler 11.1` 自带 `WholeProjectDecompiler`，可以作为 CLI 与 GUI 导出项目的共同实现基础。GUI 启动参数的情况见 4.1。

### 4.18 其他杂项

不计完成度（✅ 3 / 🟡 3 / ❌ 1 / ⛔ 7）。

| 项目 | WPF 来源 | 状态 | 备注 |
|---|---|---|---|
| 本地化资源（15 种语言） | `WPF/Properties/*.resx` 等 | 🟡 | 只有 2 种 |
| 许可证与鸣谢 | `WPF/LicenseInfo/*` | 🟡 | 安装包里齐全；应用内看不到 |
| 图标库 `dnSpy.Images` | `dnSpy/dnSpy.Images/` | 🟡 | 树、分析器、搜索结果、类型选择器的行已用原图（转成 SVG、按主题换色）；菜单、工具栏仍是 lucide-react |
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
2. 停止调试时区分启动的进程与附加的进程，后者走 Detach，并在菜单里加 Detach All（缺陷 #2）。
3. ~~关闭窗口前，有未保存修改时弹出「保存 / 放弃 / 取消」对话框~~ 已完成（2026-10-14）。
4. 修 PE-only/ELF 文件的 hex 读取（缺陷 #6）。Raw Save Resource（缺陷 #5）已修。
5. IL 编辑器默认重算 MaxStack（缺陷 #4）。

**P1：让已有界面生效**（UI 已经做好，只差接线）

1. 给 `DecompileRequest` 加反编译设置 DTO，接通 C#/VB、IL、BAML 选项页与 DecompileFullType；随后接文本编辑器、Hex、调试器等页面，并把 `UseMemoryMappedIO` 落到后端读文件的方式上。主题、字体、RestoreTabs、背景图片、Output 窗口这几页已于 2026-10-14 接通。
2. Monaco 改为完整导入（或按需导入 contrib），补一条查找功能的 e2e 防回归。
3. 调试器选项传给后端：JIT 优化抑制、Just My Code、忽略 Debugger.Break、忽略未处理异常。
4. ~~绑定菜单上已标出的快捷键，修正 Go to Token 的键位与 Shift+Alt+Enter 冲突~~ 已完成（2026-10-14）。
5. ~~记忆窗口位置和尺寸；接受裸文件路径参数并加单实例锁~~ 已完成（2026-10-14；单实例默认关闭，与 WPF 的 `AllowMoreThanOneInstance` 默认值一致）。
6. ~~CI 增加前端 vitest 单测~~ 已完成（2026-10-14）。

**P2：补齐核心能力**

1. IL 输出改用 `ReflectionDisassembler` 并生成 span 与语句表，一次解决 IL 视图的跳转、断点、书签持久化。
2. 方法体编辑器支持局部变量与异常处理器，以及指令插入、移动和操作数选择器。
3. 调试器的表达式求值与 func-eval、对象字段展开（Watch、Autos、DebuggerDisplay、完整断点条件都依赖它）。
4. Roslyn 源码编辑（Edit Method / Class (C#)），连带 ModuleImporter 与 Merge with Assembly。
5. 元数据表子树与表格视图；Hex 视图的光标、选区与直接改写。
6. Export to Project 与 CLI（共用 `WholeProjectDecompiler`）。
7. 保存选项：保留 RID/堆、写 PDB、混合模式模块。

**P3：扩展范围**

字符串引用窗口；程序集与模块属性对话框；资源新建与元素编辑；Memory、Disassembly、Processes 等调试窗口；Set Next Statement 与 Run to Cursor；Mono/Unity 调试；脚本 `Resolve<T>` API；扩展系统；更多界面语言；更新检查。

## 6. 测试基线

2026-10-16 分析器补齐后在本机重新跑过（后端与前端都是真实构建）：

| 套件 | 结果 |
|---|---|
| 后端 `dotnet test` | 406 通过（字符串引用与 Roslyn 复核后为 403，应用壳复核时为 359） |
| 前端 `pnpm typecheck` | 0 错误 |
| 前端 vitest | 1103 通过（字符串引用与 Roslyn 复核后为 1095，应用壳复核后为 1041） |
| e2e（Playwright Electron） | 92 通过、3 跳过、0 失败 |

复核前 HEAD 后端和前端都构建不过（见 4.11），所以那之前记的数字都来自更早的构建。改 `Protocol.cs` 后 e2e 里钉死的元数据标记变为 `RpcException @02000079`、`get_Code @0600095C`；整包导入 Monaco 带来的右键光标定位回归（「keeps the caret on what it was right-clicked on」）随 `monaco.ts` 改回 `editor.api` 消失。这一轮新增的用例见 4.10、4.11、4.14、4.15 各节末尾；分析器这次改 `Protocol.cs`（两个请求加语言参数、`TextColors.ILModule`）没有挪动这两个标记。

应用壳复核（2026-10-14）时前端新增的用例：窗口状态（`window-state.test.ts`）、窗口标题（`app-info.test.ts`）、命令行选项解析（`command-line-options.test.ts`）、缩放档位（`zoom.test.ts`）、背景图片的尺寸与位置（`background-image.test.ts`）、消息框的「不再提示」（`message-box.test.ts`）、工具窗口菜单（`ToolWindowTabContextMenu.test.tsx`）、输出窗口的命令栏（`ToolWindows.test.tsx`）、关于对话框与它引用的两份文本是否与出处一致（`AboutDialog.test.tsx`、`about-resources.test.ts`）。CI 现在会跑前端单测（`.github/workflows/cross-platform.yml` 的 Test frontend 步骤）。

此前记录的「后端 336 通过」之后的一次「346 通过」是 `--no-build` 跑在旧 DLL 上得到的；真实构建下当时有 22 条失败，已逐条按 WPF 行为修正（1 处后端缺陷、21 条过期断言），见 `docs/assembly-tree-frontend-integration.md`。

覆盖较好的部分：元数据编辑对话框、签名与自定义特性编解码、搜索、分析器、程序集树（键盘、图标、最近文件、命令行、Reload、移除与撤销）、断点判定与跟踪点、异常设置、书签。

明显的测试盲区：反解码器选项是否生效（消费方在后端，尚无 DTO）、Monaco 编辑器功能（查找、悬停、折叠）、PE-only/ELF 的 hex 读取、`JsonRpcServer` 的握手与分帧、方法体编辑器组件、调试器的 Pause、附加对话框和 Modules/Threads 面板。应用壳这一批新功能里，`.dntheme` 加载、界面语言、图标的其余部分都还没有测试；窗口状态与关闭询问有单测，但没有 e2e。

## 7. 与现有文档的出入

| 文档 | 说法 | 实际情况 |
|---|---|---|
| `docs/linux-release-1.0.md` | 调试「不含异常断点与表达式求值」 | 异常设置已实现（4.13）；表达式求值确实没有 |
| `docs/linux-release-1.0.md` | 稳定版功能包含「ECMA-335 Metadata Tables」 | 只有 Module Information 中的各表行数，没有元数据表视图（4.8） |
| `docs/linux-release-1.0.md` | 验证结果：.NET 13/13、Vitest 2/2、Electron 7/7 | 当前为 406 / 1103 / 92（见第 6 节） |
| `docs/linux-release-1.0.md` | 能力包含「嵌入资源替换」「结构化 IL 方法体编辑」 | 属实，但方法体编辑不能编辑局部变量和异常处理器（4.12） |
| `docs/linux-support-plan.md` §3.2 | C#/VB 交互窗口在「独立子进程隔离执行环境」中运行 | 脚本在后端 Host 进程内执行，没有 VB（4.14） |
| `docs/linux-support-plan.md` §14 | 验收条件包含「恢复窗口尺寸」「查看监视表达式」 | 窗口尺寸与位置自 2026-10-14 起会恢复（4.1）；监视表达式仍未实现 |
| `docs/linux-support-plan.md` §8.2 | DTO 由 schema 生成 C# 与 TypeScript，CI 检查漂移 | 两边手写，没有生成与漂移检查（4.2） |
| `CrossPlatform/ASSEMBLY_EXPLORER_CHANGES.md` | PE 与 Type References 节点为「占位实现」 | 两者均已完整实现（4.3） |
