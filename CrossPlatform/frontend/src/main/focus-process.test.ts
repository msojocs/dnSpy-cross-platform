import { describe, expect, it } from 'vitest'
import { focusProcessWindow } from './focus-process'

describe('focusProcessWindow', () => {
  it('does nothing without an X display to ask', async () => {
    expect(await focusProcessWindow(process.pid, { ...process.env, DISPLAY: '' })).toBe(false)
  })

  it('does nothing for a process id that cannot name a process', async () => {
    expect(await focusProcessWindow(0, { ...process.env, DISPLAY: ':0' })).toBe(false)
    expect(await focusProcessWindow(1.5, { ...process.env, DISPLAY: ':0' })).toBe(false)
  })

  it('says it could not when xdotool is not there', async () => {
    expect(await focusProcessWindow(process.pid, { DISPLAY: ':0', PATH: '/nonexistent' })).toBe(false)
  })
})
