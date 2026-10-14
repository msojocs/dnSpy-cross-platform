# Roslyn 语言服务功能移植完成总结

## 概述

已完成 Roslyn 语言服务功能的移植，使其对齐 WPF 版本的完整实现。该功能通过 Microsoft.CodeAnalysis 与 Monaco 编辑器的语言服务提供者接口相结合，为 C# 代码编辑提供以下功能：

- **代码补全** (Completions)：支持类型、方法、属性、关键字等上下文感知的补全
- **悬停提示** (Quick Info)：显示符号类型信息和文档注释
- **签名帮助** (Signature Help)：提供方法调用时的参数提示
- **编译诊断** (Diagnostics)：实时显示编译错误、警告和信息

## 实现架构

### 后端 (.NET)

**文件**：`CrossPlatform/backend/dnSpy.Backend.Core/LanguageService/RoslynLanguageService.cs`

核心类 `RoslynLanguageService` 提供以下功能：
- `AdhocWorkspace` 管理文档
- 通过 Roslyn API 提供补全、悬停、签名帮助和诊断
- DTO 类型用于 RPC 通信

**文件**：`CrossPlatform/backend/dnSpy.Backend.Core/WorkspaceManager.LanguageService.cs`

WorkspaceManager 的部分类提供以下 RPC 端点：
- `languageService/updateDocument` - 更新文档内容
- `languageService/completions` - 获取补全列表
- `languageService/hover` - 获取悬停信息
- `languageService/signatureHelp` - 获取签名帮助
- `languageService/diagnostics` - 获取诊断信息

### 前端 (React/TypeScript)

**文件**：`CrossPlatform/frontend/src/renderer/src/roslyn-language-service.ts`

核心函数 `registerRoslynLanguageService()` 在 Monaco 编辑器中注册以下提供者：
- CompletionItemProvider：触发字符 `.`, `(`, `<`, `"`, 空格时触发
- HoverProvider：鼠标悬停时显示符号信息
- SignatureHelpProvider：输入 `(` 或 `,` 时触发
- CodeActionProvider：预留用于快速修复

**文件**：`CrossPlatform/frontend/src/renderer/src/monaco.ts`

在 Monaco 初始化时注册 Roslyn 语言服务。

### IPC 与 RPC 通信

**主进程**：`CrossPlatform/frontend/src/main/index.ts`

添加 IPC 处理器，将前端请求路由到后端 RPC：

```typescript
ipcMain.handle('languageService:completions', (_event, filePath, position) =>
  requireBackend().invoke('languageService/completions', { filePath, position }))
// 其他端点类似...
```

**协议定义**：`CrossPlatform/frontend/src/shared/protocol.ts`

定义了以下 TypeScript 接口：
- `CompletionItem` - 补全项
- `HoverInfo` - 悬停信息
- `SignatureHelpInfo` - 签名帮助
- `DiagnosticInfo` - 诊断信息
- 对应的 Request/Response 类型

**Preload 脚本**：`CrossPlatform/frontend/src/preload/index.ts`

暴露以下 DnSpyApi 方法：
- `updateDocument(filePath, content)`
- `getCompletions(filePath, position)`
- `getHover(filePath, position)`
- `getSignatureHelp(filePath, position)`
- `getDiagnostics(filePath)`

## 功能对比

| 功能 | WPF | 跨平台版 | 差异 |
|------|-----|---------|------|
| 补全 | ✅ | ✅ | 完全对齐 |
| 悬停提示 | ✅ | ✅ | 完全对齐 |
| 签名帮助 | ✅ | ✅ | 完全对齐 |
| 诊断 | ✅ | ✅ | 完全对齐 |
| 快速修复 | ✅ | 🟡 | 预留架构，待补全 |
| 语义着色 | ✅ | 🟡 | 当前用词法着色，语义着色需要 Monaco 的语义 token provider |

## 测试覆盖

**单元测试**：`CrossPlatform/frontend/src/renderer/src/roslyn-language-service.test.ts`

- 验证 CompletionItemProvider 注册
- 验证 HoverProvider 注册
- 验证 SignatureHelpProvider 注册

## 依赖

后端新增 NuGet 包：
- `Microsoft.CodeAnalysis.CSharp.Workspaces` 4.14.0
- `Microsoft.CodeAnalysis.Workspaces.Common` 4.14.0

这些包支持在服务端构建 Roslyn 工作区和编译上下文。

## 使用方式

当用户在 C# 代码编辑器中编辑代码时：

1. 编辑器内容变化触发 `updateDocument` RPC，将代码发送到后端
2. 用户触发补全 (Ctrl+Space) / 悬停 / 签名帮助时，相应的提供者被调用
3. 前端通过 RPC 调用后端获取结果
4. Monaco 编辑器使用返回的数据显示补全列表、悬停信息等

## 限制与后续改进

1. **语义着色**：当前仍使用词法着色。Monaco 的 `DocumentSemanticTokensProvider` 可用于完整的语义着色，需要后端生成 SemanticTokens。

2. **快速修复**：诊断功能已实现，CodeActionProvider 已注册，但快速修复建议需要进一步实现。

3. **编辑器选项**：当前配置硬编码在提供者中。后续可以根据 Options 页面的设置动态调整，如补全触发字符、签名帮助样式等。

4. **缓存**：可以为频繁编辑的文档添加编译缓存，提高性能。

## 后续工作

优先级顺序：

1. **P0**：集成到「编辑方法 (C#)」编辑器
   - Compiler 子模块移植完成后，Roslyn 语言服务需要在方法编辑器中使用
   
2. **P1**：增强语义着色
   - 实现 DocumentSemanticTokensProvider
   - 利用 Roslyn 的语义分析进行高级着色
   
3. **P2**：快速修复与代码建议
   - 基于诊断结果提供代码修复建议
   - 支持常见的 C# 代码模式修复
   
4. **P3**：性能优化
   - 添加文档编译缓存
   - 优化 Roslyn 工作区的内存占用

## 相关文件清单

### 后端
- `/CrossPlatform/backend/dnSpy.Backend.Core/LanguageService/RoslynLanguageService.cs` - Roslyn 服务核心
- `/CrossPlatform/backend/dnSpy.Backend.Core/WorkspaceManager.LanguageService.cs` - RPC 端点
- `/CrossPlatform/backend/dnSpy.Backend.Core/dnSpy.Backend.Core.csproj` - 包引用更新

### 前端
- `/CrossPlatform/frontend/src/renderer/src/roslyn-language-service.ts` - 语言服务提供者
- `/CrossPlatform/frontend/src/renderer/src/roslyn-language-service.test.ts` - 单元测试
- `/CrossPlatform/frontend/src/renderer/src/monaco.ts` - 语言服务注册
- `/CrossPlatform/frontend/src/main/index.ts` - IPC 处理器
- `/CrossPlatform/frontend/src/preload/index.ts` - API 暴露
- `/CrossPlatform/frontend/src/shared/protocol.ts` - 协议定义

### 文档
- `/docs/cross-platform-port-status.md` - 移植进度更新
