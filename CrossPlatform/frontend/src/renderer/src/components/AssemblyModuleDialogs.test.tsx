import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssemblyOptions, ModuleOptions, TreeNode } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { AssemblyOptionsDialog, ModuleOptionsDialog } from './AssemblyModuleDialogs'

const node: TreeNode = { id: 'n1', label: 'dnSpy.Backend.Contracts', kind: 'module', hasChildren: true }

const assembly = (patch: Partial<AssemblyOptions> = {}): AssemblyOptions => ({
  name: 'dnSpy.Backend.Contracts',
  culture: '',
  hashAlgorithm: 0x8004,
  attributes: 0,
  publicKey: '',
  versionMajor: 1,
  versionMinor: 2,
  versionBuild: 3,
  versionRevision: 4,
  customAttributes: [],
  declSecurities: [],
  fullName: 'dnSpy.Backend.Contracts, Version=1.2.3.4, Culture=neutral, PublicKeyToken=null',
  ...patch,
})

const module = (patch: Partial<ModuleOptions> = {}): ModuleOptions => ({
  name: 'dnSpy.Backend.Contracts.dll',
  kind: 2,
  mvid: '0f8fad5b-d9cb-469f-a165-70867728950e',
  encId: '',
  encBaseId: '',
  runtimeVersion: 'v4.0.30319',
  tablesHeaderVersion: 2,
  cor20HeaderRuntimeVersion: '00020000',
  cor20HeaderFlags: 1,
  machine: 0x14C,
  characteristics: 0x21,
  dllCharacteristics: 0,
  managedEntryPoint: null,
  nativeEntryPoint: 0,
  customAttributes: [],
  display: 'dnSpy.Backend.Contracts.dll',
  ...patch,
})

interface Harness {
  applyAssemblyOptions: ReturnType<typeof vi.fn>
  applyModuleOptions: ReturnType<typeof vi.fn>
}

const stub = (loadedAssembly = assembly(), loadedModule = module()): Harness => {
  const applyAssemblyOptions = vi.fn(async () => true)
  const applyModuleOptions = vi.fn(async () => true)
  Object.defineProperty(window, 'dnSpy', {
    configurable: true,
    value: {
      ...window.dnSpy,
      getAssemblyOptions: vi.fn(async () => loadedAssembly),
      getModuleOptions: vi.fn(async () => loadedModule),
    },
  })
  useAppStore.setState({ workspaceId: 'ws', applyAssemblyOptions, applyModuleOptions })
  return { applyAssemblyOptions, applyModuleOptions }
}

const accept = (): void => { fireEvent.click(screen.getByRole('button', { name: 'OK' })) }

beforeEach(() => {
  useAppStore.setState({ workspaceId: undefined })
})

afterEach(cleanup)

describe('AssemblyOptionsDialog', () => {
  it('draws the three pages of dnSpy\'s assembly window', async () => {
    stub()
    render(<AssemblyOptionsDialog node={node} onClose={() => undefined} />)
    expect(await screen.findByLabelText('Name')).toHaveValue('dnSpy.Backend.Contracts')
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Main', 'Custom Attributes', 'Security Declarations'])
    expect(screen.getByLabelText('Hash Algorithm')).toHaveValue('32772')
    expect(screen.getByLabelText('Version Major')).toHaveValue(1)
    expect(screen.getByLabelText('Version Revision')).toHaveValue(4)
    expect(screen.getByLabelText('Full Name')).toHaveValue(assembly().fullName)
  })

  it('writes the edited model back', async () => {
    const harness = stub()
    render(<AssemblyOptionsDialog node={node} onClose={() => undefined} />)
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Renamed' } })
    fireEvent.change(screen.getByLabelText('Version Major'), { target: { value: '9' } })
    fireEvent.change(screen.getByLabelText('Processor Architecture'), { target: { value: '64' } })
    accept()

    await waitFor(() => expect(harness.applyAssemblyOptions).toHaveBeenCalledTimes(1))
    const [, written] = harness.applyAssemblyOptions.mock.calls[0] as [TreeNode, AssemblyOptions]
    expect(written.name).toBe('Renamed')
    expect(written.versionMajor).toBe(9)
    expect(written.attributes & 0x70).toBe(0x40)
  })
})

describe('ModuleOptionsDialog', () => {
  it('draws the five pages of dnSpy\'s module window', async () => {
    stub()
    render(<ModuleOptionsDialog node={node} onClose={() => undefined} />)
    expect(await screen.findByLabelText('Name')).toHaveValue('dnSpy.Backend.Contracts.dll')
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Main', 'Metadata', 'Cor20', 'PE', 'Custom Attributes'])
    expect(screen.getByLabelText('Mvid')).toHaveValue('0f8fad5b-d9cb-469f-a165-70867728950e')
    expect(screen.getByLabelText('Module Type')).toHaveValue('2')
  })

  it('writes the module model back', async () => {
    const harness = stub()
    render(<ModuleOptionsDialog node={node} onClose={() => undefined} />)
    fireEvent.change(await screen.findByLabelText('Mvid'), { target: { value: '11111111-2222-3333-4444-555555555555' } })
    fireEvent.click(screen.getByRole('tab', { name: 'PE' }))
    fireEvent.click(screen.getByLabelText('Dll'))
    accept()

    await waitFor(() => expect(harness.applyModuleOptions).toHaveBeenCalledTimes(1))
    const [, written] = harness.applyModuleOptions.mock.calls[0] as [TreeNode, ModuleOptions]
    expect(written.mvid).toBe('11111111-2222-3333-4444-555555555555')
    expect(written.characteristics & 0x2000).toBe(0x2000)
  })
})
