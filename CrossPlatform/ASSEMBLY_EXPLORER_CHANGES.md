# 程序集资源管理器调整总结

根据WPF版本的实现，已完成以下调整：

## 改动清单

### 1. ✅ 程序集默认收起（不自动展开）
**文件**: `frontend/src/renderer/src/components/AssemblyExplorer.tsx`

- 移除了自动展开根节点的逻辑
- 删除了 `useEffect` hook 和相关的状态依赖
- 现在打开DLL后，程序集节点默认处于收起状态，需要手动点击展开

### 2. ✅ 显示版本号
**文件**: `backend/dnSpy.Backend.Core/WorkspaceManager.cs`

在 `GetLabel` 方法中添加了版本号显示：
- `GetModuleLabel` 方法：显示格式为 `AssemblyName (Version)`
- `GetAssemblyReferenceLabel` 方法：引用也显示版本号
- 示例：`mscorlib (4.0.0.0)`, `System.Core (4.0.0.0)`

### 3. ✅ 调整子节点顺序（参考WPF ModuleDocumentNodeImpl.CreateChildren）
**文件**: `backend/dnSpy.Backend.Core/WorkspaceManager.cs`

展开Module节点后，子节点顺序调整为：
1. **PE** - PE文件结构（如果存在）
2. **Type References** - 类型引用文件夹
3. **Assembly References** - 程序集引用（如果有）
4. **Resources** - 资源（如果有）
5. **命名空间** - 按字母顺序排列，空命名空间显示为 "-"

这与WPF版本完全一致。

### 4. ✅ 新增节点类型

添加了两个新的NodeKind：
- `PE` - 表示PE文件结构节点
- `TypeReferencesGroup` - 表示类型引用组

### 5. 实现细节

**新增方法**:
- `GetPEChildren()` - 获取PE节点的子节点（占位实现）
- `GetTypeReferenceChildren()` - 获取类型引用子节点（占位实现）

**修改方法**:
- `GetModuleChildren()` - 按WPF顺序返回子节点
- `GetLabel()` - 添加PE和TypeReferencesGroup的标签
- `GetIcon()` - 添加PE和TypeReferencesGroup的图标
- `HasChildren()` - 标记PE和TypeReferencesGroup有子节点
- `GetChildren()` - 添加PE和TypeReferencesGroup的分支处理

## WPF参考实现

参考文件：`dnSpy/dnSpy/Documents/TreeView/ModuleDocumentNodeImpl.cs`

```csharp
protected override IEnumerable<DocumentTreeNodeData> CreateChildren() {
    // 1. Document.Children (PE等子文档)
    foreach (var document in Document.Children)
        yield return new DsDocumentNode(document);
    
    // 2. Resources
    yield return new ResourcesFolderNodeImpl(...);
    
    // 3. References
    yield return new ReferencesFolderNodeImpl(...);
    
    // 4. Type References
    yield return new TypeReferencesFolderNodeImpl(...);
    
    // 5. Namespaces
    foreach (var ns in GetNamespaceNodes())
        yield return ns;
}
```

## 验证方法

启动应用后：

1. **打开DLL文件** - 通过 File → Open 或 Ctrl+O
2. **检查默认状态** - 程序集节点应该是收起的（没有自动展开）
3. **检查版本号** - 程序集名称应该显示版本号，如 `mscorlib (4.0.0.0)`
4. **展开节点** - 点击展开箭头后，顺序应该是：
   - PE（如果有PE文件）
   - Type References
   - Assembly References（如果有引用）
   - Resources（如果有资源）
   - -（空命名空间，如果有）
   - 其他命名空间（按字母顺序）

## 编译状态

- ✅ 后端编译成功：所有项目已成功编译
- ✅ 前端编译成功：2711 个模块已转换
- 📦 应用已构建完成，可以运行测试

## 待完善

目前PE和Type References节点返回空子节点列表，这是占位实现。完整实现需要：

1. **PE节点** - 显示PE文件的各个section（.text, .rsrc, metadata等）
2. **Type References节点** - 显示模块引用的外部类型

这些可以在后续根据需要进行完善。

### 6. ✅ 类型下的「基类和接口」「派生类型」分组

**文件**: `backend/dnSpy.Backend.Core/WorkspaceManager.cs`、`frontend/src/renderer/src/components/AssemblyExplorer.tsx`

参考 WPF 的 `TypeNodeImpl` / `BaseTypeFolderNodeImpl` / `DerivedTypesFolderNodeImpl` / `BaseTypeNodeImpl` / `DerivedTypeNodeImpl`，每个类型节点现在先挂两个文件夹，再挂成员：

1. **Base Type and Interfaces**（基类和接口，`basetypefolder`）
2. **Derived Types**（派生类型，`derivedtypesfolder`）
3. 嵌套类型、字段、属性、事件、方法（顺序不变）

新增 `NodeKind`：`BaseTypeFolder`、`BaseType`、`DerivedTypesFolder`、`DerivedType`。

与 WPF 一致的语义：
- 两个文件夹总是惰性加载并显示展开箭头，即使为空（WPF 的 `LazyLoading = true`）。
- 派生类型按 `DerivedTypesFinder.QuickCheck` 短路：接口或非 sealed 类型才会去找派生类型，sealed 类型的「派生类型」文件夹没有展开箭头。
- 基类型行用 `CSharpTypeName` 拼名（嵌套类型写成 `Outer.Inner`，与反编译输出一致），显示名是短名（如 `object`），提示里保留全名，并带 `@` 元数据令牌。
- 基类型行自身也有基类型（可选链继续下行）。
- 派生类型跨所有已加载模块查找，用 `SigComparer` 比较（与 WPF 的匹配方式一致），类型索引按 `stateId` 缓存。
- 双击这两个文件夹不打开文档（它们是标题而非文档）；双击基类型/派生类型行则像类型行一样打开注释文档，内容是这些类型的全名注释行。

## 验证方法（类型分组）

1. 打开 `DebugTarget.dll`，展开 `Program`：
   - 前两行是 `Base Type and Interfaces`、`Derived Types`
   - 展开「Base Type and Interfaces」→ `object @…`
   - `Program` 是 static（sealed），其「Derived Types」的展开箭头为禁用
2. 展开接口 `IWorker`：其「Derived Types」可展开，里面有 `Worker @…`
3. 展开 `Worker`：其「Base Type and Interfaces」里有 `object` 与 `Program.IWorker`（接口图标）

对应测试：
- 后端 `WorkspaceManagerTests.TypeChildren_StartWithTheBaseTypeAndDerivedTypesFolders`、`DerivedTypes_FindATypeInAnotherOpenModule`
- 前端 `AssemblyExplorer.test.tsx`（令牌与翻译）、`AssemblyExplorerContextMenu.test.tsx`（文件夹不打开文档）
- e2e `app.spec.ts` › `the type hierarchy groups`

### 7. ✅ 属性/事件的访问器合到成员下面（get/set 合起来展示）

**文件**: `backend/dnSpy.Backend.Core/WorkspaceManager.cs`、`frontend/src/renderer/src/App.tsx`、`frontend/src/renderer/src/app-store.ts`

参考 WPF 的 `TypeNodeImpl.CreateChildren`（`hash = TypeDef.GetPropertyAndEventMethods()`，然后用 `!hash.Contains(m)` 过滤方法列表）+ `PropertyNodeImpl` / `EventNodeImpl`（访问器作为自己的子节点），类型的成员列表里不再直接出现访问器方法：

1. 类型的方法列表过滤掉所有被属性或事件拥有的方法（`GetPropertyAndEventMethods`：属性的 `GetMethods`/`SetMethods`/`OtherMethods`，事件的 `AddMethod`/`RemoveMethod`/`InvokeMethod`/`OtherMethods`）。
2. 属性节点下依次列 `GetMethods`、`SetMethods`、`OtherMethods`；事件节点下依次列 `AddMethod`、`RemoveMethod`、`InvokeMethod`、`OtherMethods`（顺序与 WPF 一致）。
3. 只有真的拥有访问器的属性/事件才有展开箭头（`HasAccessorMethods`）；`C# { get; }` 编译出的 getter 正是一个访问器，因此 `RpcException.Code` 现在带箭头，它下面才是 `get_Code()`。
4. `GetNodePath` 在链上补上拥有访问器的属性/事件，这样「转到令牌」「F12 跳转」在前端展开的是属性行，getter 行才会出现（否则客户端会拿着一个树上还不存在的行去选中）。

访问器行本身的节点 id、标签、令牌都没变，只是挂到了成员下面；因此 `Edit Method`、`Add Method Breakpoint`、十六进制命令等仍然按节点 id 工作，行为不变。

有一处必须跟着改：**「Add Class Breakpoint」**。WPF 的命令走的是 `type.Methods`（`ClassBreakpointCommands.cs`），而属性/事件的访问器也在 `type.Methods` 里；本移植的命令为了拿到带参数列表的方法名，改成读树上的行，所以现在除了类型自己的方法行，还要把属性/事件行下面的访问器行一并读进来（`addClassBreakpoint` 会先 `loadChildren` 每个属性/事件行再收集）。不补这一步，getter 就不再被类断点覆盖。

唯一需要跟着改的前端逻辑是创建类命令的宿主类型：`ownerTypeIdOf` 原来只往上看一层，访问器的上一层是属性而不是类型，现在改为沿 `parents` 链一直走到最近的类型祖先（`nodesByIdOf` 提供每一层的 kind）。`buildSession` 也复用这个查找函数。

已知与 WPF 的差异（未做，非本次范围）：
- WPF 在**属性行**上右键也有 `Add Method Breakpoint`（它的 `GetMethodReferences` 会把 `PropertyDef` 展开成 get/set），本移植的该命令只出现在方法行上。
- 类型下**成员组的顺序**与 WPF 相反：WPF 的 `TypeNodeImpl.CreateChildren` 是 方法 → 属性 → 事件 → 字段 → 嵌套类型，本移植沿用既有顺序 嵌套类型 → 字段 → 属性 → 事件 → 方法（`GetPropertyAndEventMethods` 的过滤对两者都成立，只是排布不同）。本次按要求只做「访问器合到成员下面」，未动这个顺序。

对应测试：
- 后端 `WorkspaceManagerTests.AccessorsAreListedUnderTheMemberThatDeclaresThem`、`EventAccessorsAreListedUnderTheEvent`（夹具程序集里没有事件，这条自己写一个带事件的模块）、`NodePath_LeadsFromTheRootToTheNodeItself`
- 前端 `app-store.test.ts` › `ownerTypeIdOf`、`class breakpoints`（访问器也要被类断点覆盖）
- e2e：凡是点 `get_Code()` 的用例都先展开它的属性行（`expandPropertyRow`）；`go to token` 那条不展开，验证 `GetNodePath` 自己把属性行打开

### 8. ✅ 「打开十六进制编辑器」改为 WPF 的可见范围（选项存在，不删）

参考 WPF 的 `Extensions/dnSpy.AsmEditor/Hex/Commands.cs`（`OpenHexEditorCommand.IsVisibleInternal` / `GetDocumentNode`），两个注册点分别是 `GROUP_CTX_DOCVIEWER_HEX`（代码视图右键）与 `GROUP_APP_MENU_EDIT_HEX`（编辑菜单），同一命令另有树右键的那份：

- 该选项在 WPF 里**存在**（"Open He_x Editor"，Ctrl+X），所以本移植保留，只是原来的可见范围与 WPF 相反：树里选中任何一个模块内的行（命名空间/类型/方法/字段/属性/事件/资源）都显示，反而程序集根行不显示。
- WPF 的规则是「命中的行本身是**文档行**」：`DsDocumentNode` 及其子类——程序集、模块、只有 PE 的文件、未知文件（本移植另有 ELF 文件行 `elfdocument`）。命名空间、类型、成员、资源、以及模块下的 `pe`/`pestructure`、ELF 结构行，都是文件**内部**的东西，不是文件，命令不开它们。
- 三处菜单现在共用 `hex-menu.ts` 里同一个 order 0 谓词：`文档行 || 打开着代码文档`，并且当「光标所在语句」那条命令（order 20）可见时让位——WPF 两者共用同一个 `GetDocumentNode`，本来就互斥。
  - **树右键**：命中的行是文档行才显示（`AssemblyExplorerContextMenu.tsx` 不设 `documentAvailable`）。
  - **代码视图右键**：代码文档就在眼前，一直显示（`DocumentView.tsx` 传 `documentAvailable: true`）。
  - **编辑菜单**：打开着代码文档，或选中的是文档行（`MenuBar.tsx` 传 `activeDocument === 'code'`）。十六进制标签页与元数据表标签页在 WPF 里都不是 `IDocumentViewer`，所以不算「打开着文档」。
- 其余十六进制命令（order 20、50~130）仍按解析出的 hex 目标显示，行为未变；后端 `ResolveHexTarget` 也没动——文档行本来就返回「文件 + 无成员目标」，正好让文件命令有东西可开，成员命令没有。

对应测试：
- 前端 `AssemblyExplorerContextMenu.test.tsx` › `opens the hex editor from the rows that are documents, and from no others`（新增）：文档行五类显示，`namespace`/`type`/`method`/`pe`/`elf` 等不显示
- 前端 `MenuBar.test.tsx` › `opens the hex editor for the file the selection names, or for the open document`（改写）、`shows the statement hex command only while no method target is resolved`（补互斥断言）
- 前端 `CodeEditorContextMenu.test.tsx`：上下文加上 `documentAvailable`（与 `DocumentView` 的调用一致），代码视图菜单里 order 0 一直在
- e2e `app.spec.ts`：类型行右键的标签表里没有该项，模块行的标签表里有；代码视图右键的组顺序里 `Open Hex Editor` 在 token 之后、语句命令之前；未打开任何文档时编辑菜单里没有该项
