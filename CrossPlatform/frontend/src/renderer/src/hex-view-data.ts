import { useCallback, useEffect, useRef, useState } from 'react'

/** The chunk the view reads at a time, under the backend's 1 MiB read limit and aligned with it. */
export const CHUNK_SIZE = 64 * 1024
/** A source answers per 4 KiB page whether it could be read: dnSpy's `??` cells. */
export const PAGE_SIZE = 4096

/** What the view reads its bytes through: a module's file over RPC, or a source's own reader. */
export type HexChunkReader = (offset: number, count: number) => Promise<{ bytes: Uint8Array; readable?: boolean[] }>

/** A byte the cache knows: 0..255, -1 for a byte that cannot be read, -2 for one not read yet. */
export const NOT_LOADED = -2

/**
 * The bytes the hex view draws, read a chunk at a time as rows come into view. A new `revision` — an edit, an
 * undo, a source's new stop — marks every chunk stale: it is read again, but drawn as it was until the new
 * bytes are in, so an edit does not make the dump flicker.
 */
export function useHexChunks(reader: HexChunkReader | undefined, length: number, revision: string): {
  readByte(position: number): number
  ensure(start: number, end: number): void
  invalidate(start?: number, end?: number): void
  version: number
} {
  const chunks = useRef(new Map<number, { bytes: Uint8Array; unreadable?: boolean[]; failed?: boolean; stale: boolean }>())
  const pending = useRef(new Set<number>())
  const [version, setVersion] = useState(0)
  const readerRef = useRef(reader)
  readerRef.current = reader

  useEffect(() => {
    for (const chunk of chunks.current.values())
      chunk.stale = true
    pending.current.clear()
    setVersion((value) => value + 1)
  }, [revision])

  // A new reader is other bytes altogether — a source's window that moved — so nothing old is drawn.
  useEffect(() => {
    chunks.current.clear()
    pending.current.clear()
    setVersion((value) => value + 1)
  }, [reader])

  const ensure = useCallback((start: number, end: number): void => {
    const read = readerRef.current
    if (!read || length <= 0)
      return
    const first = Math.max(0, Math.floor(start / CHUNK_SIZE))
    const last = Math.min(Math.floor((length - 1) / CHUNK_SIZE), Math.floor((Math.max(start + 1, end) - 1) / CHUNK_SIZE))
    for (let index = first; index <= last; index++) {
      const known = chunks.current.get(index)
      if ((known && !known.stale) || pending.current.has(index))
        continue
      pending.current.add(index)
      const offset = index * CHUNK_SIZE
      void read(offset, Math.min(CHUNK_SIZE, length - offset)).then((response) => {
        if (readerRef.current !== read)
          return
        pending.current.delete(index)
        chunks.current.set(index, { bytes: response.bytes, unreadable: response.readable?.map((readable) => !readable), stale: false })
        setVersion((value) => value + 1)
      }, () => {
        pending.current.delete(index)
        // A chunk that cannot be read is drawn as dnSpy's unreadable cells.
        chunks.current.set(index, { bytes: new Uint8Array(0), failed: true, stale: false })
        setVersion((value) => value + 1)
      })
    }
  }, [length])

  const readByte = useCallback((position: number): number => {
    if (position < 0 || position >= length)
      return -1
    const chunk = chunks.current.get(Math.floor(position / CHUNK_SIZE))
    if (!chunk)
      return NOT_LOADED
    const index = position % CHUNK_SIZE
    if (chunk.failed || chunk.unreadable?.[Math.floor(index / PAGE_SIZE)] === true)
      return -1
    return index < chunk.bytes.length ? chunk.bytes[index] : -1
    // `version` makes a caller that reads through this re-render when a chunk arrives.
  }, [length, version]) // eslint-disable-line react-hooks/exhaustive-deps

  const invalidate = useCallback((start?: number, end?: number): void => {
    for (const [index, chunk] of chunks.current) {
      const chunkStart = index * CHUNK_SIZE
      if (start === undefined || end === undefined || (chunkStart < end && chunkStart + CHUNK_SIZE > start))
        chunk.stale = true
    }
    pending.current.clear()
    setVersion((value) => value + 1)
  }, [])

  return { readByte, ensure, invalidate, version }
}
