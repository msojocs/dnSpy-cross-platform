# dnSpy Linux 使用指南

## 支持范围

Linux 版使用 Electron/React 前端和独立的 .NET 10 后端，无需 Wine，也无需预装 .NET SDK。当前支持：

- 打开单个或多个 `.dll`、`.exe`、`.netmodule`、`.winmd` 文件。
- 展开程序集、命名空间、类型、成员、引用、资源和 `.resources` 条目。
- 反编译 C#、Visual Basic、带语法高亮的 IL、带 C# 源语句的 IL，以及把 BAML 恢复为 XAML。
- 名称/字符串搜索、引用分析、模块信息和分页十六进制查看。
- 类型及成员重命名、结构化 IL 方法体编辑、嵌入资源替换和原子另存。
- 启动或附加 Linux .NET/CoreCLR 进程，设置行断点（反编译源码上直接点击边栏，无需 PDB）和方法断点，并使用继续、暂停、单步、线程、调用栈、局部变量和模块窗口。

调试引擎在后端进程内直接使用 CLR 的 `ICorDebug`（`libdbgshim.so` 随安装包分发，运行时不会联网下载）。当前**不支持**异常断点和表达式求值/监视：异常过滤器在界面上不可用，监视窗口的输入框会置灰。已知边界：`async` 方法里的单步不做表达式求值来判定 continuation，因此分支、循环或异常路径上的 `await` 可能多停一次。

Linux 不提供 Windows CorDebug、.NET Framework 运行时调试、Windows 专属反调试绕过或 WPF 设计预览。WPF 程序集仍可查看、反编译和编辑；BAML 可以恢复为 XAML。

## 安装

### Debian/Ubuntu

```bash
sudo apt install ./dnSpy-1.0.0-amd64.deb
dnspy
```

可以从命令行直接打开程序集（和 WPF 版一样，文件路径直接跟在命令后面；`--open` 也仍然可用），并用 `--select` 定位到其中的成员——元数据 token，或 `T:`、`M:`、`N:` 这类 XML 文档 ID：

```bash
dnspy ./Example.dll
dnspy ./Example.dll --select T:Example.Program
```

deb 安装脚本会根据系统是否允许非特权 user namespace，配置 Electron sandbox helper。卸载应用不会删除用户配置。

### AppImage

```bash
chmod +x dnSpy-1.0.0-x86_64.AppImage
./dnSpy-1.0.0-x86_64.AppImage
```

AppImage 需要系统允许 Chromium user namespace sandbox。在启用了严格 AppArmor 限制且不能创建 user namespace 的 Ubuntu 系统上，使用 deb 包；不要以 `--no-sandbox` 作为日常运行方式。

## 配置和日志

应用遵循 XDG Base Directory：

- 配置：`${XDG_CONFIG_HOME:-$HOME/.config}/dnspy`
- 缓存：`${XDG_CACHE_HOME:-$HOME/.cache}/dnspy`
- Electron 配置：`${XDG_CONFIG_HOME:-$HOME/.config}/dnSpy`

界面语言默认跟随系统语言，也可以从“语言”菜单选择 `English` 或“简体中文”；更改后立即生效。

应用布局、主题和语言选择由 Electron 用户数据目录保存。布局损坏时，可以在应用关闭后删除对应 Electron 配置目录中的 Local Storage；下次启动会恢复默认布局和系统语言设置。

## 常用快捷键

| 快捷键 | 命令 |
| --- | --- |
| `Ctrl+O` | 打开程序集 |
| `Ctrl+F` | 打开搜索窗口 |
| `Ctrl+Shift+S` | 另存当前模块 |
| `F2` | 重命名选中类型或成员 |
| `F5` | 启动调试/继续 |
| `Shift+F5` | 停止调试 |
| `F10` | 单步跳过 |
| `F11` | 单步进入 |

## 打开文件

`Ctrl+O` 可以打开任意文件，处理顺序与 WPF 版本一致：

- 托管程序集正常加载，展开后按命名空间浏览类型和成员。
- 模块下的 `PE` 节点与 WPF 版本的十六进制节点一一对应：展开后是 DOS 头、文件头、可选头、每个节表项，以及托管文件特有的 Cor20 头和元数据存储（存储签名、存储头、每个流）。双击任一节点在标签页里显示该结构的字段。
- 原生 PE 文件（没有 .NET 元数据）以 PE 文档打开，标签页里显示 PE 头、节表和数据目录，不能编辑或保存；它下面同样挂着 `PE` 节点。
- ELF 文件（Linux 上的可执行文件和共享库）以 ELF 文档打开，标签页里显示文件头、程序头和节头表；展开后是一个 `ELF` 节点，下面按 `readelf -h -l -S` 的顺序排列文件头、每个程序头、每个节头，节头带上文件自己的节名。双击任一节点在标签页里显示该结构的字段，同样不能编辑或保存。WPF 版本没有 ELF 读取器，这是 Linux 版新增的部分。
- 既不是托管程序集、也不是合法 PE 或 ELF 的文件（脚本、其他二进制格式）同样会出现在程序集树里，标签页里只有一行文件名的注释。

也就是说，单个文件无法识别不会让整个打开操作失败：多选时其余文件照常打开，无法识别的文件以文件名保留在树中。

## 命令行版 dnSpy.Console

安装包里带有与 WPF 版同名的 `dnSpy.Console`，位于应用资源的 `backend/<平台-架构>/` 目录；从源码构建时也可以用 `dotnet run --project CrossPlatform/backend/dnSpy.Console -- ...` 运行。参数与 WPF 版一致，区别只是路径用 Linux 的写法：

```bash
# 把目录里的 .NET 文件都导出为 SDK 风格工程，并生成 solution.sln
dnSpy.Console --sdk-project -o /tmp/out /some/path

# 递归导出，不写 .sln
dnSpy.Console -r --no-sln -o /tmp/out /some/path

# 单个类型或成员写到标准输出；--md 后是元数据 token（十进制或 0x 十六进制）
dnSpy.Console -t System.Int32 /path/to/assembly.dll
dnSpy.Console --md 0x06000123 /path/to/assembly.dll

# 换语言：C#、Visual Basic、IL、IL with C#，也可以写语言 GUID
dnSpy.Console -l IL -t Some.Namespace.Type assembly.dll

# 显示全部参数和语言选项
dnSpy.Console
```

常用开关：`-o` 输出目录、`-r` 递归、`-l` 语言、`-t`/`--type` 类型、`--md` token、`--asm-path` 程序集搜索路径、`--user-gac` 用户 GAC 目录、`--no-gac`、`--no-stdlib`、`--gac-file`、`--sdk-project`、`--vs`、`--project-guid`、`--sln-name`、`--no-sln`、`--no-resources`、`--no-resx`、`--no-baml`、`--spaces`、`--threads`、`--no-color`。每个语言还接受自己的反编译选项（`--xml-doc`、`--anon-methods`、`--async`、`--tokens` 等），布尔选项可以用 `--no-` 或 `--dont-` 关掉；`dnSpy.Console` 自身会把支持的全部选项列出来。

用 `--md` 或 `-t` 时只能给一个文件。BAML 资源默认会还原为 XAML 页（`Page`/`ApplicationDefinition`），把导出的 WPF 工程直接编译回去；`--no-baml` 则保留原始的 `.baml`。

## Linux 调试权限

启动的子进程通常不需要额外权限。附加到现有进程时，目标必须属于同一用户，并且受到 Yama、容器、SELinux 或 AppArmor 策略约束。

查看当前 Yama 设置：

```bash
cat /proc/sys/kernel/yama/ptrace_scope
```

dnSpy 不会自动运行 `sudo`，也不会修改全局 ptrace 设置。附加失败时，应优先检查目标用户、容器权限和系统安全策略。只在理解安全影响后，由系统管理员调整策略。

## 从源码构建

需要 .NET 10 SDK、Node.js 22 和 pnpm 12.3.4：

```bash
cd CrossPlatform
pnpm install --frozen-lockfile
dotnet test dnSpy.CrossPlatform.slnx -m:1 -p:UseSharedCompilation=false
pnpm --dir frontend build
pnpm --dir frontend test:e2e
pnpm package:linux
```

安装包输出到 `CrossPlatform/artifacts/packages/`。调试所需的 `libdbgshim.so` 由 `Microsoft.Diagnostics.DbgShim.linux-x64` NuGet 包提供，随 `dotnet publish` 落到后端目录并被一起打包；应用运行时不会联网下载调试器。Windows 和 macOS 各用自己 RID 的同一个包（`win-x64` / `osx-arm64`），见[发布流程](release-process.md)。
