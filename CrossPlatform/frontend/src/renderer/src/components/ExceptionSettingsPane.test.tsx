import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DebugExceptionCategory, DebugExceptionSettings, DebugExceptionSettingsList } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { ExceptionSettingsPane } from './ExceptionSettingsPane'

const applyExceptionSettings = vi.fn(async (diff: unknown) => answered(diff))
const resetExceptionSettings = vi.fn(async () => answered({}))
const getExceptionSettings = vi.fn(async () => answered({}))

const DOT_NET: DebugExceptionCategory = {
  name: 'DotNet',
  displayName: 'Common Language Runtime Exceptions',
  shortDisplayName: '.NET',
  hasCode: false,
  decimalCode: false,
  unsignedCode: false,
}

const MDA: DebugExceptionCategory = {
  name: 'MDA',
  displayName: 'Managed Debugging Assistants',
  shortDisplayName: 'MDA',
  hasCode: false,
  decimalCode: false,
  unsignedCode: false,
}

const row = (extra: Partial<DebugExceptionSettings> & { name: string }): DebugExceptionSettings => ({
  key: `DotNet\u0001${extra.name}`,
  category: 'DotNet',
  code: null,
  description: null,
  defaultStopFirstChance: false,
  defaultStopSecondChance: true,
  stopFirstChance: false,
  stopSecondChance: true,
  conditions: [],
  ...extra,
})

const FIRST = row({ name: 'System.InvalidOperationException' })
const SECOND = row({ name: 'System.NullReferenceException' })
const ENABLED = row({ name: 'System.OperationCanceledException', defaultStopFirstChance: true, stopFirstChance: true })
const DEFAULT_ROW: DebugExceptionSettings = {
  key: 'DotNet\u0001#',
  category: 'DotNet',
  name: null,
  code: null,
  description: null,
  defaultStopFirstChance: false,
  defaultStopSecondChance: false,
  stopFirstChance: false,
  stopSecondChance: false,
  conditions: [],
}

const DEFAULT_LIST: DebugExceptionSettingsList = { categories: [DOT_NET, MDA], exceptions: [DEFAULT_ROW, FIRST, SECOND, ENABLED] }

/**
 * The engine's answer to a diff, which the pane has to be able to render: the rows it asked for, with
 * whatever it changed applied to them. The tests assert both halves — the diff that went out and the
 * list that came back — so a pane that guessed at the result instead of showing it would fail.
 */
const answered = (diff: unknown): DebugExceptionSettingsList => {
  const changes = diff as {
    added?: { name?: string | null }[]
    removed?: { name?: string | null }[]
    updated?: { name?: string | null; stopFirstChance?: boolean; conditions?: DebugExceptionSettings['conditions'] }[]
  }
  const removed = new Set((changes.removed ?? []).map((entry) => entry.name))
  const updated = new Map((changes.updated ?? []).map((entry) => [entry.name, entry]))
  const rows = DEFAULT_LIST.exceptions
    .filter((entry) => !removed.has(entry.name))
    .map((entry) => {
      const change = updated.get(entry.name)
      return change
        ? { ...entry, stopFirstChance: change.stopFirstChance ?? entry.stopFirstChance, conditions: change.conditions ?? entry.conditions }
        : entry
    })
  for (const entry of changes.added ?? [])
    rows.push(row({ name: String(entry.name), stopFirstChance: true, stopSecondChance: true }))
  return { categories: DEFAULT_LIST.categories, exceptions: rows }
}

beforeEach(() => {
  applyExceptionSettings.mockClear()
  resetExceptionSettings.mockClear()
  getExceptionSettings.mockClear()
  Object.defineProperty(window, 'dnSpy', {
    configurable: true,
    value: { ...window.dnSpy, getExceptionSettings, applyExceptionSettings, resetExceptionSettings },
  })
  useAppStore.setState({
    exceptionCategories: DEFAULT_LIST.categories,
    exceptionSettings: DEFAULT_LIST.exceptions,
    exceptionDiff: {},
    exceptionSettingsLoaded: true,
    exceptionSettingsError: undefined,
  })
})

afterEach(cleanup)

describe('ExceptionSettingsPane', () => {
  it('lists the types with their category and the category default row', () => {
    render(<ExceptionSettingsPane />)

    expect(screen.getByRole('checkbox', { name: 'Enable System.InvalidOperationException' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Disable System.OperationCanceledException' })).toBeChecked()
    expect(screen.getAllByText('Common Language Runtime Exceptions').length).toBeGreaterThan(0)
    // The row with no name stands for every type the list does not name.
    expect(screen.getByText('<All Common Language Runtime Exceptions not in this list>')).toBeVisible()
  })

  it('turns Break When Thrown on through a diff and shows what the engine answers', async () => {
    render(<ExceptionSettingsPane />)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Enable System.InvalidOperationException' }))

    await waitFor(() => expect(applyExceptionSettings).toHaveBeenCalled())
    expect(useAppStore.getState().exceptionDiff.updated).toEqual([{
      category: 'DotNet',
      name: 'System.InvalidOperationException',
      code: null,
      description: null,
      stopFirstChance: true,
      stopSecondChance: true,
      conditions: [],
    }])
    // The checkbox reads back from the list the engine returned, not from what the client hoped for.
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Disable System.InvalidOperationException' })).toBeChecked())
  })

  it('filters by name and by category and says so when nothing matches', () => {
    render(<ExceptionSettingsPane />)

    fireEvent.change(screen.getByRole('textbox', { name: 'Search for an exception' }), { target: { value: 'nullref' } })
    expect(screen.queryByText('System.InvalidOperationException')).not.toBeInTheDocument()
    expect(screen.getByText('System.NullReferenceException')).toBeVisible()

    fireEvent.change(screen.getByRole('textbox', { name: 'Search for an exception' }), { target: { value: 'nothing-like-this' } })
    expect(screen.getByText('No exception types match your search filter.')).toBeVisible()
  })

  it('shows only the types that are set to break when thrown', () => {
    render(<ExceptionSettingsPane />)

    fireEvent.click(screen.getByRole('button', { name: 'Show only enabled exceptions' }))

    expect(screen.getByText('System.OperationCanceledException')).toBeVisible()
    expect(screen.queryByText('System.InvalidOperationException')).not.toBeInTheDocument()
  })

  it('adds a type the definition files do not name', async () => {
    render(<ExceptionSettingsPane />)

    fireEvent.click(screen.getByRole('button', { name: 'Add an exception to the list' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'My.Custom.Exception' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(useAppStore.getState().exceptionDiff.added).toHaveLength(1))
    expect(useAppStore.getState().exceptionDiff.added?.[0]).toMatchObject({ category: 'DotNet', name: 'My.Custom.Exception', stopFirstChance: true })
    // Added rows are the ones that are set to break when thrown out of the box.
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Disable My.Custom.Exception' })).toBeChecked())
  })

  it('removes the selected types', async () => {
    render(<ExceptionSettingsPane />)

    fireEvent.mouseDown(screen.getByText('System.NullReferenceException'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove an exception from the list' }))

    await waitFor(() => expect(useAppStore.getState().exceptionDiff.removed).toHaveLength(1))
    expect(useAppStore.getState().exceptionDiff.removed?.[0]).toMatchObject({ name: 'System.NullReferenceException' })
    await waitFor(() => expect(screen.queryByText('System.NullReferenceException')).not.toBeInTheDocument())
  })

  it('sets every type in view from the toolbar toggle', async () => {
    render(<ExceptionSettingsPane />)

    fireEvent.change(screen.getByRole('textbox', { name: 'Search for an exception' }), { target: { value: 'System.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Enable or disable all exceptions matching the current search criteria' }))

    await waitFor(() => expect(applyExceptionSettings).toHaveBeenCalled())
    // One of the three rows the search matched was already set, so the toggle clears all three.
    await waitFor(() => expect(useAppStore.getState().exceptionDiff.updated).toHaveLength(3))
    expect(useAppStore.getState().exceptionDiff.updated?.every((entry) => entry.stopFirstChance === false)).toBe(true)
  })

  it('writes conditions and turns Break When Thrown on with them', async () => {
    render(<ExceptionSettingsPane />)

    fireEvent.mouseDown(screen.getByText('System.InvalidOperationException'))
    fireEvent.click(screen.getByRole('button', { name: 'Edit conditions' }))
    // EditExceptionConditionsDlg opens with one ModuleNameNotEquals row already there.
    fireEvent.change(screen.getByRole('textbox', { name: 'Module name' }), { target: { value: 'MyApp*' } })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))

    await waitFor(() => expect(useAppStore.getState().exceptionDiff.updated).toHaveLength(1))
    expect(useAppStore.getState().exceptionDiff.updated?.[0]).toMatchObject({
      name: 'System.InvalidOperationException',
      stopFirstChance: true,
      conditions: [{ type: 'moduleNameNotEquals', value: 'MyApp*' }],
    })
    await waitFor(() => expect(screen.getByText('Module name not equals "MyApp*"')).toBeVisible())
  })

  it('restores the defaults and throws the diff away', async () => {
    useAppStore.setState({ exceptionDiff: { updated: [{ category: 'DotNet', name: 'System.InvalidOperationException', stopFirstChance: true }] } })
    render(<ExceptionSettingsPane />)

    fireEvent.click(screen.getByRole('button', { name: 'Restore the list to the default settings' }))

    await waitFor(() => expect(resetExceptionSettings).toHaveBeenCalled())
    expect(useAppStore.getState().exceptionDiff).toEqual({})
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Enable System.InvalidOperationException' })).not.toBeChecked())
  })
})

describe('ExceptionSettingsPane without an engine', () => {
  it('reports why the list could not be read', async () => {
    getExceptionSettings.mockRejectedValueOnce(new Error('The backend is not running.'))
    useAppStore.setState({ exceptionCategories: [], exceptionSettings: [], exceptionSettingsLoaded: false, exceptionDiff: {} })
    render(<ExceptionSettingsPane />)

    expect(await screen.findByText('The exception settings could not be read: The backend is not running.')).toBeVisible()
  })
})
