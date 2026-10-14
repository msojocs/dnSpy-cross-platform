# Third-Party Notices

dnSpy is distributed under GPL-3.0-only. The Linux desktop package also includes or bundles the following major components. This notice is a convenient index; `dnSpy.cdx.json` contains the complete package inventory and exact versions.

| Component | License | Project |
| --- | --- | --- |
| Electron | MIT; bundled Chromium has additional notices | https://www.electronjs.org/ |
| React and React DOM | MIT | https://react.dev/ |
| FlexLayout React | MIT | https://github.com/caplin/FlexLayout |
| Monaco Editor | MIT | https://github.com/microsoft/monaco-editor |
| Lucide | ISC | https://lucide.dev/ |
| dnSpy image set (`dnSpy/dnSpy.Images`, from the Visual Studio Image Library) | Visual Studio Image Library license | https://www.microsoft.com/en-us/download/details.aspx?id=35825 |
| Zustand | MIT | https://github.com/pmndrs/zustand |
| dnlib | MIT | https://github.com/0xd4d/dnlib |
| ILSpy decompiler and BAML decompiler | MIT | https://github.com/icsharpcode/ILSpy |
| ICSharpCode CodeConverter | MIT | https://github.com/icsharpcode/CodeConverter |
| .NET runtime | MIT | https://github.com/dotnet/runtime |
| Roslyn | MIT | https://github.com/dotnet/roslyn |
| ICorDebugSharp | MIT | https://github.com/msojocs/ICorDebugSharp |
| Microsoft.Diagnostics.DbgShim (`libdbgshim.so`) | MIT | https://github.com/dotnet/diagnostics |

The package includes Electron's `LICENSE.electron.txt` and `LICENSES.chromium.html` alongside the application. Debugging runs in-process against the CLR's own `libdbgshim.so` / `libmscordbi.so`, which ship with the .NET runtime and the DbgShim package; no separate debugger executable is bundled.
