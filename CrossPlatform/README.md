# dnSpy Cross-Platform

This directory contains the Electron/React client and the UI-independent .NET backend used by the Linux build.

The existing WPF application remains in the repository while functionality is migrated behind the versioned RPC protocol.

## Prerequisites

- .NET SDK 10.0 (the newest 10.0.x installed is used)
- Node.js 22 LTS
- pnpm 12.3.4

## Backend

```bash
dotnet build dnSpy.CrossPlatform.slnx
dotnet test dnSpy.CrossPlatform.slnx
```

The solution also builds `dnSpy.Console`, the command-line decompiler the WPF build ships as
`dnSpy.Console.exe`. It exports projects (`-o`), writes a single type or member to stdout
(`-t`, `--md`), and takes the same switches and decompiler languages (C#, Visual Basic, IL,
IL with C#) as its Windows counterpart:

```bash
dotnet run --project backend/dnSpy.Console -- --sdk-project -o /tmp/out /path/to/assembly.dll
dotnet run --project backend/dnSpy.Console -- -t System.Int32 /path/to/assembly.dll
```

## Desktop application

The debug engine runs inside the backend and loads the CLR's `libdbgshim.so`, which the build brings in
with the rest of the native assets — there is no separate debugger to install.

C# documents and the interactive editor use Shiki's TextMate grammar through `@shikijs/monaco`.
The C# grammar, three editor themes and Oniguruma WASM are bundled locally for offline highlighting;
initialization is shared across editors, with Monaco's built-in highlighting as a fallback.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Create AppImage and deb packages with:

```bash
pnpm package:linux
```

See [the Linux user guide](../docs/linux-user-guide.md) for supported workflows, installation and debugger permissions.
