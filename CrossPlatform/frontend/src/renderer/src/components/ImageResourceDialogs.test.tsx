import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TreeNode } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { base64FromBytes, bytesFromBase64, formatColor, parseColor } from '../image-files'
import { decodeImageListStreamerData, type ImageListImage } from '../image-list-streamer'
import { encodeImageListState, imageListState } from './ImageResourceDialogs'
import { CreateImageListDialog, ResourceElementDialog } from './ResourceDialogs'

const { decodeImageFile } = vi.hoisted(() => ({ decodeImageFile: vi.fn() }))
vi.mock('../image-files', async (importOriginal) => ({ ...await importOriginal<typeof import('../image-files')>(), decodeImageFile, imageDataUrl: () => undefined }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const resourcesNode: TreeNode = { id: 'r1', label: 'App.resources', kind: 'resource', hasChildren: true, icon: 'SourceFileGroup' }
const entryNode: TreeNode = { id: 'e1', label: 'logo', kind: 'resourceentry', hasChildren: false, icon: 'Image' }

const solid = (width: number, height: number, rgba: [number, number, number, number]): ImageListImage => ({
  width,
  height,
  rgba: new Uint8ClampedArray(Array.from({ length: width * height }, () => rgba).flat()),
})

describe('the transparent colour, the way WinForms\' ColorConverter writes and reads it', () => {
  it('names a known colour and spells out any other', () => {
    expect(formatColor(0x00FFFFFF)).toBe('Transparent')
    expect(formatColor(0xFFFF00FF)).toBe('Magenta')
    expect(formatColor(0xFF010203)).toBe('1, 2, 3')
    expect(formatColor(0x80010203)).toBe('128, 1, 2, 3')
  })

  it('reads names, components and numbers, and nothing else', () => {
    expect(parseColor('magenta')).toBe(0xFFFF00FF)
    expect(parseColor('1, 2, 3')).toBe(0xFF010203)
    expect(parseColor('128,1,2,3')).toBe(0x80010203)
    expect(parseColor('#FF0000')).toBe(0xFFFF0000)
    expect(parseColor('')).toBe(0)
    expect(parseColor('1, 2')).toBeUndefined()
    expect(parseColor('300, 0, 0')).toBeUndefined()
    expect(parseColor('not a colour')).toBeUndefined()
  })
})

describe('an image list resource', () => {
  it('starts with WinForms\' defaults and round-trips through the bytes it is written as', () => {
    const state = imageListState('my.ImageStream')
    expect(state).toMatchObject({ colorDepth: 32, transparentColor: 'Transparent', width: '16', height: '16', images: [] })
    expect(() => encodeImageListState(state)).toThrow("It's not possible to create an empty image list")

    // An image of another size is made the list's, as ImageList.Images.Add does.
    const data = encodeImageListState({ ...state, width: '4', height: '4', images: [solid(4, 4, [255, 0, 0, 255]), solid(8, 8, [0, 0, 255, 255])] })
    const list = decodeImageListStreamerData(bytesFromBase64(data))
    expect(list).toMatchObject({ width: 4, height: 4, colorDepth: 32 })
    expect(list.images.map((image) => [...image.rgba.slice(0, 4)])).toEqual([[255, 0, 0, 255], [0, 0, 255, 255]])
    expect(imageListState('again', data)).toMatchObject({ name: 'again', width: '4', height: '4' })
  })
})

describe('the image resource windows', () => {
  it('Create System.Windows.Forms.ImageListStreamer Resource adds images from files and writes the list', async () => {
    const createResourceElement = vi.fn(async () => true)
    useAppStore.setState({ workspaceId: 'ws', createResourceElement })
    Object.assign(window.dnSpy, { pickImageFiles: vi.fn(async () => [{ name: 'a.png', base64Data: 'AA==' }]) })
    decodeImageFile.mockResolvedValue(solid(16, 16, [0, 255, 0, 255]))
    const onClose = vi.fn()
    render(<CreateImageListDialog resourceNode={resourcesNode} onClose={onClose} />)

    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('my.ImageStream'))
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', 'Create System.Windows.Forms.ImageListStreamer Resource')
    // An empty list cannot be written.
    expect(screen.getByRole('button', { name: 'OK' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Add...' }))
    await waitFor(() => expect(within(screen.getByRole('listbox', { name: 'Images' })).getAllByRole('option')).toHaveLength(1))
    expect(window.dnSpy.pickImageFiles).toHaveBeenCalledWith(false, false)
    fireEvent.change(screen.getByLabelText('Transparent Color'), { target: { value: 'nonsense' } })
    expect(screen.getByRole('button', { name: 'OK' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Transparent Color'), { target: { value: 'Magenta' } })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(createResourceElement).toHaveBeenCalledWith(resourcesNode, expect.objectContaining({ kind: 'imageListStreamer', name: 'my.ImageStream' }))
  })

  it('says why a file that is no image could not be added', async () => {
    Object.assign(window.dnSpy, { pickImageFiles: vi.fn(async () => [{ name: 'a.txt', base64Data: 'AA==' }]) })
    decodeImageFile.mockRejectedValue(new Error('bad data'))
    render(<CreateImageListDialog resourceNode={resourcesNode} onClose={() => undefined} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add...' }))
    expect(await screen.findByText("Could not open file or it's not an image. Error: bad data")).toBeInTheDocument()
  })

  it('edits a serialized image as its name and the image file it holds', async () => {
    const applyResourceElementOptions = vi.fn(async () => true)
    useAppStore.setState({ workspaceId: 'ws', applyResourceElementOptions })
    Object.assign(window.dnSpy, {
      getResourceElementOptions: vi.fn(async () => ({ kind: 'serializedImage', name: 'logo', base64Data: base64FromBytes(new Uint8Array(10)), typeCode: 64, display: '', serializationFormat: 'BinaryFormatter' })),
      pickImageFiles: vi.fn(async () => [{ name: 'b.png', base64Data: base64FromBytes(new Uint8Array(3)) }]),
    })
    render(<ResourceElementDialog node={entryNode} onClose={() => undefined} />)

    expect(await screen.findByDisplayValue('10 bytes')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open an image file' }))
    expect(await screen.findByDisplayValue('3 bytes')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(applyResourceElementOptions).toHaveBeenCalledWith(entryNode, expect.objectContaining({ kind: 'serializedImage', name: 'logo', base64Data: 'AAAA' })))
  })
})
