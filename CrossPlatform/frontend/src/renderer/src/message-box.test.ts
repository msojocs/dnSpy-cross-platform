import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadAppOptions, resetAppOptions, saveAppOptions } from './components/app-options'
import { askDeleteAllBreakpointsId, askIgnorableMessage } from './message-box'

const askMessage = vi.fn()

beforeEach(() => {
  askMessage.mockReset()
  resetAppOptions()
  Object.defineProperty(window, 'dnSpy', { configurable: true, value: { ...window.dnSpy, askMessage } })
})

afterEach(() => {
  resetAppOptions()
})

describe('askIgnorableMessage', () => {
  it('puts the question and answers with the button that was chosen', async () => {
    askMessage.mockResolvedValue({ button: 'Yes', dontShowAgain: false })

    expect(await askIgnorableMessage('id-1', 'Delete them?', ['Yes', 'No'])).toBe('Yes')
    expect(askMessage).toHaveBeenCalledWith('Delete them?', ['Yes', 'No'])
    expect(loadAppOptions().environmentGeneral.ignoredWarnings).toEqual([])
  })

  it('remembers a message the user asked not to see again, and then says nothing at all', async () => {
    askMessage.mockResolvedValue({ button: 'Yes', dontShowAgain: true })

    await askIgnorableMessage(askDeleteAllBreakpointsId, 'Delete them?', ['Yes', 'No'])
    expect(loadAppOptions().environmentGeneral.ignoredWarnings).toEqual([askDeleteAllBreakpointsId])

    // The second time it is not put at all: an answer of undefined is what a caller reads as "go ahead".
    askMessage.mockClear()
    expect(await askIgnorableMessage(askDeleteAllBreakpointsId, 'Delete them?', ['Yes', 'No'])).toBeUndefined()
    expect(askMessage).not.toHaveBeenCalled()
  })

  it('keeps each message apart, and leaves the other options as they are', async () => {
    saveAppOptions({ ...loadAppOptions(), environmentGeneral: { ...loadAppOptions().environmentGeneral, theme: 'light' } })
    askMessage.mockResolvedValue({ button: 'No', dontShowAgain: true })

    await askIgnorableMessage('id-1', 'One?', ['Yes', 'No'])
    askMessage.mockResolvedValue({ button: 'Yes', dontShowAgain: false })
    expect(await askIgnorableMessage('id-2', 'Two?', ['Yes', 'No'])).toBe('Yes')

    const options = loadAppOptions()
    expect(options.environmentGeneral.ignoredWarnings).toEqual(['id-1'])
    expect(options.environmentGeneral.theme).toBe('light')
  })
})
