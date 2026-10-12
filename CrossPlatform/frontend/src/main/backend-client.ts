import { app } from 'electron'
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { BackendStatus, HelloResponse } from '../shared/protocol'
import { protocolVersion } from '../shared/protocol'

interface RpcResponse {
  jsonrpc: '2.0'
  id?: number
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
  method?: string
  params?: unknown
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timeout: NodeJS.Timeout
  /** The shutdown acknowledgement is the only request that must settle while the client is disposing. */
  settleDuringDispose: boolean
}

// A package carries one backend per platform, published under the name `${process.platform}-${process.arch}`
// of the platform it targets — win32-x64, darwin-arm64, linux-x64 — so these three names describe the
// package we are running out of, not the machine we are on. The file names inside follow the target
// platform the same way: a Windows host carries `.exe`, and the debug engine's shim is a DLL there and
// a dylib on macOS.
const backendDirectoryName = `${process.platform}-${process.arch}`
const backendExecutableName = process.platform === 'win32' ? 'dnSpy.Backend.Host.exe' : 'dnSpy.Backend.Host'
const dbgShimFileName = process.platform === 'win32'
  ? 'dbgshim.dll'
  : process.platform === 'darwin'
    ? 'libdbgshim.dylib'
    : 'libdbgshim.so'

export class BackendClient {
  private process?: ChildProcessWithoutNullStreams
  private readBuffer = Buffer.alloc(0)
  private nextRequestId = 0
  private readonly pending = new Map<number, PendingRequest>()
  private readonly nonce = randomBytes(32).toString('hex')
  private disposing = false

  constructor(
    private readonly onStatus: (status: BackendStatus) => void,
    private readonly onNotification: (method: string, params: unknown) => void,
  ) {}

  async start(): Promise<HelloResponse> {
    this.disposing = false
    this.onStatus({ state: 'starting' })
    const command = this.resolveCommand()
    this.process = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: {
        ...process.env,
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
        // The debug engine lives in the backend process and loads the CLR's shim from beside its own
        // binary; in a package that is under resources/backend, not the source tree the backend sees.
        ...(app.isPackaged ? {
          DNSPY_DBGSHIM_PATH: path.join(process.resourcesPath, 'backend', backendDirectoryName, dbgShimFileName),
        } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.process.stdout.on('data', (chunk: Buffer) => this.handleStdout(chunk))
    this.process.stderr.setEncoding('utf8')
    this.process.stderr.on('data', (chunk: string) => console.error(`[backend] ${chunk.trimEnd()}`))
    this.process.on('error', (error) => this.stopWithError(error))
    this.process.on('exit', (code, signal) => {
      if (code !== 0 && code !== null)
        this.stopWithError(new Error(`Backend exited with code ${code}.`))
      else {
        this.rejectPending(new Error(`Backend stopped${signal ? ` (${signal})` : ''}.`))
        this.onStatus({ state: 'stopped' })
      }
      this.process = undefined
    })

    const hello = await this.invoke<HelloResponse>('system/hello', {
      protocolVersion,
      clientVersion: app.getVersion(),
      nonce: this.nonce,
    })
    if (hello.nonce !== this.nonce)
      throw new Error('Backend handshake nonce did not match.')
    this.onStatus({ state: 'ready', capabilities: hello.capabilities })
    return hello
  }

  /**
   * Sends a request and waits for its answer. Aborting `signal` gives up on the answer and tells the host
   * to cancel the work, the same notice a timeout sends — what a request the user walked away from needs.
   */
  invoke<T>(method: string, params: unknown, timeoutMs = 60_000, signal?: AbortSignal): Promise<T> {
    return this.invokeInternal(method, params, timeoutMs, false, signal)
  }

  private invokeInternal<T>(method: string, params: unknown, timeoutMs: number, settleDuringDispose: boolean, signal?: AbortSignal): Promise<T> {
    if (!this.process || this.process.exitCode !== null)
      return Promise.reject(new Error('The backend is not running.'))
    if (signal?.aborted)
      return Promise.reject(new Error(`${method} was canceled.`))
    const id = ++this.nextRequestId
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8')
    const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'ascii')
    return new Promise<T>((resolve, reject) => {
      const abandon = (error: Error): void => {
        clearTimeout(timeout)
        this.pending.delete(id)
        this.sendNotification('system/cancel', { id })
        signal?.removeEventListener('abort', onAbort)
        reject(error)
      }
      const onAbort = (): void => {
        if (this.pending.has(id))
          abandon(new Error(`${method} was canceled.`))
      }
      const timeout = setTimeout(() => abandon(new Error(`${method} timed out.`)), timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(value as T)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
        timeout,
        settleDuringDispose,
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      this.process?.stdin.write(Buffer.concat([header, payload]), (error) => {
        if (error) {
          clearTimeout(timeout)
          this.pending.delete(id)
          reject(error)
        }
      })
    })
  }

  async dispose(): Promise<void> {
    const child = this.process
    if (!child)
      return
    this.disposing = true
    // Requests belong to the renderer that is closing. The shutdown notification cancels them in the
    // host, so keeping their IPC promises alive until those cancellation responses arrive only turns an
    // expected shutdown into "Error occurred in handler" messages from Electron. Abandon them here;
    // their renderer is going away and no result can be used anymore.
    this.abandonPending()
    try {
      await this.invokeDuringDispose('system/shutdown', {}, 1_000)
    } catch {
      // The host may close stdout before the acknowledgement is observed.
    }
    if (child.exitCode === null)
      child.kill('SIGTERM')
    this.process = undefined
  }

  private invokeDuringDispose<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    return this.invokeInternal(method, params, timeoutMs, true)
  }

  private abandonPending(): void {
    for (const [id, request] of this.pending) {
      clearTimeout(request.timeout)
      this.pending.delete(id)
    }
  }

  private sendNotification(method: string, params: unknown): void {
    if (!this.process || this.process.exitCode !== null)
      return
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method, params }), 'utf8')
    this.process.stdin.write(Buffer.concat([
      Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'ascii'),
      payload,
    ]))
  }

  private handleStdout(chunk: Buffer): void {
    this.readBuffer = Buffer.concat([this.readBuffer, chunk])
    while (true) {
      const headerEnd = this.readBuffer.indexOf('\r\n\r\n')
      if (headerEnd < 0)
        return
      const header = this.readBuffer.subarray(0, headerEnd).toString('ascii')
      const match = /^Content-Length:\s*(\d+)\s*$/im.exec(header)
      if (!match) {
        this.stopWithError(new Error('Backend sent an invalid JSON-RPC header.'))
        return
      }
      const contentLength = Number.parseInt(match[1], 10)
      const payloadStart = headerEnd + 4
      if (this.readBuffer.length < payloadStart + contentLength)
        return
      const payload = this.readBuffer.subarray(payloadStart, payloadStart + contentLength)
      this.readBuffer = this.readBuffer.subarray(payloadStart + contentLength)
      try {
        this.handleResponse(JSON.parse(payload.toString('utf8')) as RpcResponse)
      } catch (error) {
        this.stopWithError(error instanceof Error ? error : new Error(String(error)))
        return
      }
    }
  }

  private handleResponse(response: RpcResponse): void {
    if (response.id === undefined) {
      if (response.method)
        this.onNotification(response.method, response.params)
      return
    }
    const request = this.pending.get(response.id)
    if (!request)
      return
    if (this.disposing && !request.settleDuringDispose) {
      clearTimeout(request.timeout)
      this.pending.delete(response.id)
      return
    }
    clearTimeout(request.timeout)
    this.pending.delete(response.id)
    if (response.error)
      request.reject(new Error(response.error.message))
    else
      request.resolve(response.result)
  }

  private resolveCommand(): { executable: string; args: string[]; cwd: string } {
    if (app.isPackaged) {
      const executable = path.join(process.resourcesPath, 'backend', backendDirectoryName, backendExecutableName)
      return {
        executable,
        args: ['--nonce', this.nonce, '--parent-pid', String(process.pid)],
        cwd: path.dirname(executable),
      }
    }
    const backendDll = process.env.DNSPY_BACKEND_PATH ?? path.resolve(
      app.getAppPath(),
      '..',
      'backend',
      'dnSpy.Backend.Host',
      'bin',
      'Debug',
      'net10.0',
      'dnSpy.Backend.Host.dll',
    )
    return {
      executable: 'dotnet',
      args: [backendDll, '--nonce', this.nonce, '--parent-pid', String(process.pid)],
      cwd: path.dirname(backendDll),
    }
  }

  private stopWithError(error: Error): void {
    this.rejectPending(error)
    this.onStatus({ state: 'error', message: error.message })
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout)
      request.reject(error)
    }
    this.pending.clear()
  }
}
