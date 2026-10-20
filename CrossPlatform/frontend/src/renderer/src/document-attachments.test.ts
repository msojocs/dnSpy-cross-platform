import { describe, expect, it, vi } from 'vitest'
import type { editor as MonacoEditor } from 'monaco-editor'
import type { DocumentAttachment } from '../../shared/protocol'
import { addAttachmentZones, prepareAttachmentZones, zoneElement, type AttachmentEditor, type AttachmentLayout, type AttachmentZone } from './document-attachments'
import { encodeImageListStreamerData, type ImageListImage } from './image-list-streamer'
import { base64FromBytes } from './image-files'

// jsdom has no canvas to draw an image list's images with, so a picture's address says which image it is.
vi.mock('./image-files', async (importOriginal) => ({
  ...await importOriginal<typeof import('./image-files')>(),
  imageDataUrl: (image: ImageListImage) => `data:test;${image.width}x${image.height}`,
}))

const solid = (width: number, height: number): ImageListImage => ({ width, height, rgba: new Uint8ClampedArray(width * height * 4).fill(255) })

const imageListData = (...images: ImageListImage[]): string =>
  base64FromBytes(encodeImageListStreamerData({ colorDepth: 32, width: images[0].width, height: images[0].height, transparentColor: 0x00FFFFFF, images }))

const layout = (overrides: Partial<AttachmentLayout> = {}): AttachmentLayout => ({ zoom: 100, spaceWidth: 7, saveLabel: 'Save', onSave: () => {}, ...overrides })

describe('a resource document\'s attachments', () => {
  it('puts what goes between the same two lines into one strip, in the order it was added', async () => {
    const attachments: DocumentAttachment[] = [
      { afterLine: 0, kind: 'image', base64Data: 'iVBORw0K', mimeType: 'image/png' },
      { afterLine: 1, kind: 'saveButton', nodeId: 'resource:a' },
      { afterLine: 4, kind: 'image', base64Data: 'R0lGODlh', mimeType: 'image/gif' },
      { afterLine: 4, kind: 'saveButton', nodeId: 'resource:b' },
    ]
    const zones = await prepareAttachmentZones(attachments, async (src) => (src.startsWith('data:image/png') ? { width: 32, height: 16 } : { width: 8, height: 8 }))

    expect(zones).toEqual([
      { afterLine: 0, rows: [{ kind: 'image', pictures: [{ src: 'data:image/png;base64,iVBORw0K', width: 32, height: 16 }] }] },
      { afterLine: 1, rows: [{ kind: 'saveButton', nodeId: 'resource:a' }] },
      { afterLine: 4, rows: [{ kind: 'image', pictures: [{ src: 'data:image/gif;base64,R0lGODlh', width: 8, height: 8 }] }, { kind: 'saveButton', nodeId: 'resource:b' }] },
    ])
  })

  it('leaves out a picture the browser cannot read and an image list it cannot decode', async () => {
    const zones = await prepareAttachmentZones([
      { afterLine: 2, kind: 'image', base64Data: 'AAAA', mimeType: 'image/png' },
      { afterLine: 3, kind: 'imageList', base64Data: base64FromBytes(Uint8Array.from([1, 2, 3])) },
      { afterLine: 5, kind: 'saveButton', nodeId: 'resource:c' },
    ], async () => undefined)

    expect(zones).toEqual([{ afterLine: 5, rows: [{ kind: 'saveButton', nodeId: 'resource:c' }] }])
  })

  it('shows every image of an image list, the way WinForms reads its Data bytes', async () => {
    const zones = await prepareAttachmentZones([{ afterLine: 6, kind: 'imageList', base64Data: imageListData(solid(16, 16), solid(16, 16), solid(16, 16)) }])

    expect(zones).toHaveLength(1)
    expect(zones[0].rows).toEqual([{ kind: 'imageList', pictures: Array(3).fill({ src: 'data:test;16x16', width: 16, height: 16 }) }])
  })

  it('draws a picture at its own size, scaled with the zoom, and makes the strip as tall as it', () => {
    const zone: AttachmentZone = { afterLine: 0, rows: [{ kind: 'image', pictures: [{ src: 'data:image/png;base64,AA', width: 40, height: 20 }] }] }

    const plain = zoneElement(zone, layout())
    const image = plain.element.querySelector('img')!
    expect(image.getAttribute('src')).toBe('data:image/png;base64,AA')
    expect([image.style.width, image.style.height]).toEqual(['40px', '20px'])
    expect(plain.height).toBe(20 + 4)
    expect(plain.width).toBe(40)

    const zoomed = zoneElement(zone, layout({ zoom: 150 }))
    const zoomedImage = zoomed.element.querySelector('img')!
    expect([zoomedImage.style.width, zoomedImage.style.height]).toEqual(['60px', '30px'])
    expect(zoomed.height).toBe(30 + 4)
  })

  it('separates the images of a list by the width of a space', () => {
    const picture = { src: 'data:test', width: 16, height: 16 }
    const { element, width } = zoneElement({ afterLine: 3, rows: [{ kind: 'imageList', pictures: [picture, picture, picture] }] }, layout({ spaceWidth: 7 }))

    const images = [...element.querySelectorAll('img')]
    expect(images.map((image) => image.style.marginLeft)).toEqual(['', '7px', '7px'])
    expect(width).toBe(16 * 3 + 7 * 2)
  })

  it('saves the node a Save button names when it is clicked', () => {
    const onSave = vi.fn()
    const { element, height } = zoneElement({ afterLine: 1, rows: [{ kind: 'saveButton', nodeId: 'resource:x' }] }, layout({ onSave, saveLabel: '保存' }))

    const button = element.querySelector('button')!
    expect(button.textContent).toBe('保存')
    expect(button.className).toBe('document-attachment-button')
    expect(height).toBe(23 + 4)
    button.click()
    expect(onSave).toHaveBeenCalledExactlyOnceWith('resource:x')
  })

  it('stacks the elements of one strip and adds their heights', () => {
    const { element, height } = zoneElement({
      afterLine: 4,
      rows: [{ kind: 'image', pictures: [{ src: 'data:a', width: 8, height: 10 }] }, { kind: 'saveButton', nodeId: 'n' }],
    }, layout())

    expect(element.children).toHaveLength(2)
    expect(height).toBe(10 + 2 + 23 + 4)
  })

  it('makes room under each strip\'s line and draws the strip over it, following the text sideways', () => {
    const added: MonacoEditor.IViewZone[] = []
    const removed: string[] = []
    const overlays: MonacoEditor.IOverlayWidget[] = []
    const listeners: (() => void)[] = []
    let scrollLeft = 0
    const accessor = {
      addZone: (zone: MonacoEditor.IViewZone) => { added.push(zone); return `zone-${added.length}` },
      removeZone: (id: string) => { removed.push(id) },
      layoutZone: () => {},
    }
    const subscription = (listener: () => void) => { listeners.push(listener); return { dispose: () => listeners.splice(listeners.indexOf(listener), 1) } }
    const editor = {
      changeViewZones: (callback: (accessor: MonacoEditor.IViewZoneChangeAccessor) => void) => callback(accessor),
      addOverlayWidget: (widget: MonacoEditor.IOverlayWidget) => { overlays.push(widget) },
      removeOverlayWidget: (widget: MonacoEditor.IOverlayWidget) => { overlays.splice(overlays.indexOf(widget), 1) },
      getLayoutInfo: () => ({ contentLeft: 60, contentWidth: 500, verticalScrollbarWidth: 14 }) as MonacoEditor.EditorLayoutInfo,
      getScrollLeft: () => scrollLeft,
      onDidScrollChange: subscription,
      onDidLayoutChange: subscription,
    } as unknown as AttachmentEditor

    const remove = addAttachmentZones(editor, [
      { afterLine: 0, rows: [{ kind: 'image', pictures: [{ src: 'data:a', width: 900, height: 50 }] }] },
      { afterLine: 1, rows: [{ kind: 'saveButton', nodeId: 'n' }] },
    ], layout())

    expect(added.map((zone) => [zone.afterLineNumber, zone.heightInPx, zone.minWidthInPx, zone.suppressMouseDown])).toEqual([[0, 54, 900, true], [1, 27, 75, true]])
    expect(overlays).toHaveLength(2)
    const frame = overlays[1].getDomNode()
    expect(overlays[1].getPosition()).toBeNull()
    expect(frame.querySelector('.document-attachment-zone button')?.textContent).toBe('Save')
    expect([frame.style.left, frame.style.width, frame.style.height]).toEqual(['60px', '486px', '27px'])
    added[1].onDomNodeTop!(120)
    expect(frame.style.top).toBe('120px')
    scrollLeft = 30
    for (const listener of [...listeners])
      listener()
    expect((frame.firstElementChild as HTMLElement).style.transform).toBe('translateX(-30px)')

    remove()
    expect(removed).toEqual(['zone-1', 'zone-2'])
    expect(overlays).toHaveLength(0)
    expect(listeners).toHaveLength(0)
  })
})
