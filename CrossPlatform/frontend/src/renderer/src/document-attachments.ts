// What a resource's document shows besides its text — dnSpy's IDocumentViewerOutput.AddUIElement and AddButton.
// dnSpy puts a WPF Image or Button into the text at a position, and the text view makes room for it in its line;
// Monaco cannot grow a line, so each element goes into a strip between two lines (a view zone) above the line
// dnSpy put it on: the picture of an image resource above its line, the images of an image list in a row, the
// Save button under a resource's line. The strips follow the zoom the way dnSpy's zoomed text view scales its
// elements with the text.
import { useEffect, useRef } from 'react'
import type { editor as MonacoEditor } from 'monaco-editor'
import type { DocumentAttachment } from '../../shared/protocol'
import { decodeImageListStreamerData } from './image-list-streamer'
import { bytesFromBase64, imageDataUrl } from './image-files'

/** A picture as the viewer draws it: where it comes from and its own size, in pixels. */
export interface AttachmentPicture {
  src: string
  width: number
  height: number
}

/** One element of a strip: a single picture, a row of them, or a button. */
export type AttachmentRow =
  | { kind: 'image'; pictures: AttachmentPicture[] }
  | { kind: 'imageList'; pictures: AttachmentPicture[] }
  | { kind: 'saveButton'; nodeId: string }

/** The elements that go between the same two lines, top to bottom in the order dnSpy added them. */
export interface AttachmentZone {
  afterLine: number
  rows: AttachmentRow[]
}

export interface AttachmentLayout {
  /** The viewer's zoom, in percent. */
  zoom: number
  /** The width of a space in the editor's font: what separates two images of a list in dnSpy's text. */
  spaceWidth: number
  saveLabel: string
  onSave(nodeId: string): void
}

/** WPF's TextEditorButton: a minimum height of 23 and width of 75, 10 by 1 padding. */
const BUTTON_HEIGHT = 23
const BUTTON_MIN_WIDTH = 75
/** The room above and below a strip's elements, so a picture does not touch the text around it. */
const ZONE_PADDING = 2

/** Reads a picture's own size — what WPF's Image shows it at with no stretching. */
export type ImageSizeReader = (src: string) => Promise<{ width: number; height: number } | undefined>

export const readImageSize: ImageSizeReader = (src) => new Promise((resolve) => {
  const image = new Image()
  image.onload = () => resolve(image.naturalWidth > 0 && image.naturalHeight > 0 ? { width: image.naturalWidth, height: image.naturalHeight } : undefined)
  image.onerror = () => resolve(undefined)
  image.src = src
})

/**
 * The images of a serialized ImageListStreamer's "Data", the way WinForms' ImageList reads them, as pictures. A list
 * that cannot be read shows nothing, as dnSpy shows no images for one either.
 */
export const imageListPictures = (base64Data: string): AttachmentPicture[] => {
  try {
    const list = decodeImageListStreamerData(bytesFromBase64(base64Data))
    return list.images.flatMap((image) => {
      const src = imageDataUrl(image)
      return src ? [{ src, width: image.width, height: image.height }] : []
    })
  } catch {
    return []
  }
}

/**
 * The strips of a document, one per line that has elements under it. A picture the browser cannot read is
 * left out, and a strip left with nothing in it is not made.
 */
export const prepareAttachmentZones = async (
  attachments: readonly DocumentAttachment[],
  readSize: ImageSizeReader = readImageSize,
): Promise<AttachmentZone[]> => {
  const rows = await Promise.all(attachments.map(async (attachment): Promise<AttachmentRow | undefined> => {
    switch (attachment.kind) {
      case 'image': {
        if (!attachment.base64Data || !attachment.mimeType)
          return undefined
        const src = `data:${attachment.mimeType};base64,${attachment.base64Data}`
        const size = await readSize(src)
        return size ? { kind: 'image', pictures: [{ src, ...size }] } : undefined
      }
      case 'imageList': {
        const pictures = attachment.base64Data ? imageListPictures(attachment.base64Data) : []
        return pictures.length > 0 ? { kind: 'imageList', pictures } : undefined
      }
      case 'saveButton':
        return attachment.nodeId ? { kind: 'saveButton', nodeId: attachment.nodeId } : undefined
      default:
        return undefined
    }
  }))
  const zones: AttachmentZone[] = []
  attachments.forEach((attachment, index) => {
    const row = rows[index]
    if (!row)
      return
    const zone = zones.find((candidate) => candidate.afterLine === attachment.afterLine)
    if (zone)
      zone.rows.push(row)
    else
      zones.push({ afterLine: attachment.afterLine, rows: [row] })
  })
  return zones
}

const scaled = (size: number, zoom: number): number => Math.max(1, Math.round(size * zoom / 100))

/** A strip's element, its size at the zoom, and how tall and wide it makes the strip. */
const rowElement = (row: AttachmentRow, layout: AttachmentLayout): { element: HTMLElement; height: number; width: number } => {
  const zoom = layout.zoom
  if (row.kind === 'saveButton') {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'document-attachment-button'
    button.textContent = layout.saveLabel
    button.dataset.nodeId = row.nodeId
    const height = scaled(BUTTON_HEIGHT, zoom)
    button.style.height = `${height}px`
    button.style.minWidth = `${scaled(BUTTON_MIN_WIDTH, zoom)}px`
    button.style.padding = `0 ${scaled(10, zoom)}px`
    button.style.fontSize = `${Math.max(1, 12 * zoom / 100)}px`
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      layout.onSave(row.nodeId)
    })
    return { element: button, height, width: scaled(BUTTON_MIN_WIDTH, zoom) }
  }
  const container = document.createElement('div')
  container.className = row.kind === 'imageList' ? 'document-attachment-image-list' : 'document-attachment-image'
  let width = 0
  let height = 0
  row.pictures.forEach((picture, index) => {
    const image = document.createElement('img')
    image.src = picture.src
    image.alt = ''
    image.draggable = false
    const pictureWidth = scaled(picture.width, zoom)
    const pictureHeight = scaled(picture.height, zoom)
    image.style.width = `${pictureWidth}px`
    image.style.height = `${pictureHeight}px`
    // dnSpy writes a space between two images of a list.
    const gap = index > 0 ? layout.spaceWidth : 0
    if (gap > 0)
      image.style.marginLeft = `${gap}px`
    width += gap + pictureWidth
    height = Math.max(height, pictureHeight)
    container.appendChild(image)
  })
  container.style.height = `${height}px`
  return { element: container, height, width }
}

/** A strip's DOM node and its size: its elements stacked in the order dnSpy added them. */
export const zoneElement = (zone: AttachmentZone, layout: AttachmentLayout): { element: HTMLElement; height: number; width: number } => {
  const element = document.createElement('div')
  element.className = 'document-attachment-zone'
  element.dataset.afterLine = String(zone.afterLine)
  element.style.paddingTop = element.style.paddingBottom = `${ZONE_PADDING}px`
  let height = ZONE_PADDING * 2
  let width = 0
  zone.rows.forEach((row, index) => {
    const built = rowElement(row, layout)
    if (index > 0) {
      built.element.style.marginTop = `${ZONE_PADDING}px`
      height += ZONE_PADDING
    }
    element.appendChild(built.element)
    height += built.height
    width = Math.max(width, built.width)
  })
  return { element, height, width }
}

/** What the strips need of the editor: room between its lines, and a layer over its text to draw in. */
export type AttachmentEditor = Pick<MonacoEditor.ICodeEditor,
  'changeViewZones' | 'addOverlayWidget' | 'removeOverlayWidget' | 'getLayoutInfo' | 'getScrollLeft' | 'onDidScrollChange' | 'onDidLayoutChange'>

let nextWidgetId = 0

/**
 * Puts the strips into the editor, and answers what takes them out again. A view zone makes the room between the
 * lines; what is drawn in it lives in an overlay widget kept over that room (the way Monaco's own zone widgets do
 * it), because the text layer lies over the view zones and would take the button's clicks. The overlay is clipped
 * to the text area and follows the text as it scrolls sideways.
 */
export const addAttachmentZones = (
  editor: AttachmentEditor,
  zones: readonly AttachmentZone[],
  layout: AttachmentLayout,
): (() => void) => {
  const strips = zones.map((zone) => {
    const strip = zoneElement(zone, layout)
    const frame = document.createElement('div')
    frame.className = 'document-attachment-frame'
    frame.style.height = `${strip.height}px`
    // Out of sight until the zone says where it is.
    frame.style.top = '-1000000px'
    frame.appendChild(strip.element)
    const id = `dnspy.documentAttachment.${nextWidgetId++}`
    const widget: MonacoEditor.IOverlayWidget = { getId: () => id, getDomNode: () => frame, getPosition: () => null }
    return { zone, strip, frame, widget }
  })
  const place = (): void => {
    const info = editor.getLayoutInfo()
    const scrollLeft = editor.getScrollLeft()
    for (const { frame, strip } of strips) {
      frame.style.left = `${info.contentLeft}px`
      frame.style.width = `${Math.max(0, info.contentWidth - info.verticalScrollbarWidth)}px`
      strip.element.style.transform = `translateX(${-scrollLeft}px)`
    }
  }
  const ids: string[] = []
  editor.changeViewZones((accessor) => {
    for (const { zone, strip, frame } of strips) {
      ids.push(accessor.addZone({
        afterLineNumber: zone.afterLine,
        heightInPx: strip.height,
        // A picture wider than the text widens what the view scrolls over, as a wide line would.
        minWidthInPx: strip.width,
        domNode: document.createElement('div'),
        // The editor keeps a mouse down in the room to itself rather than moving the caret.
        suppressMouseDown: true,
        onDomNodeTop: (top) => { frame.style.top = `${top}px` },
      }))
    }
  })
  for (const { widget } of strips)
    editor.addOverlayWidget(widget)
  place()
  const subscriptions = [editor.onDidScrollChange(place), editor.onDidLayoutChange(place)]
  return () => {
    for (const subscription of subscriptions)
      subscription.dispose()
    editor.changeViewZones((accessor) => {
      for (const id of ids)
        accessor.removeZone(id)
    })
    for (const { widget } of strips)
      editor.removeOverlayWidget(widget)
  }
}

/** What the strips of a mounted editor are drawn with; read when they are made. */
export interface AttachmentOptions {
  zoom: number
  /** The editor's font size: a change of font changes the width of the space between two images of a list. */
  fontSize: number
  saveLabel: string
  spaceWidth(): number
  onSave(nodeId: string): void
}

/**
 * Keeps a document's strips in the editor: made again when the document, the zoom or the font changes, taken
 * out with the editor's model. The pictures are read before the strips go in, so each strip knows its height.
 */
export const useDocumentAttachments = (
  editor: (AttachmentEditor & Pick<MonacoEditor.ICodeEditor, 'getModel'>) | undefined,
  attachments: readonly DocumentAttachment[] | null | undefined,
  text: string | undefined,
  options: AttachmentOptions,
): void => {
  const optionsRef = useRef(options)
  optionsRef.current = options
  const { zoom, fontSize, saveLabel } = options
  useEffect(() => {
    if (!editor || !attachments || attachments.length === 0)
      return
    let removeZones: (() => void) | undefined
    let cancelled = false
    void prepareAttachmentZones(attachments).then((zones) => {
      if (cancelled || zones.length === 0 || !editor.getModel())
        return
      removeZones = addAttachmentZones(editor, zones, {
        zoom,
        spaceWidth: optionsRef.current.spaceWidth(),
        saveLabel,
        onSave: (nodeId) => optionsRef.current.onSave(nodeId),
      })
    })
    return () => {
      cancelled = true
      removeZones?.()
    }
  }, [editor, attachments, text, zoom, fontSize, saveLabel])
}
