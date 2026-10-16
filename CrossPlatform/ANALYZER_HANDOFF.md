# 分析器与搜索窗口对齐 WPF —— 交接文档

基于提交 `d20f91c17 fix: 调整搜索等功能`（2026-10-12）。其后又做了三件事（改动尚未提交）：代码编辑器在引用上的右键命令、三处菜单的「添加类跟踪点」，以及**按 WPF `dnSpy/dnSpy/Search` 重写的搜索窗口**（见第八节）。新会话接着做需要知道的全部内容都在这里。

## 一、现状

右键「分析」的行为已经和 WPF 一致：每分析一个成员，就在分析器末尾追加**一行**；同一成员再分析一次，会回到已有的那一行。

- 展开成员行，看到的是 WPF `CanShow` 规则下它有的搜索类别；属性和事件下面还有 get/set、add/remove/raise 访问器行。
- 展开类别才开始搜索，**结果边搜边出**（约每 100ms 一批），搜出来的每个结果都可以再展开、再分析。
- 搜索类别已全部移植：使用、被使用（含虚方法版）、重写、重写于、实现于、读取于、赋值于、被触发于、被应用于、实例化于、被公开于、子类型、扩展方法。
- 可见性范围规则、友元程序集（含 `IgnoresAccessChecksTo`）、lambda/迭代器回溯到所在方法、特性命名参数写入，也都已移植。
- 右键菜单五组齐全：跳转、复制、**调试（添加类断点 / 添加方法断点）**、分析/MSDN/移除、选项（显示标记、**语法高亮**、单击展开）。
- **搜索窗口**已按 WPF 重写：边输入边搜（停顿 500ms）、「搜索」类型框（24 项）、位置框（4 项）、选项展开区（6 个复选框）、Ctrl+字母快捷键、按名称排序、结果语法高亮、边搜边出、一万条上限（红框 + 提示）、右键菜单五组齐全（含选项组）。详见第八节。
- **添加类跟踪点**在程序集树、代码编辑器、分析器、搜索窗口的菜单里都有：先弹断点设置对话框，确定后给类型的每个方法加跟踪点。
- 分析器树**按视口窗口化渲染**，两万行也只画可见的几十行。
- 分析器与程序集树的行文本都有**语法高亮**（WPF 的 dark/light 主题配色；高对比度主题不着色），各自有开关。
- **用户明确决定不做**：COM/NoPIA 类型等价（TIAHelper）和 COM vtable 槽匹配（ComUtils）。

测试基线（2026-10-12），全绿：

| 套件 | 结果 |
|---|---|
| 后端 | 336 |
| 前端单测 | 893 |
| e2e | 82 通过、3 跳过 |

## 二、架构速览

### 后端：`backend/dnSpy.Backend.Core/Analyzer/`

| 文件 | 作用 |
|---|---|
| `WorkspaceManager.Analyzer.cs` | `WorkspaceManager` / `Workspace` 的 partial 另一半。包括：RPC 入口 `AnalyzeNodesAsync` / `AnalyzeChildrenAsync`（带 `progress` 回调的重载）；分片执行循环与进度批次；`analyzerEpoch` 校验；把命中结果转成 DTO；跨程序集解析器 `AnalyzerHost`（查找过程加锁）。节奏参数是 `WorkspaceManager` 的 init 属性：`AnalyzerSliceBudget`（40ms）、`AnalyzerProgressInterval`（100ms）、`AnalyzerParallelism`（1）。 |
| `AnalyzerModel.cs` | `IAnalyzerHost`、`AnalyzerSourceRef`、`AnalyzerHit` |
| `AnalyzerSearch.cs` | 搜索基类（`Prepare` / `BeginUnit` / `Collect` / `Accept` / `Finish`）、`ScopedSearch`、分片运行器 `AnalyzerSearchRun` |
| `AnalyzerEntityChildren.cs` | 每种成员有哪些子行（`CanShow`）、搜索工厂 `CreateSearch`、类别英文标题 |
| `ScopedWhereUsedAnalyzer.cs` | 可见性 → 扫描范围 |
| `Searches/*.cs` | 各搜索类，按成员种类分为五个文件，类名沿用 WPF。注意 WPF 的命名是反的：`*OverriddenSearch` 的标题是「重写」，`*OverridesSearch` 才是「重写于」。 |
| `TypesHierarchyHelpers.cs`、`GenericArgumentResolver.cs`、`CustomAttributesUtils.cs`、`AnalyzerHelpers.cs`、`AnalyzerExtensions.cs` | 从 `dnSpy.Contracts.Logic` 和 `dnSpy.Analyzer` 移植过来，所有 Resolve 都改走 host |
| `AnalyzerLabelFormatter.cs` | 行文本，按颜色分段写进 `TextPartsBuilder` |

语法高亮相关（`backend/dnSpy.Backend.Core/`）：

| 文件 | 作用 |
|---|---|
| `TextParts.cs` | `TextPartsBuilder`（相邻同色合并）和 `MetadataTextColors`（WPF `MetadataTextColorProvider` 的移植） |
| `CSharpTypeName.cs` | 原有的字符串接口不变，新增 `Write(...)` / `WriteParameterList(...)` 分段输出；字符串版本也走同一条路径 |
| `WorkspaceManager.TextParts.cs` | 程序集树行的 `LabelParts` / `ReturnTypeParts`；`TypeColor` 只在已加载的模块里找类型定义，**从不为着色去加载程序集** |

### 搜索的五个阶段（重要约定）

- `Collect(type, unit)`：只读模型、只经 host 解析，**不得修改搜索自身的状态**（为多线程预留）。
- `Accept(hit)`：按类型顺序逐条调用，负责去重。`BodySearch` / `AttributeAppliedToSearch` 按 `MethodDef` 去重，`TypeUsedBySearch` 过滤自身成员并按成员去重。
- `Finish(hits)`：**只能追加**，不能删除或重排——已发出去的批次收不回来。
- 结果上限：`AnalyzerSearchRun.Count` 封顶在 `MaxResults`，`Finish` 追加超出时只标记 `Truncated`。

### 协议（追加在 `Protocol.cs` 末尾）

- RPC：`analyze/nodes`（批量；不可分析或已失效的节点返回 `null`）和 `analyze/children`。
  - 不带 `Search` 时，返回成员自己的子行；带 `Search` 时，执行这个搜索。
  - `IsSetter` 由 set 访问器行带下去。
  - 带 `ProgressToken` 时，搜索途中发 `analyze/progress` 通知（`ProgressToken`、`Start`、`Children`）；响应只含未发过的行，`Start` 是它们在全部结果里的起始位置。下一片会等通知写完再跑，所以批次一定先于响应。
- 结果行带 `Source`，即 WPF 的 SourceRef，包括方法节点、IL 偏移，以及 `Targets`。`Targets` 的编码方式与 `TextSpanDto` 相同：开着的模块用 nodeId，引用模块用文件路径 + token。
- `AnalyzerNodeDto.LabelParts`、`TreeNodeDto.LabelParts` / `ReturnTypeParts`：`TextPartDto(Text, Color)`，颜色名见 `TextColors`（WPF `BoxedTextColor` 的驼峰名）。搜索行和文件夹行不带。

### Electron

- `main/backend-client.ts`：`invoke` 的 `signal?: AbortSignal`，abort 时向后端发送 `system/cancel`（单测：`backend-client.test.ts`）。
- `main/index.ts`：
  - `analyze:nodes` / `analyze:children` / `analyze:cancel`，`analyze:children` 超时 600 秒。
  - `analyzerRequests` 以 `${sender.id}:${requestKey}` 为键，记录 AbortController、发送方 WebContents 和 requestKey；这个键同时作为 `progressToken` 发给后端，`analyze/progress` 据此转发为渲染进程的 `analyze:progress`。
- `preload`：新增 `onAnalyzeProgress`。

### 前端：`frontend/src/renderer/src/`

| 文件 | 作用 |
|---|---|
| `analyzer-model.ts` | 纯函数：行文本与分段（`composeAnalyzerParts`、`tokenParts`）、排序（OrdinalIgnoreCase；根行不排序）、平铺（搜索中的行也排序，「搜索中…」排在最后）、复制格式、`findReferenceCaret` |
| `analyzer-store.ts` | 独立的 zustand store。`loading` 状态也带 `keys`；`receiveProgress` 按 `start` 去重追加；收起未完成的搜索会丢掉已收到的部分结果。模块加载时订阅 `useAppStore` 和 `onAnalyzeProgress`。 |
| `components/AnalyzerPane.tsx` | 窗口化渲染（`visibleLineRange`，行高 22px，上下各多画 20 行）；焦点通过 `pendingFocusRef` 在布局效果里落地，视口外的行会先滚过去 |
| `components/AnalyzerContextMenu.tsx` | 表驱动的右键菜单，分组按 WPF 的 `GROUP_CTX_ANALYZER_*` |
| `components/SearchContextMenu.tsx`、`components/ToolWindows.tsx` | 搜索窗口的右键菜单（`GROUP_CTX_SEARCH_*`）和列表（listbox，键盘操作，Ctrl+Shift+R） |
| `components/ColoredText.tsx` | 分段文本渲染为 `tc-<color>` span；配色在 `styles.css` 的 `--tc-*` 变量 |
| `components/app-options.ts` | `analyzer: { showToken, syntaxHighlight, singleClickExpandsChildren }`；程序集树用已有的 `assemblyExplorer.syntaxHighlight` |
| `App.tsx` | `openAnalysis`；`analyzerCommands`（含类/方法断点）；`searchCommands`；`readNodes` |
| `app-store.ts` | 新增 `addMethodBreakpoints(targets)`：节点（方法直接加，属性/事件加其访问器）或已写成断点名的字符串；**只加不删**（与 WPF 一致）。程序集树、代码编辑器、分析器、搜索窗口四处的「添加方法断点」都走它 |

## 三、必须知道的坑

1. **Contracts 程序集是 e2e 夹具，token 被钉死。**
   - 新增的 record 只能追加在 `Protocol.cs` 末尾。
   - 改 `RpcException` 之前的 record 也会挪动方法 token。搜索协议重写（`SearchRequest` 13 个参数、`SearchResultDto` 10 个）后，`get_Code` 从 `@0600089A` 变成了 **`@060008B6`**，`RpcException` 仍是 `@02000073`。e2e 里除了 `@060008B6`，「Go to Token」那条还填了 `0x060008B6`，两种写法都要改。
   - 算新 token：在 `/tmp` 建一个引用 `dnlib 4.5.0` 的控制台项目（`<NuGetAudit>false</NuGetAudit>`，离线可还原），`ModuleDefMD.Load` 后 `Find(...).FindMethod(...).MDToken`。
2. **dnlib 的 `Resolve*()` 跨不了程序集。** 分析器代码里一律用 `IAnalyzerHost.ResolveTypeDef/MethodDef/FieldDef`；着色用 `Workspace.TypeColor`（不加载）。
3. **dnlib 对象只能在 workspace gate 内访问。**
   - 搜索按约 40ms 一片执行，每片单独 `RunAsync`，片与片之间放开 gate；进度通知在 gate 外写。
   - 每片开始时都校验 `analyzerEpoch`。不能用 `stateId` 判断，因为 Undo 会把 `stateId` 设回旧值。
4. **并行扫描默认关闭。** `AnalyzerParallelism > 1` 时一片内按批 `Parallel.For` 调 `Collect`，结果与单线程逐条一致（有测试）。实测 25 个框架程序集：16 线程只把纯扫描型搜索从约 2.0s 降到 1.8s，两万行的搜索没有变快（dnlib 线程安全模式按元数据表加锁），同时并发的反编译慢了一倍、树请求等待变长，所以默认 1。
5. **「搜索中…」那一行排在结果最后，窗口化后通常不在 DOM 里。** e2e 或驱动脚本判断搜索是否还在跑，要看搜索行展开按钮上的 `.spin`，不要数 `.analyzer-searching`。
6. **`addDocumentTab` 每次都会重新反编译。** `DocumentView` 在 `document.loading` 时把 `editorReady` 置回 false；`caretReveal` 每个 token 在每个视图里只执行一次。
7. **分析器的行也用 `.tree-row` 类。** e2e 里请限定作用域：`getByRole('tree', { name: 'Analyzer' })`（中文界面是 `'分析器'`），或 `{ name: 'Assembly Explorer' }`。
8. **分析器和搜索窗口在同一个停靠组里。** 分析后分析器标签会盖住搜索窗口，e2e 要先点 `getByRole('tab', { name: 'Search', exact: true })`。
9. **键盘处理要 `stopPropagation`。** 分析器（含 Delete、F2）和搜索列表（含 Ctrl+Shift+R）都这样做，否则窗口级处理器会作用到程序集树的选中项。
10. **语法高亮只画后端给了分段的行。** 测试夹具里不带 `labelParts` 的节点仍是纯文本，`getByText` 之类的断言不受影响；要测高亮就在夹具里给 `labelParts`。
11. **切换语言不会改变 `t` 的引用。** 依赖翻译结果的 `useMemo` 要把 `locale` 放进依赖（分析器已修，e2e「words and sorts the searches in the language the window is in」覆盖）。
12. **Playwright 每次运行都会清空 `frontend/test-results/`。** 手动验证用的驱动脚本别放那里（上一版的 `drive-analyzer.mjs` 就这样丢了），放 `/tmp`，用 `createRequire(frontend/package.json)` 引 `@playwright/test`。
13. **搜索窗口相关的 e2e 写法**：结果列表是窗口化的，`getByRole('option').count()` 只数画出来的行；类型框和位置框是原生 `<select>`，它们的 `<option>` 也是 `option` 角色，取结果行要先限定 `getByRole('listbox', { name: 'Search results' })`。Ctrl+T 等快捷键只在焦点位于搜索窗口内时生效（与 WPF 的 InputBindings 一致）。
14. **构建与测试环境**
    - e2e：先构建 `dotnet build backend/dnSpy.Backend.Host`，再 `pnpm build`，然后运行 `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pnpm test:e2e`。
    - e2e 运行中不要重新构建后端，测试每次都启动 `bin/Debug` 下的 Host。
    - 离线环境下新增 csproj 时，先用 `-p:NuGetAudit=false` 构建一次。
    - Monaco 只渲染视口内的行，靠下的行要先 `Control+End`。

## 四、本轮完成的事项与验证

| 原任务 | 结果 |
|---|---|
| A1 调试组 | 完成；菜单测试 + e2e（添加方法断点后出现在断点窗口）。按用户决定，程序集树和代码编辑器原来是切换的「添加方法断点」也改成 WPF 的只加不删，并像 WPF 一样接受属性/事件（加访问器）；代码编辑器光标不在方法/属性/事件引用上时，仍按语句所在方法下断点（端口原有的约定） |
| A2 搜索窗口分析 | 完成；`SearchPane.test.tsx` + e2e（右键菜单和 Ctrl+Shift+R） |
| A3 边搜边出 | 完成；后端流式测试（批次 + 响应 = 一次性结果）、store 测试、实机验证 |
| A4 虚拟化 | 完成；`AnalyzerPane.test.tsx` 窗口化测试 |
| A5 语法高亮 | 完成（分析器 + 程序集树）；后端分段测试、组件测试、e2e 断言颜色 |
| A6 并行扫描 | 已实现但默认关闭，原因见「坑」第 4 条 |
| B 后端测试 | `WorkspaceAnalyzerScopeTests`（现场生成模块：非友元排除、`IgnoresAccessChecksTo` 包含、跨模块 DllImport、伪特性 `IncludeAllModules`）；搜索中途编辑抛 `EditConflict` |
| B 前端/e2e | `backend-client` abort 单测；e2e 覆盖分析器菜单与显示标记/语法高亮开关、Monaco 里的 Ctrl+Shift+R、属性 get/set 行、中文类别名与排序 |

实机验证（Playwright 驱动真实应用；当时的驱动脚本放在 `frontend/test-results/run/`，已被 Playwright 清掉，见「坑」第 12 条）：

- 打开 System.Private.CoreLib + 24 个最大的框架程序集，分析 `System.Object` 的「被使用」：约 3.4–3.9s，分 16 批左右流入，停在 20,000 行，输出窗口出现「The analyzer stopped after 20000 result(s).」（当时的上限，2026-10-16 已取消，见第六节）。
- 同一搜索进行中，树请求等待 p50 约 15–20ms、最大约 200ms；同时反编译 `System.String` 约 1.6s，能正常完成。
- 只开 9 个程序集时结果 16,327 行，未截断，与后端进程内直接调用的结果一致。

## 五、余下任务

1. **与 WPF 逐类别对比结果**：分析器和搜索窗口都需要在 Windows 上对同一程序集对照，本机（Linux）做不了。
2. 上一版的「搜索窗口选项组」「搜索结果语法高亮」「类跟踪点」三项已完成（第八节、第一节）。
3. 搜索窗口与 WPF 仍有的差异见第八节末尾的表，都是有意或已知的，暂无待办。

## 六、已知与 WPF 的差异

| 差异 | 是否有意 |
|---|---|
| 「被应用于」的程序集行跨模块去重，WPF 每个模块各出一行 | 有意（WPF 的 quirk） |
| ~~`GetOriginalCodeLocation` 始终开启~~ 2026-10-16 起与 WPF 一致：只在 C# 反编译器且开启 AnonymousMethods 时才做（请求带 `Language`、`DecompileAnonymousMethods`，`IAnalyzerHost.ShowsOriginalCodeLocation`） | 已对齐 |
| 成员名不经 `IdentifierEscaper` 转义 | 与本项目程序集树保持一致 |
| 行文本随反编译器语言重写：`AnalyzeNodesRequest`/`AnalyzeChildrenRequest` 带 `Language`，类型名 C# 走 `CSharpTypeName`、VB 走 `CSharpTypeName.VisualBasic.cs`、IL 走 `ILTypeName.cs`；前端在 `defaultLanguage` 变化时 `relabel()`，旧语言请求晚到的批次也重写 | 已对齐（2026-10-16）；VB 的 `dynamic` 写成 `Object`，WPF 写成 `unknown` |
| 类型解析比 WPF 宽松：按全名兜底，MemberRef 用 `DontCompareTypeScope` 重试 | 有意，因为没有共享 resolver |
| 「显示方法内的引用」在 C# 与 IL 文档里定位（IL 视图 2026-10-16 起有指令操作数的引用 span，`ILReferenceTarget` 与结果的 `Targets` 用同一种解析）；VB 文档没有语句表，只打开方法 | VB 属反编译模块的限制 |
| 「单击展开节点」开启时，双击搜索行不再切换展开状态 | 有意，避免一次双击开了又关 |
| ~~结果数上限 20,000~~ 2026-10-16 起与 WPF 一样不设上限（`MaxResults` 默认 `int.MaxValue`，客户端仍可自带上限）。实测 25 个框架程序集 `Object` 的「被使用」28,485 行、约 6 秒、JSON 约 33MB；前端排序预先大写化，28k 行每次重排约 40ms | 已对齐 |
| 引用到未加载程序集的类型按普通类型着色（WPF 会加载后区分接口/结构等） | 有意，着色不触发加载 |
| 并行扫描默认关闭（WPF 用 PLINQ） | 有意，见「坑」第 4 条 |

## 七、相关文件速查

| 类别 | 文件 |
|---|---|
| WPF 参考 | `Extensions/dnSpy.Analyzer/`（`AnalyzerService.cs`、`Commands.cs`、`TreeNodes/*.cs`）、`dnSpy/dnSpy.Contracts.Logic/Decompiler/`（含 `MetadataTextColorProvider.cs`）、`dnSpy/dnSpy/Search/Commands.cs`、`Extensions/dnSpy.Debugger/dnSpy.Debugger.DotNet/Breakpoints/Code/TextEditor/ClassBreakpointCommands.cs`、`dnSpy/dnSpy/Themes/*.dntheme` |
| 后端测试 | `WorkspaceAnalyzerTests.cs`（夹具：`backend/tests/AnalyzerTarget`、`AnalyzerTarget.Consumer`；该类的 manager 用 0 预算、0 间隔，每片一个类型）、`WorkspaceAnalyzerScopeTests.cs`、`WorkspaceManagerTests.AnalyzesAcrossOpenedModules` |
| 前端测试 | `analyzer-model.test.ts`、`analyzer-store.test.ts`、`components/AnalyzerPane.test.tsx`、`components/AnalyzerContextMenu.test.tsx`、`components/SearchPane.test.tsx`、`components/AssemblyExplorer.test.tsx`、`app-store.test.ts`（class breakpoints）、`main/backend-client.test.ts` |
| e2e | `tests/e2e/app.spec.ts`：`the workspace shell` 下的「analyzes a search result…」「opens an analyzed property onto its accessors…」；`the code viewer context menu` 下的「keeps the caret…」「opens an analyzed member onto its searches…」「lays the analyzer menu out…」「analyzes the reference under the caret with Ctrl+Shift+R」「words and sorts the searches in the language the window is in」 |

## 八、搜索窗口（按 WPF `dnSpy/dnSpy/Search` 移植）

### 后端：`backend/dnSpy.Backend.Core/Search/` 与 `WorkspaceManager.Search.cs`

| 文件 | 移植自 | 作用 |
|---|---|---|
| `SearchComparers.cs` | `SearchComparer.cs` | 空格分词（全部匹配 / 匹配任一）、`/正则/`、字面量比较器（整数、浮点、字符串、加引号的字符串）；字段/参数的常量值经 `Unwrap` 参与字面量比较 |
| `SearchFilter.cs` | `FlagsDocumentTreeNodeFilter`、`VisibleMembersFlags` | 每种节点「找它 / 只看里面 / 跳过」；`FlagsOf` 是 SearchControlVM 的 24 项表 |
| `FilterSearcher.cs` | `FilterSearcher.cs` | 遍历器。写成迭代器，每个类型、资源、资源项之后 `yield`，所以能按切片跑。命中记成 `SearchHit`（Object / NameObject / LocationObject / 文件 / IL 指令） |
| `SearchRun.cs` | `DocumentSearcher.cs` | 切片运行与上限：第 `MaxResults + 1` 条结束搜索并标 `Truncated` |
| `SearchResultFormatter.cs` | `SearchResult.CreateUI` + `CSharpFormatter`（DefaultFormatterOptions） | 结果文本与分段着色：`string Describe(int, [string], params object[])`、`string Title { get; init; }`、`string Title.get`、`int this[int] { get; }`、`implicit operator string(Library)`、`int NativeCall() (native_entry)`；枚举常量不写类型；类型名走 `CSharpTypeName`（嵌套类型写成 `Library.Nested<T>`） |
| `FrameworkAssemblies.cs` | `FrameworkFileUtils` | 「在框架程序集中搜索」关掉时排除的程序集（运行时目录 + 名单，没有 GAC） |
| `CompilerGeneratedMembers.cs` | ILSpy `MemberIsHidden` 的近似 | 「搜索编译器生成的成员」关掉时隐藏的成员 |
| `ResourceTexts.cs` | `GuessFileType` / `ResourceUtilities.TryGetString` | 资源是不是文本（BOM 或前 500KB 是合法 UTF-8） |
| `WorkspaceManager.Search.cs` | `SearchControlVM.StartSearch`、`SearchService.FollowResult` | RPC 入口、切片循环（复用分析器的 `AnalyzerSliceBudget` / `AnalyzerProgressInterval` 和 `analyzerEpoch`）、四种位置、命中 → DTO（节点 id、图标、提示） |

- 协议：`search/run` 的 `SearchRequest`（查询、`SearchType`、`Location`、`SelectedNodeIds`、6 个选项、`MaxResults`、`ProgressToken`），进度通知 `search/progress`，`SearchResultDto`（`NodeId` 可空、`NameParts` / `LocationParts`、`Icon` / `LocationIcon`、`ToolTip`、`IlOffset`）。`SearchTypes` / `SearchLocations` 常量追加在 `Protocol.cs` 末尾。
- 参数、局部变量、方法体字面量命中时，结果是**所在方法**（与 WPF 一致）；特性参数命中时结果是挂特性的那个东西（参数则写参数名，位置是方法）。
- 资源：按名称（含 `Uri.UnescapeDataString`）、嵌入文件的文本内容、`.resources` 项的内置值（字符串当名称比，数字当字面量比）、BAML 反编译出的 XAML（「反编译资源」开着时；每个模块只建一个 `XamlDecompiler`）。
- **性能坑**：资源项的树节点要靠 `GetEmbeddedResourceChildren` 解码整个 `.resources` 才建得出来。每条命中都调一次会变成 O(n²)（CoreLib 的 Strings.resources 有几千项，一次「String」搜索从 9s 降到 1.7s 就是修的这个）。现在先按 `ResourceEntryKey` 查已有节点，没有才解码一次。
- 测试：`WorkspaceSearchTests.cs`（14 条），夹具是新项目 `backend/tests/SearchTarget`（运算符、init、索引器、事件、DllImport、const、默认参数、params、lambda、迭代器、特性参数、嵌入文本资源、resx）。新增 csproj 离线首次构建要 `-p:NuGetAudit=false`。

### 前端

| 文件 | 作用 |
|---|---|
| `search-model.ts` | 类型框 24 项（顺序、图标、Ctrl 字母 `tfmpejinrubl`）、位置框 4 项（`gsdq`）、按名称排序（`Intl.Collator` 忽略大小写，同名保持发现顺序）、`findSearchResultCaret`（复用分析器的 `findReferenceCaret`，光标落在语句开头） |
| `search-store.ts` | 独立 zustand store：`setQuery` 停顿 500ms 后搜；`restart` 取消上一个请求再搜；批次按 `start` 去重追加；工作区关闭清空、换工作区/编辑/撤销/重载/增删程序集时重搜；`updateSearchSettings` 改设置，只有影响搜索的设置才重搜（语法高亮不重搜）；`requestFocus` 供 Ctrl+Shift+K |
| `components/SearchPane.tsx` | 搜索窗口：文本框、选项展开按钮、「搜索:」类型框（选中项前画图标）、位置框、6 个复选框、窗口化结果列表（行高 22px）、「搜索中…」和「搜索中止」两条消息排在最前、上限时红框；双击/Enter 跟随（Ctrl/Shift 新标签页），方法体命中把光标放到语句上；Ctrl+Shift+R 分析；Ctrl+字母切类型/位置并把焦点给文本框 |
| `components/SearchContextMenu.tsx` | 加了选项组（`GROUP_CTX_SEARCH_OPTIONS` = 10000）：语法高亮、全词匹配、区分大小写、匹配任一、反编译资源、框架程序集、编译器生成成员，开着的打勾 |
| `components/app-options.ts` | `search: SearchSettings`（类型、位置和 7 个开关），默认值同 WPF `SearchSettings` |
| `main/index.ts`、`preload` | `search:run`（带 requestKey，600s 超时，可 `search:cancel`）、`search/progress` → `search:progress` |

旧的 `app-store` 里的 `searchResults` / `runSearch` 和「Search returned N result(s).」输出已删除（WPF 不往输出窗口写）。

### 实机验证（25 个框架程序集，驱动脚本 `/tmp/drive-search.mjs`）

- 「以上所有」搜 `String`：约 0.7s 出第一行，约 3s 停在一万条，红框和「Search aborted, more than 10,000 results found.」都在。
- 搜索进行中展开树节点约 65ms。
- 字面量 `"Arg_ArgumentOutOfRangeException"`：1 条（`string Arg_ArgumentOutOfRangeException.get`，位置 `System.SR`），双击后光标落在 `return GetResourceString(...)` 语句开头，提示里有 `IL_0000: ldstr "..."` 和文件路径。
- 选项展开区与右键菜单选项组截图核对过。

### 与 WPF 的差异

| 差异 | 是否有意 |
|---|---|
| 类型框是原生 `<select>`，下拉项里没有图标（选中项前有）；快捷键提示放在 `title` | 有意，换取可访问性和测试便利 |
| 结果提示只有「名称 + IL 指令 + 文件」，没有反编译器的成员提示（声明类型、参数名） | 已知简化 |
| 不搜 `<Module>` 全局类型 | 有意，端口的树不显示它，结果无处可跳 |
| 模块引用结果没有节点可跳（`NodeId` 为空） | 端口的树没有模块引用行 |
| 名称不经 `IdentifierEscaper` | 与程序集树一致 |
| `FixTypeName` 处理嵌套泛型（`Outer`1/Inner`）时不吞掉后面的字符 | 有意，WPF 那里有 off-by-one |
| 单线程按切片搜，WPF 每个程序集一个线程 | 有意，同分析器（「坑」第 4 条） |
| 关闭搜索窗口不清空查询（WPF `OnClose` 会清） | 已知；flexlayout 挪动标签页也会卸载组件，不好区分 |
| 搜索框按 Enter 立即搜 | 端口附加的便利，WPF 只靠停顿 |

