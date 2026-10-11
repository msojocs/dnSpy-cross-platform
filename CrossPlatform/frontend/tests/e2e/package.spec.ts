import { test, expect, chromium, type Browser, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { access } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

// These tests drive an installed application rather than the source tree, which is the only way to
// catch a package that is missing something the shell needs at runtime: a backend that was never
// published into it, or a debug engine whose native shim did not come along. Each packaging job in
// .github/workflows/cross-platform.yml points DNSPY_PACKAGED_EXECUTABLE at its own unpacked build.
const executable = process.env.DNSPY_PACKAGED_EXECUTABLE
const contractsAssemblyPath = path.resolve(import.meta.dirname, '../../../backend/dnSpy.Backend.Contracts/bin/Debug/net10.0/dnSpy.Backend.Contracts.dll')
const debugTargetPath = path.resolve(import.meta.dirname, '../../../backend/tests/DebugTarget/bin/Debug/net10.0/DebugTarget.dll')

// A package holds one backend, published under the name of the platform the package targets rather
// than the one running the test — the same convention the main process resolves at startup, so these
// names are what a mismatch between packaging and the shell would look like from the outside.
const backendDirectoryName = `${process.platform}-${process.arch}`
const backendExecutableName = process.platform === 'win32' ? 'dnSpy.Backend.Host.exe' : 'dnSpy.Backend.Host'
const dbgShimFileName = process.platform === 'win32'
  ? 'dbgshim.dll'
  : process.platform === 'darwin'
    ? 'libdbgshim.dylib'
    : 'libdbgshim.so'

// The packaged app puts its resources beside the executable, except on macOS where they live inside
// the bundle — the executable there is Contents/MacOS/dnSpy and the resources Contents/Resources.
const resourcesDirectory = process.platform === 'darwin'
  ? path.resolve(path.dirname(executable ?? ''), '..', 'Resources')
  : path.join(path.dirname(executable ?? ''), 'resources')

interface PackagedApplication {
  browser: Browser
  page: Page
  process: ChildProcess
  processId?: number
  userDataDirectory: string
}

const launchPackagedApplication = async (assemblyPath: string): Promise<PackagedApplication> => {
  const port = await getFreePort()
  const userDataDirectory = mkdtempSync(path.join(os.tmpdir(), 'dnspy-packaged-e2e-'))
  const application = spawn(executable!, [
    '--no-sandbox',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDirectory}`,
    '--open',
    assemblyPath,
  ], {
    env: {
      ...process.env,
      // Clear the Wayland variables so Electron selects X11, the same thing the CI job does for the
      // whole end-to-end run. Under a Wayland session the packaged application's window is never
      // composited, so the renderer stops producing animation frames after its first paint and every
      // Playwright action that waits for an element to settle hangs rather than fails. The application
      // itself is fine — it renders normally on X11, which is what a packaged app is normally started
      // under — this only keeps the test from depending on the desktop session it happens to run in.
      ...(process.platform === 'linux' ? { WAYLAND_DISPLAY: '', XDG_SESSION_TYPE: 'x11' } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  const browser = await connectToApplication(port)
  const context = browser.contexts()[0]
  const page = context.pages()[0] ?? await context.waitForEvent('page')
  const processId = await page.evaluate(() => window.dnSpy.getProcessId())
  await expect(page.getByText('Ready', { exact: true })).toBeVisible()
  return { browser, page, process: application, processId, userDataDirectory }
}

/**
 * How long one of these tests gets. A packaged application is a real installation rather than a source
 * tree, so its first launch pays for Electron reading its archive off the disk and for the bundled .NET
 * backend JITing for the first time — the readiness check alone is allowed 30 s of that (the expect
 * timeout in the playwright config), and what is left has to cover the navigation the test does and
 * taking the application down again.
 */
const packagedTestTimeoutMs = 60_000

const closePackagedApplication = async (application: PackagedApplication | undefined): Promise<void> => {
  if (!application)
    return
  // The application is stopped before the connection is dropped, not after. `browser.close()` on a
  // connection made with `connectOverCDP` does not ask the application to quit: it closes the debugging
  // socket and waits for the other end to finish the WebSocket closing handshake, which a peer that is
  // slow to answer can leave it waiting out for the socket's close timeout, 30 s, with the application
  // still running. Killing the process group first collapses that socket, so the disconnect usually
  // returns at once — and where the operating system does not hand that collapse to the socket, the
  // disconnect is bounded rather than waited on, because the application is gone by then either way. The
  // group is signalled before the pid because `stopProcess` does nothing once the main process has
  // exited, and it is the group signal that takes the renderers and the backend down with it.
  await stopProcess(application.process)
  await stopProcessId(application.processId)
  await disconnect(application.browser)
  // The children of a detached Electron process are not all reaped the moment the main one exits, and
  // on Windows a renderer still holding the profile makes this throw rather than wait. Retrying lets
  // the profile go rather than failing a test that already passed.
  rmSync(application.userDataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

test('packaged application starts its bundled backend and discovers the debugger', async () => {
  test.skip(!executable, 'DNSPY_PACKAGED_EXECUTABLE is not set.')
  test.setTimeout(packagedTestTimeoutMs)
  let application: PackagedApplication | undefined
  try {
    application = await launchPackagedApplication(contractsAssemblyPath)
    const { page } = application
    await expect(page.getByRole('toolbar', { name: 'Main toolbar' }).getByRole('button', { name: 'Debug a Program' })).toBeEnabled()
    // An AppImage is a single file that unpacks itself elsewhere, so the resources are not laid out
    // beside it and only the unpacked builds can be inspected this way.
    if (!executable!.endsWith('.AppImage')) {
      await access(path.join(resourcesDirectory, 'backend', backendDirectoryName, backendExecutableName))
      await access(path.join(resourcesDirectory, 'backend', backendDirectoryName, dbgShimFileName))
    }
    await expect(page.getByRole('treeitem').first()).toContainText('dnSpy.Backend.Contracts')
    // The assembly opens as one collapsed root over its module, and the namespaces hang off the module.
    for (const kind of ['assembly', 'module']) {
      const row = page.locator(`.tree-row[data-kind="${kind}"]`).first()
      await expect(row).toBeVisible()
      if ((await row.getAttribute('aria-expanded')) === 'false')
        await row.locator('.tree-expander').click({ force: true })
    }
    const namespaceRow = page.locator('.tree-row[data-kind="namespace"]').filter({ hasText: /^dnSpy\.Backend\.Contracts$/ })
    await expect(namespaceRow).toBeVisible()
    await namespaceRow.locator('.tree-expander').click({ force: true })
    await expect(namespaceRow).toHaveAttribute('aria-expanded', 'true')
    const helloRequest = page.locator('.tree-row[data-kind="type"]').filter({ hasText: /^HelloRequest @02000005$/ })
    await expect(helloRequest).toBeVisible()
    await helloRequest.dblclick({ force: true })
    await expect(page.locator('.monaco-editor')).toBeVisible()
  } finally {
    await closePackagedApplication(application)
  }
})

test('packaged application debugs a program it launches', async () => {
  test.skip(!executable, 'DNSPY_PACKAGED_EXECUTABLE is not set.')
  test.setTimeout(packagedTestTimeoutMs)
  let application: PackagedApplication | undefined
  try {
    application = await launchPackagedApplication(debugTargetPath)
    const { page } = application
    const toolbar = page.getByRole('toolbar', { name: 'Main toolbar' })

    // Breakpoints belong to the decompiled workspace rather than to a source file, so the debuggee has
    // to be open in the explorer before one can be set. A function breakpoint is the shortest route in:
    // it needs no editor line, and it binds through the same workspace the line form does.
    await expect(page.getByRole('treeitem').first()).toContainText('DebugTarget')
    await showBreakpoints(page)
    await page.getByRole('textbox', { name: 'Function breakpoint', exact: true }).fill('DebugTarget.Program.Calculate')
    await page.getByRole('button', { name: 'Add function breakpoint' }).click()

    // "Debug a Program" opens the dialog with the executable prefilled from the open module, so
    // confirming it is the whole launch. This is the assertion the other packaged tests cannot make:
    // it requires the bundled DbgShim to load and ICorDebug to hand back a stopped process, which is
    // what "debugging works in this package" actually means.
    await toolbar.getByRole('button', { name: 'Debug a Program' }).click()
    await page.getByRole('dialog', { name: 'Debug Program' }).getByRole('button', { name: 'OK' }).click()
    await expect(page.getByText('Stopped: breakpoint', { exact: true })).toBeVisible()
    // Selecting the tab is what reveals the pane's rows: the tool window is in the default layout but
    // Locals is the tab in front.
    await page.getByRole('tab', { name: 'Call Stack' }).click()
    await expect(page.locator('.result-list[aria-label="Call Stack"] .stack-row').first())
      .toContainText('DebugTarget.dll!DebugTarget.Program.Calculate(int left, int right)')

    await toolbar.getByRole('button', { name: 'Stop' }).click()
    await expect(toolbar.getByRole('button', { name: 'Debug a Program' })).toBeEnabled()
  } finally {
    await closePackagedApplication(application)
  }
})

/** Opens the Breakpoints tool window from the Window submenu, the way the source-tree tests do. */
const showBreakpoints = async (page: Page): Promise<void> => {
  await page.getByRole('menuitem', { name: 'Debug', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Window', exact: true }).hover()
  const breakpointsMenuItem = page.getByRole('menuitem', { name: /^Breakpoints/ })
  if ((await breakpointsMenuItem.getAttribute('aria-checked')) === 'true') {
    await page.keyboard.press('Escape')
    return
  }
  await breakpointsMenuItem.click()
}

const getFreePort = async (): Promise<number> => await new Promise((resolve, reject) => {
  const server = net.createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      reject(new Error('Could not allocate a debugging port.'))
      return
    }
    server.close((error) => error ? reject(error) : resolve(address.port))
  })
})

const connectToApplication = async (port: number): Promise<Browser> => {
  const deadline = Date.now() + 15_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw lastError instanceof Error ? lastError : new Error('The packaged application did not expose its renderer debugging endpoint.')
}

/**
 * How long the disconnect below may take. The application has already been killed when it runs, so this
 * is housekeeping rather than shutdown, and the budget belongs to the test rather than to the socket.
 */
const disconnectTimeoutMs = 5_000

/**
 * Drops the connection to the application without letting the answer decide the test. Closing a
 * connection made with `connectOverCDP` is a request to the other end rather than a shutdown of it, and
 * a peer that has just been killed leaves the socket to the operating system: the closing handshake is
 * then answered promptly on one platform, late or not at all on another, and the call itself rejects
 * once the connection is already gone. All of those are the teardown of a process that is no longer
 * there, none of them says anything about the application the test just exercised, and waiting one of
 * them out or letting the rejection out of `closePackagedApplication` would fail a test whose
 * assertions have already passed.
 */
const disconnect = async (browser: Browser): Promise<void> => {
  const closed = browser.close().catch(() => {})
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, disconnectTimeoutMs))])
}

const stopProcessId = async (processId: number | undefined): Promise<void> => {
  if (!processId) return
  try { process.kill(processId, 'SIGTERM') } catch { return }
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    try { process.kill(processId, 0) } catch { return }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  try { process.kill(processId, 'SIGKILL') } catch { /* already exited */ }
}

const stopProcess = async (application: ChildProcess | undefined): Promise<void> => {
  if (!application || application.exitCode !== null)
    return
  const exited = new Promise<void>((resolve) => application.once('exit', () => resolve()))
  signalProcessGroup(application, 'SIGTERM')
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))])
  if (application.exitCode === null) {
    signalProcessGroup(application, 'SIGKILL')
    await exited
  }
}

const signalProcessGroup = (application: ChildProcess, signal: NodeJS.Signals): void => {
  try {
    // A negative pid signals the whole group, which is what takes the renderers and the backend down
    // with the main process. Windows has no process groups to signal, so there it throws and the
    // single-process kill below is all that is available.
    if (application.pid) process.kill(-application.pid, signal)
    else application.kill(signal)
  } catch {
    application.kill(signal)
  }
}
