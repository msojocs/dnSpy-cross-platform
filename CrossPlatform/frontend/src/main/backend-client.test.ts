import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/app', getVersion: () => '0.0.0' } }))

const { BackendClient } = await import('./backend-client')

/** What the client writes to the host's stdin, read back as the JSON-RPC messages it framed. */
interface FakeHost {
  exitCode: number | null
  stdin: { write(buffer: Buffer, callback?: (error?: Error) => void): boolean }
}

const frame = (message: unknown): Buffer => {
  const payload = Buffer.from(JSON.stringify(message), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'ascii'), payload])
}

const parseFrames = (buffers: Buffer[]): Array<{ id?: number; method?: string; params?: unknown }> =>
  buffers.map((buffer) => JSON.parse(buffer.toString('utf8').split('\r\n\r\n')[1]))

/**
 * A client wired to a host that is only a pipe: the client's writes are kept, and what the host answers is
 * fed to the client the way its stdout would.
 */
const connect = (): { client: InstanceType<typeof BackendClient>; written: Buffer[]; notifications: Array<[string, unknown]>; reply(message: unknown): void } => {
  const written: Buffer[] = []
  const notifications: Array<[string, unknown]> = []
  const client = new BackendClient(() => undefined, (method, params) => notifications.push([method, params]))
  const host: FakeHost = {
    exitCode: null,
    stdin: {
      write: (buffer, callback) => {
        written.push(buffer)
        callback?.()
        return true
      },
    },
  }
  const internals = client as unknown as { process: FakeHost; handleStdout(chunk: Buffer): void }
  internals.process = host
  return { client, written, notifications, reply: (message) => internals.handleStdout(frame(message)) }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('BackendClient', () => {
  it('gives up on a request whose signal is aborted, and tells the host to cancel it', async () => {
    const { client, written } = connect()
    const controller = new AbortController()

    const pending = client.invoke('analyze/children', { nodeId: 'n1' }, 60_000, controller.signal)
    controller.abort()

    await expect(pending).rejects.toThrow('analyze/children was canceled.')
    const [request, cancel] = parseFrames(written)
    expect(request).toMatchObject({ method: 'analyze/children', params: { nodeId: 'n1' } })
    expect(cancel).toEqual({ jsonrpc: '2.0', method: 'system/cancel', params: { id: request.id } })
  })

  it('never sends a request that was called off before it went out', async () => {
    const { client, written } = connect()
    const controller = new AbortController()
    controller.abort()

    await expect(client.invoke('analyze/children', {}, 60_000, controller.signal)).rejects.toThrow('was canceled')
    expect(written).toHaveLength(0)
  })

  it('keeps an answer that came first, and sends no cancel for an abort after it', async () => {
    const { client, written, reply } = connect()
    const controller = new AbortController()

    const pending = client.invoke('analyze/children', {}, 60_000, controller.signal)
    const [request] = parseFrames(written)
    reply({ jsonrpc: '2.0', id: request.id, result: { children: [], truncated: false } })
    await expect(pending).resolves.toEqual({ children: [], truncated: false })

    controller.abort()
    expect(parseFrames(written).map((message) => message.method)).toEqual(['analyze/children'])
  })

  it('drops an answer that comes after the request was called off', async () => {
    const { client, written, reply } = connect()
    const controller = new AbortController()
    const pending = client.invoke('analyze/children', {}, 60_000, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow('was canceled')

    // The host may well have finished before it read the cancel; its answer has no one left to take it.
    reply({ jsonrpc: '2.0', id: parseFrames(written)[0].id, result: { children: [], truncated: false } })
    const next = client.invoke('tree/getRoots', {})
    const [, , rootsRequest] = parseFrames(written)
    reply({ jsonrpc: '2.0', id: rootsRequest.id, result: { nodes: [] } })
    await expect(next).resolves.toEqual({ nodes: [] })
  })

  it('tells the host to cancel a request that timed out', async () => {
    vi.useFakeTimers()
    const { client, written } = connect()

    const pending = client.invoke('document/decompile', {}, 1_000)
    const rejected = expect(pending).rejects.toThrow('document/decompile timed out.')
    await vi.advanceTimersByTimeAsync(1_000)
    await rejected

    const [request, cancel] = parseFrames(written)
    expect(cancel).toEqual({ jsonrpc: '2.0', method: 'system/cancel', params: { id: request.id } })
  })

  it('hands a notification to its listener, whatever request is pending', async () => {
    const { client, notifications, reply } = connect()
    void client.invoke('analyze/children', {}).catch(() => undefined)

    reply({ jsonrpc: '2.0', method: 'analyze/progress', params: { progressToken: '1:r1', start: 0, children: [] } })

    expect(notifications).toEqual([['analyze/progress', { progressToken: '1:r1', start: 0, children: [] }]])
  })
})
