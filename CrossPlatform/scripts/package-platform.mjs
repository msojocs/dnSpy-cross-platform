// Packages the Electron app for one platform. Written as a Node script rather than a shell script so
// the three CI runners (bash on Linux and macOS, PowerShell on Windows) all invoke the same code path,
// and so the platform table below is the single place where a platform's three different names live.
//
// Usage: node scripts/package-platform.mjs <linux|win|mac>
//
// See docs/release-process.md for what each platform's package contains and how a release is cut.
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const rootDirectory = resolve(scriptDirectory, '..')

/**
 * The three names each platform goes by, and why they are not the same string:
 * - `runtimeIdentifier` is what the .NET SDK and the DbgShim packages call it (osx, not darwin).
 * - `backendDirectory` is what the main process looks in, `${process.platform}-${process.arch}` —
 *   see `frontend/src/main/backend-client.ts`. Getting this wrong produces a package that starts and
 *   then reports the backend missing, so the two must stay in step.
 * - the electron-builder flags select the installers each platform ships.
 */
const platforms = {
  linux: {
    runtimeIdentifier: 'linux-x64',
    backendDirectory: 'linux-x64',
    electronBuilder: ['--linux', 'AppImage', 'deb'],
  },
  win: {
    runtimeIdentifier: 'win-x64',
    backendDirectory: 'win32-x64',
    electronBuilder: ['--win', 'nsis', 'zip'],
  },
  mac: {
    runtimeIdentifier: 'osx-arm64',
    backendDirectory: 'darwin-arm64',
    electronBuilder: ['--mac', 'dmg', 'zip'],
  },
}

const requestedPlatform = process.argv[2]
const platform = platforms[requestedPlatform]
if (!platform) {
  console.error(`Unknown platform '${requestedPlatform ?? ''}'. Expected one of: ${Object.keys(platforms).join(', ')}.`)
  process.exit(1)
}

// Set DNSPY_VERSION to stamp a released version into the artifacts (see docs/release-process.md);
// without it the version in frontend/package.json is used, which is what branch builds want. CI passes
// the tag name — `v1.2.3` — because that is what a workflow has to hand, so the `v` comes off here
// rather than in the workflows, where there is no expression that can strip it.
const version = (process.env.DNSPY_VERSION ?? '').replace(/^v/, '')
if (version && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`DNSPY_VERSION '${process.env.DNSPY_VERSION}' is not a version electron-builder can use.`)
  process.exit(1)
}

const backendOutput = resolve(rootDirectory, 'artifacts/publish/backend', platform.backendDirectory)

const run = (command, args) => {
  console.log(`> ${command} ${args.join(' ')}`)
  // pnpm is a .cmd shim on Windows, which CreateProcess cannot launch directly; `shell` is what
  // resolves it there. Every argument is a literal in this file, so nothing needs quoting.
  execFileSync(command, args, { cwd: rootDirectory, stdio: 'inherit', shell: process.platform === 'win32' })
}

/**
 * macOS refuses to launch unsigned arm64 binaries at all, and this applies to the native files the
 * backend ships inside the bundle as much as to the bundle itself: the .NET apphost arrives ad-hoc
 * signed, but the DbgShim dylib the debug engine dlopen's does not. Signing both here, before
 * electron-builder seals the bundle around them, is what keeps debugging usable in the package.
 * electron-builder's own `identity: "-"` covers the app itself — see packaging/electron-builder.yml.
 */
const signNativeBackend = () => {
  // A RID-specific self-contained publish flattens the native assets to the output root, which is
  // where the locator looks for them too; the `runtimes/` copy is kept as a fallback in case a future
  // SDK stops doing that.
  const nativeFiles = [
    resolve(backendOutput, 'dnSpy.Backend.Host'),
    resolve(backendOutput, 'dnSpy.Console'),
    resolve(backendOutput, 'libdbgshim.dylib'),
    resolve(backendOutput, 'runtimes', platform.runtimeIdentifier, 'native', 'libdbgshim.dylib'),
  ]
  for (const file of nativeFiles) {
    if (!existsSync(file)) {
      console.warn(`warning: ${file} is not in the publish output; leaving it unsigned.`)
      continue
    }
    run('codesign', ['--force', '--sign', '-', '--timestamp=none', file])
  }
}

run('node', [resolve(scriptDirectory, 'generate-icons.mjs')])
run('pnpm', ['--dir', 'frontend', 'build'])

// A stale backend from an earlier platform would be silently repackaged, so the publish tree is
// rebuilt from nothing every time.
rmSync(resolve(rootDirectory, 'artifacts/publish'), { recursive: true, force: true })
const publishArgs = (project) => [
  'publish',
  project,
  '--configuration', 'Release',
  '--runtime', platform.runtimeIdentifier,
  '--self-contained', 'true',
  '-p:PublishSingleFile=false',
  '-p:UseSharedCompilation=false',
  // Restore's vulnerability audit reaches out to nuget.org, and Directory.Build.props turns warnings
  // into errors, so an unreachable or slow audit endpoint would fail packaging outright. The CI job
  // runs the audit deliberately (`dotnet list package --vulnerable`) where it can be seen and acted on;
  // it has no business deciding whether a build produces artifacts.
  '-p:NuGetAudit=false',
  '--output', `artifacts/publish/backend/${platform.backendDirectory}`,
]
run('dotnet', publishArgs('backend/dnSpy.Backend.Host/dnSpy.Backend.Host.csproj'))
// dnSpy.Console goes into the same directory as the host, the way the WPF build ships it beside
// dnSpy.exe. Both are self-contained apps on the same runtime, so the second publish only adds the
// console's own files — the runtime assemblies the two share are written once.
run('dotnet', publishArgs('backend/dnSpy.Console/dnSpy.Console.csproj'))

if (requestedPlatform === 'mac')
  signNativeBackend()

run('node', [resolve(scriptDirectory, 'generate-sbom.mjs'), platform.backendDirectory, version])

run('pnpm', ['--dir', 'frontend', 'exec', 'electron-builder', '--config', '../packaging/electron-builder.yml', ...platform.electronBuilder, ...(version ? [`-c.extraMetadata.version=${version}`] : [])])
