# 程序集树：前端对接与 WPF 对齐（2026-10-13 / 10-14）

本文记录程序集树（Assembly Explorer）从「后端已移植、前端只对接了 API」到「功能对齐 WPF」这一步做了什么、怎么验证的，以及还没做的部分。逐项状态见 [cross-platform-port-status.md](./cross-platform-port-status.md) 第 4.3 节。

## 1. 起点：上一轮对接留下的问题

提交 `0030bb1f7`（后端）和 `4243ad39d`（前端 API）之后，代码和文档里有几处对不上：

- **RPC 没路由。** `Protocol.cs` 定义了方法名，`WorkspaceManager` 也有实现，但 `JsonRpcServer` 里没有对应分支，前端一调就是 `MethodNotFound`。缺的有 `workspace/removeModules`、`workspace/getModifiedModules`、`workspace/getCloseCandidates`、`workspace/moveRoots`、`workspace/dropFiles`、`tree/activate`、`gac/list`、`gac/getDetails`、`resource/getItems`、`resource/find`。
- **前端 DTO 与后端不一致。** `ActivateNodeResponse`（前端写成 `addedModule`，后端是 `rootsChanged`）、`DropFilesResponse`（前端读 `roots`/`index`，后端没有）、`ModifiedModulesResponse`（`modifiedNodeIds` 对 `paths`）、`ResourceItemsResponse`。`TreeNode` 缺后端新加的 `toolTip`、`msdnName`、`compilerGenerated`、`autoLoaded`、`assemblyVersion`、`publicKeyToken`。
- **图标名换了，前端没跟。** 后端改发 DsImages 名（`ClassPublic`、`BinaryFile`、`AssemblyError`…），前端 `NodeIcon` 还按旧的小写名匹配，所有行都退回默认图标。
- **程序集行的版本号丢了。** 后端把版本从 `Label` 挪到 `AssemblyVersion` 字段，前端没有拼回去。
- **后端测试没跟上。** 22 个后端测试在真实构建下是红的（此前的「346 通过」是用 `--no-build` 跑在旧 DLL 上得到的）。
- **e2e 钉死的元数据 token 被顶掉。** `0030bb1f7` 在 `RpcException` 前面加了 record，`RpcException` 从 `@02000073` 变成 `@02000075`，`get_Code` 从 `@060008B6` 变成 `@060008DC`；而 `@02000073` 现在恰好是 `RpcError`，旧的钉子会悄悄匹配到错的行。

## 2. 这一轮做了什么

### 后端

| 改动 | 位置 |
|---|---|
| 补齐上面列出的 10 个 RPC 路由 | `dnSpy.Backend.Host/JsonRpcServer.cs` |
| 新 RPC `documentList/defaults`：每个已安装 .NET 共享框架版本一个文件列表，筛选规则照搬 WPF `DotnetReferenceFileFinder.FilterFiles` | `dnSpy.Backend.Core/DefaultDocumentLists.cs` |
| 程序集文档标签标题带版本号（树行的版本改由前端拼，标签标题沿用 WPF 默认） | `WorkspaceManager.cs` 的 `GetDocumentTitle` |
| 修 Type References 展开时的空引用：成员引用的泛型参数没有所有者，改写成 `!0`/`!!0` | `CSharpTypeName.cs` |
| 21 个过期测试按 WPF 行为更新期望（DsImages 图标名、版本号移出 Label、`<Module>` 在 `-` 命名空间、构造函数行用类型名、程序集引用展开为被引用程序集的引用、Remove 接受非托管文档） | `tests/dnSpy.Backend.Tests/*` |

### 前端

| 功能 | WPF 来源 | 实现 |
|---|---|---|
| Open from GAC | `OpenFromGACVM.cs`、`OpenFromGACDlg.xaml` | `OpenFromGacDialog.tsx`：按名称和版本逐段排序；跨 GAC 的重复项（名称+版本+token，忽略 culture）默认隐藏；多词搜索名称或版本；右侧详情（创建者、文件版本通过 `gac/getDetails` 读取）；Ctrl/Shift 多选；双击打开；Ctrl+Shift+O |
| Open List | `OpenDocumentListVM.cs`、`DocumentListService.cs`、`DocumentListLoader.cs` | `OpenListDialog.tsx`、`document-lists.ts`：命名列表存 `dnspy.documentLists.v1`；打开对话框前和关窗前把当前文件记入选中列表；内置列表来自 `documentList/defaults`；新建、移除（不移除当前选中的）、仅显示已保存的列表；确定后切换到另一列表时先确认未保存修改，再关闭工作区并打开新列表 |
| Close All Framework Assemblies / Missing Files | `CloseAll*Command.cs` | 读 `getCloseCandidates`，走与 Remove Assembly 相同的路径：先确认未保存修改，再 `removeModules`，关掉被移除文档的标签 |
| Remove Assembly | `RemoveAssemblyCommand` | 作用于选中的全部根行（程序集、PE、ELF、未知文档）；标题「移除 {name}」/「移除 {n} 程序集」；树右键、Edit 菜单、Del 键共用一条路径 |
| 拖放 | `DocumentTreeView.cs` 的 `OnDropFiles`、`OnDropNodes` | 桌面文件落在哪个根行（或其子行）上就插到它前面，落在空白处追加到末尾；多文件按「拖入项过滤」选项筛选；路径经 preload 的 `webUtils.getPathForFile` 取得（Electron 32 起 `File.path` 已移除）；拖动根行改变顺序 |
| 激活跳转 | `DocumentTabService.NodeActivated` | 程序集引用、基类型、派生类型、类型引用、方法/属性/事件/字段引用的双击或 Enter 走 `tree/activate`，选中目标行（必要时先自动加载程序集）；解析不到时才按普通行打开 |
| Go to Resource | `ResourceCommands.cs` | 树右键：打开菜单前对属性/方法问一次 `resource/find`，只在能定位到 .resources 条目时显示；选中并打开该条目 |
| Save / Raw Save Resource | `SaveResources.Save` | 作用于选中的全部资源；一个文件走保存对话框，多个写入所选目录；.resources 文件按条目反序列化保存，Raw 保存写序列化字节（此前 `raw` 参数在主进程被丢掉，缺陷 #5） |
| Assembly Explorer 选项 | `DocumentTreeViewSettings.cs` | 原来只有 token 和语法高亮生效，现在七项全部生效：版本号、PublicKeyToken、单击展开（默认开，同 WPF）、成员分组顺序、拖入项过滤 |
| 隐藏编译器生成的成员 | 各 `*NodeImpl.GetFilterType` 里的 `ShowMember` | 按后端 `compilerGenerated` 过滤，跟随 C# 反编译器「显示隐藏的编译器生成类型和方法」 |
| 图标 | `DotNetImageService` | `iconFamily` 把 DsImages 名归到图标族（类、接口、枚举、结构、委托、常量…）再画 lucide 图标；分析器、类型选择器共用 |
| 其他 | | 树行用后端 `toolTip` 作提示；自动加载的根行文字变淡；`References` 文件夹补中文翻译 |

## 3. 验证

在本机按顺序跑过：

| 套件 | 结果 |
|---|---|
| 后端 `dotnet test`（先 `-p:NuGetAudit=false` 构建） | 348 通过（原 346，新增 `DefaultDocumentListsTests` 2 条） |
| 前端 `pnpm typecheck`（renderer 与 main/preload 两个 tsconfig） | 0 错误 |
| 前端 `pnpm test` | 929 通过（`MenuBar.test.tsx` 里一条 5 秒超时的用例在全量并行时偶发超时过一次，单独连跑 3 次均通过，最后一次全量也通过） |
| e2e `pnpm test:e2e`（先重建 Host 与前端） | 85 通过、3 跳过、0 失败 |

e2e 跑出来的问题里有两个真缺陷，已修：Convert Assembly to NetModule 之后程序集根行名字变空（前端裁掉版本号时下标为 -1）；自定义特性的「选择构造函数」列不出构造函数（构造函数行改用类型名后，选择器还按 `.ctor(` 认）。其余是断言过期。

e2e 的改动：重新钉 `RpcException @02000075` 与 `get_Code @060008DC`；File 菜单里 Open from GAC / Open List 现在应为可用；模块行不再有 Remove（WPF 只对根行提供），移除改在程序集根行上做；构造函数选择器按 `WorkspaceRequest(` 找行；F12 跳到的 `<Code>k__BackingField` 是编译器生成成员，树上默认不显示；单击命名空间会折叠它（单击展开默认开），后续步骤重新展开；资源保存用 Raw Save 校验 `.resources` 魔数；C# 高亮用例原来按 `title` 找类型行，现在 `title` 是 WPF 的多行提示，改按行文字找。

## 4. 第二轮：补齐剩余差距（2026-10-14）

第一轮之后 4.3 还剩 8 个 🟡 和几处备注里的缺口。这一轮逐项对照 WPF 源码补齐，4.3 达到 100%（✅ 30 / ⛔ 1）。

| 功能点 | WPF 依据 | 做法 |
|---|---|---|
| 节点图标 | `DotNetImageService`、`ThemedImageCreator`、`dnSpy/dnSpy.Images` | 新脚本 `scripts/generate-tree-images.mjs` 把图标集的 245 个 XAML 矢量图转成 SVG（只用到填充几何、分组透明度，按 `F0/F1` 定填充规则），生成并提交 `ds-images.generated.ts`，构建不依赖子模块。`ds-image.ts` 移植 ThemedImageCreator 的 HSL 换色算法，以 `--surface` 为背景给每种颜色换色；图片写进一张专用样式表，`NodeIcon` 只挂 `dsi-<名字>` 类。主题切换只改写这张样式表，行不重新渲染 |
| 键盘导航 | SharpTreeView `OnKeyDown`、`SharpTreeViewTextSearch`，ListBox Extended 选择 | 键盘处理移到树容器：方向键 / Home / End / 翻页、Shift 扩选（store 新增选择锚点）、Ctrl 只移焦点、Ctrl+Space、← →、小键盘 + − *、Enter / Space 激活、Ctrl+A、输入查找（`TreeTextSearch` 逐行移植）。书签组合键的第二个键让给外壳 |
| 最近文件 | `AssemblyExplorerMostRecentlyUsedList`、`RecentFilesCommand` | 每文件一条、30 条、大小写不敏感；菜单项为序号 + 完整路径（超 100 字符截断）；点开只加该文件并选中。旧的按组记录在首次读取时迁移。存储键的声明移到 `create()` 之前，避开模块求值期的暂时性死区（旧实现因此读不到已存的列表） |
| Reload All | `DocumentListLoader.Reload`、`UndoRedoDocumentListListener` | 先用 dnSpy 原话询问未保存修改；后端 `ReloadWorkspaceRequest` 只带回标签还在用的自动加载文件；`restoreSession` 拆出 `restoreTreeAndTabs`，重载后恢复分支、选中和标签，Hex / 模块信息标签按文件路径恢复。后端重载顺带清掉了 netmodule、类型引用索引和自动加载标记这几份此前漏清的缓存 |
| 命令行 | `AppCommandLineArgs`、`AppCommandLineArgsHandler` | `MAIN/command-line.ts` 按 WPF 规则解析，开发模式下按「第一个非开关参数」剔除应用目录；后端新 RPC `tree/selectMember`，移植 `XmlDocKeyProvider`（修正了它找不到嵌套类型的比较）；找不到成员时打开第一个程序集 |
| 程序集解析 | `AssemblyResolver.ResolveNormal` | `GacInfo.Resolve` 先按完整标识查缓存目录，再查 Mono 引用目录并核对标识；`GacFallbackAssemblyResolver` 包住 ICSharpCode 的 `UniversalAssemblyResolver`，非 .NET（Core）目标在常规搜索落空后查 GAC。树的引用解析和两处反编译会话都用它 |
| Copy Full Name / MD Token / Search MSDN | `CopyFullNameCommand`、`CopyTokenCommand`、`SearchMsdnCommand` | `TreeNodeDto` 新增 `FullName`（各 IMDTokenNode 的 `IFullName.FullName`）；`MsdnName` 扩展到基类型、派生类型、各种引用行（解析到已加载的定义）；复制取第一个选中行，MSDN 对每个选中行开一页 |
| Go to Resource | `GoToResourceCommand.TextEditorCommand` | 代码视图右键打开菜单前对引用的成员问一次 `resource/find`；树里限定单选 |
| 保存资源 | `SaveResourcesCommand` 四个变体、`SaveResources.GetFiles` | 新 RPC `resource/getItemNames` 给出两种保存方式的文件名，菜单标题按文件数；补「以子目录保存 / 以子目录直接保存」；单独选中 Resources 文件夹代表全部资源；主进程按名字建子目录，并把 `.`/`..` 段改写，防止写出所选目录 |
| Remove Assembly 与撤销 | `RemoveAssemblyCommand.Execute`、`DocumentSaver.AskUserToSaveIfModified` | 后端：撤销历史涉及的文档，移除记为一步编辑（同一批节点对象摘下、撤销时原样挂回），只在重做历史里的直接移除并清空重做；`EditCommitResponse.Modules` 让前端在撤销 / 重做后刷新模块列表、关闭被拿走文档的标签。前端：移除前问「是否要在继续之前保存？」（是 / 否 / 取消，主进程原生对话框，e2e 用 `DNSPY_E2E_SAVE_PROMPT` 指定回答），选「是」时逐个原地保存 |
| 构造函数行着色 | `MethodNode` 的名字 | 着色文本此前仍写 `.ctor`，与写类型名的标签不一致，改为同一个写法 |

### 一个踩到的坑

最初主题切换时用 `useSyncExternalStore` 让每个图标重新渲染，结果 `csharp-highlighting.spec.ts` 稳定失败：切换主题后代码视图全部变成无色。逐项排除后确认，只要在 MutationObserver 的那个微任务里做同步的 DOM / 样式工作（重新渲染或改写样式表），Monaco 就会在新主题下用错颜色重新分词；把工作推迟一个任务就正常。现在样式表在 `setTimeout` 里改写，图标也不再参与 React 渲染。

### 验证

| 套件 | 结果 |
|---|---|
| 后端 `dotnet test` | 359 通过（新增 `AssemblyExplorerCommandTests` 11 条） |
| 前端 `pnpm typecheck` | 0 错误 |
| 前端 vitest | 964 通过（`MenuBar.test.tsx` 那条 5 秒超时的用例在与 e2e 同时跑时又超时过一次，单独跑和全量重跑都通过） |
| e2e `pnpm test:e2e`（先重建 Host 与前端） | 89 通过、3 跳过、0 失败；新增的 4 条另以 `--repeat-each=4 --workers=4` 连跑通过 |

e2e 的改动：重新钉 `get_Code @060008E0`（`TreeNodeDto`、`EditCommitResponse` 各多一个属性）；模块行右键多出 Copy Full Name；新增 `assembly-tree.spec.ts` 4 条。

## 5. 还没做的

- Open from GAC、Open List、拖放没有 e2e。
- 菜单、工具栏和其余工具窗口的图标仍是 lucide-react（不属于程序集树，见 4.1、4.18）。
- 命令行里与树无关的选项（`--theme`、`--search` 等）和单实例转发属于 4.1。
