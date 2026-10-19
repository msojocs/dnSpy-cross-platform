# 发布流程

dnSpy 的跨平台（Electron）版本由 `.github/workflows/cross-platform.yml` 构建和发布。上游 WPF 那条线（`.github/workflows/build.yml`）不受影响。

## 两种 release

| 触发 | 结果 | 产物 |
| --- | --- | --- |
| 推送到 `linux` 分支 | **预览 release**：固定 tag `cross-platform-preview`，`prerelease`，每次推送覆盖产物 | Windows、Linux、macOS 三平台安装包 |
| 打 `v*` 标签（例如 `v1.0.1`） | **正式 release**：tag 就是版本号 | Windows、Linux、macOS 三平台安装包 |

两种 release 挂的产物是同一批：都是三个平台、都由同一次 workflow 产出，区别只在版本号和稳定性——预览跟着推送走并原地覆盖，正式版本一个 tag 一份、名字带版本号。预览 release 里能下到 Windows 和 macOS 包，是为了让这两个平台的测试者不用等正式发布就能拿到东西试。

### 预览 release 的几个约定

- tag `cross-platform-preview` 每次被强制前移到本次提交，所以 release 页面上的 tag 始终指向产物对应的代码。
- 产物名里的版本号是仓库里的版本（当前 `1.0.0`），**不注入 tag 版本**——名字必须保持稳定，否则每次推送都会新增一组文件而不是替换。
- 三个平台**全部**成功才会发布：`preview` job `needs` 三个构建 job，任一平台失败就没有预览 release。
- 本次不再产出的旧文件会被删除（比如以后换掉安装包格式时）。

### 正式 release 的几个约定

- 三个平台**全部**成功才会发布；任一平台失败就没有 release。
- 产物版本号取自 tag（`v1.0.1` → `1.0.1`），既进文件名也进 `app.getVersion()`。
- release 说明由 GitHub 自动生成（`--generate-notes`）。
- 同一个 workflow 重跑不会因为「release 已存在」而失败：会改成覆盖产物。

打 tag 之后，上游的 `build.yml` 还会因为 `release: released` 跑 4 个 Windows WPF 构建。它们只上传 workflow artifact，不会往这个 release 里加东西。

## 产物清单

| 平台 | 文件 |
| --- | --- |
| Windows x64 | `dnSpy-<版本>-x64-setup.exe`、`dnSpy-<版本>-x64.zip` |
| Linux x64 | `dnSpy-<版本>-x86_64.AppImage`、`dnSpy-<版本>-amd64.deb` |
| macOS arm64 | `dnSpy-<版本>-arm64.dmg`、`dnSpy-<版本>-arm64.zip` |
| 全部 | `SHA256SUMS`（三个平台合并）、`dnSpy-<版本>-<平台>.cdx.json`（各平台一份 SBOM） |

预览 release 挂的是同一份清单，只是 `<版本>` 用仓库里的版本（当前 `1.0.0`）、SBOM 保留各平台 job 暂存时的 `dnSpy-<平台>.cdx.json` 名字——两种 release 的文件名必须逐次稳定，才能原地替换。

## 安装

### Windows

`-setup.exe` 是 NSIS 安装器：默认按用户安装、可以改安装目录。`-x64.zip` 是免安装版，解压后运行 `dnSpy.exe`。

安装包**未签名**，首次运行会触发 SmartScreen 警告；选择「更多信息 → 仍要运行」即可。

### macOS（仅 Apple Silicon）

`.dmg` 打开后把 `dnSpy.app` 拖进「应用程序」；`.zip` 是等价解压版。包只做了 ad-hoc 签名：Apple Silicon 上不做任何签名的 `.app` 根本起不来，所以至少要签这一步，但没有开发者证书的话 Gatekeeper 仍会拦。

首次打开需要绕过 Gatekeeper：右键点 `dnSpy.app` → 打开，或

```bash
xattr -dr com.apple.quarantine /Applications/dnSpy.app
```

### Linux

见 [Linux 使用指南](linux-user-guide.md#安装)。

## 本地打包

三个平台的脚本入口都在 `CrossPlatform/`：

```bash
pnpm package:linux     # 在 Linux 上跑
pnpm package:windows   # 在 Windows 上跑
pnpm package:mac       # 在 macOS（arm64）上跑
```

**每个平台只能在对应系统上打包**：Windows 安装器需要 Windows 或 wine，macOS 的 `dmg` 需要 macOS。产物输出到 `CrossPlatform/artifacts/packages/`，中间产物（后端 publish、SBOM）在 `CrossPlatform/artifacts/` 下。

脚本按顺序做四件事：生成图标 → 构建前端 → `dotnet publish` 后端到 `artifacts/publish/backend/<平台目录名>` → 生成 SBOM → 调 electron-builder。后端发布包含两个可执行文件：`dnSpy.Backend.Host`（GUI 的 RPC 宿主）与 `dnSpy.Console`（命令行反编译器，见 `linux-user-guide.md`），它们发布到同一个目录并共用自包含运行时。

**平台目录名必须等于 `${process.platform}-${process.arch}`**（`linux-x64`、`win32-x64`、`darwin-arm64`），因为主进程就是按这个名字去 `resources/backend/` 下找后端的。映射表在 `scripts/package-platform.mjs` 里，改它的时候连同 `cross-platform` 的 `.NET RID`（`osx-arm64`，不是 `darwin-arm64`）一起看。

### 用 tag 版本打包

不设 `DNSPY_VERSION` 时产物用仓库里的版本号（分支预览就是这样）。要复现正式 release 的产物名：

```bash
DNSPY_VERSION=1.0.1 pnpm package:linux
```

### 图标

`CrossPlatform/packaging/icons/icon.png` 是唯一的应用图标（1024×1024），Windows 的 `.ico` 和 macOS 的 `.icns` 由 electron-builder 从它转出来。**换图标就是替换这个文件**——`scripts/generate-icons.mjs` 只在它不存在时才会从上游 `dnSpy.ico` 的 128×128 位图放大生成一份，存在时不会覆盖。

Linux 桌面图标用的是 `CrossPlatform/packaging/linux/icons/128x128.png`，由同一个脚本从上游位图逐像素生成（尺寸和上游一致，不做放大）。

## 调试在各平台的可用性

| 平台 | 启动式调试 | 附加到现有进程 |
| --- | --- | --- |
| Linux | 可用 | 受 Yama/容器/SELinux 策略约束（见 Linux 使用指南） |
| Windows | 可用 | 可用，需要相同权限级别 |
| macOS | 可用 | **不可用**：附加需要签名 entitlement（或 root），未签名/仅 ad-hoc 签名的包没有 |

macOS 上启动式调试走 `posix_spawn` + 目标自带诊断端口，不受影响。

调试引擎需要 CLR 的 `dbgshim` 原生库（`libdbgshim.so` / `dbgshim.dll` / `libdbgshim.dylib`）。它由 `Microsoft.Diagnostics.DbgShim.<rid>` NuGet 包提供，`dotnet publish` 时按目标 RID 落到后端目录并被打包进去；应用运行时不会联网下载。

## 验证一次发布

预览：推送 `linux` 后，三个构建 job 全绿，`cross-platform-preview` release 的 tag 指向本次提交、产物被替换、说明里的 SHA 正确。

正式：打 `v1.0.1` 后，三个 job 全绿，release 里有 6 个安装包 + 合并的 `SHA256SUMS` + 3 份 SBOM，文件名带 `1.0.1`。

两种 release 的**打包冒烟测试**都会真的启动打出来的应用、设一个方法断点并断言停在断点上。这一步是在 CI 里唯一能证明「这个包里的调试引擎真的能用」的检查，而不只是「文件产出了」。Windows/macOS 上它尤其重要——那是这两条链路唯一的真实验证途径。
