import { useEffect, useMemo, useState } from 'react'
import type { ResourceElementOptions } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { base64FromBytes, bytesFromBase64, decodeImageFile, formatColor, imageDataUrl, parseColor } from '../image-files'
import { decodeImageListStreamerData, encodeImageListStreamerData, scaleImage, type ImageListColorDepth, type ImageListImage } from '../image-list-streamer'
import { useLanguage } from '../localization'
import { OptionsShell } from './OptionsShell'

interface ImageResourceElementDialogProps {
  options: ResourceElementOptions
  onSubmit(options: ResourceElementOptions): Promise<boolean>
  onClose(): void
}

/**
 * dnSpy's `ImageResourceElementDlg`, which edits a serialized Bitmap or Icon and a byte array or stream that holds an
 * image file: the entry's name, and its image as a count of bytes with a "..." button that reads another file in.
 */
export const ImageResourceElementDialog = ({ options: initial, onSubmit, onClose }: ImageResourceElementDialogProps): React.JSX.Element => {
  const { t } = useLanguage()
  const [options, setOptions] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()
  const length = options.base64Data ? bytesFromBase64(options.base64Data).length : 0
  const content = (
    <div className="options-form">
      <label>{t('Name')}<input aria-label={t('Name')} value={options.name} onChange={(event) => setOptions({ ...options, name: event.target.value })} /></label>
      <label>{t('Data')}
        <span className="options-inline">
          <input readOnly aria-label={t('Data')} value={t('{count} bytes', { count: length })} />
          <button type="button" aria-label={t('Open an image file')} onClick={() => {
            void window.dnSpy.pickImageFiles(false, true).then((files) => {
              if (files.length > 0)
                setOptions((current) => ({ ...current, base64Data: files[0].base64Data }))
            })
          }}>...</button>
        </span>
      </label>
    </div>
  )
  return (
    <OptionsShell
      title="Edit Resource"
      hideTabStrip
      className="resource-dialog"
      tabs={[{ label: 'Resource', content }]}
      invalid={!options.name.trim()}
      busy={busy}
      error={failure}
      onAccept={() => {
        setBusy(true)
        setFailure(undefined)
        void onSubmit(options).then((written) => { setBusy(false); if (written) onClose(); else setFailure(useAppStore.getState().error) })
      }}
      onClose={onClose}
      onReset={() => setOptions(initial)}
    />
  )
}

const COLOR_DEPTHS: { value: ImageListColorDepth; label: string }[] = [
  { value: 4, label: '4-bit' },
  { value: 8, label: '8-bit' },
  { value: 16, label: '16-bit' },
  { value: 24, label: '24-bit' },
  { value: 32, label: '32-bit' },
]

interface ImageListState {
  name: string
  colorDepth: ImageListColorDepth
  transparentColor: string
  width: string
  height: string
  images: ImageListImage[]
}

/** What an image list resource holds, as the window shows it — WinForms' defaults for a new one. */
export const imageListState = (name: string, base64Data?: string | null): ImageListState => {
  if (!base64Data)
    return { name, colorDepth: 32, transparentColor: formatColor(0x00FFFFFF), width: '16', height: '16', images: [] }
  const list = decodeImageListStreamerData(bytesFromBase64(base64Data))
  return {
    name,
    colorDepth: list.colorDepth,
    transparentColor: formatColor(list.transparentColor === 0 ? 0x00FFFFFF : list.transparentColor),
    width: String(list.width),
    height: String(list.height),
    images: list.images,
  }
}

const sizeOf = (text: string): number | undefined => {
  const value = /^\s*\d+\s*$/.test(text) ? Number(text) : NaN
  return value >= 1 && value <= 256 ? value : undefined
}

/**
 * The "Data" bytes of a serialized ImageListStreamer for what the window holds: every image made the list's size the
 * way ImageList.Images.Add does, then written as WinForms writes an image list.
 */
export const encodeImageListState = (state: ImageListState): string => {
  const width = sizeOf(state.width)
  const height = sizeOf(state.height)
  const transparentColor = parseColor(state.transparentColor)
  if (width === undefined || height === undefined || transparentColor === undefined)
    throw new Error('The image list is not valid.')
  if (state.images.length === 0)
    throw new Error("It's not possible to create an empty image list")
  return base64FromBytes(encodeImageListStreamerData({
    colorDepth: state.colorDepth,
    width,
    height,
    transparentColor,
    images: state.images.map((image) => scaleImage(image, width, height)),
  }))
}

const ImageRow = ({ image }: { image: ImageListImage }): React.JSX.Element => {
  const url = useMemo(() => imageDataUrl(image), [image])
  return url
    ? <img src={url} width={image.width} height={image.height} alt={`${image.width} x ${image.height}`} />
    : <span>{`${image.width} x ${image.height}`}</span>
}

interface ImageListDialogProps {
  title: string
  name: string
  /** The "Data" bytes of the resource being edited; none for Create System.Windows.Forms.ImageListStreamer Resource. */
  base64Data?: string | null
  onSubmit(name: string, base64Data: string): Promise<boolean>
  onClose(): void
}

/**
 * dnSpy's `ImageListDlg`: an image list's name, colour depth, transparent colour and image size, with the images in a
 * list that is ordered with the arrows, and added to or replaced from image files. A list with no images, or with a
 * size or colour that is not one, cannot be written.
 */
export const ImageListDialog = ({ title, name, base64Data, onSubmit, onClose }: ImageListDialogProps): React.JSX.Element => {
  const { t } = useLanguage()
  const [initial, setInitial] = useState<ImageListState>()
  const [state, setState] = useState<ImageListState>()
  const [selected, setSelected] = useState(-1)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()

  useEffect(() => {
    try {
      const loaded = imageListState(name, base64Data)
      setInitial(loaded)
      setState(loaded)
    }
    catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    }
  }, [name, base64Data])

  if (!state) {
    return (
      <OptionsShell
        title={title}
        hideTabStrip
        tabs={[{ label: title, content: <div className={failure ? 'modal-error' : 'il-loading'}>{failure ?? t('Loading...')}</div> }]}
        invalid
        error={failure}
        onAccept={onClose}
        onClose={onClose}
      />
    )
  }

  const patch = (next: Partial<ImageListState>): void => setState((current) => current ? { ...current, ...next } : current)
  const pickImage = (apply: (image: ImageListImage) => void): void => {
    void window.dnSpy.pickImageFiles(false, false).then(async (files) => {
      if (files.length === 0)
        return
      try {
        apply(await decodeImageFile(bytesFromBase64(files[0].base64Data)))
        setFailure(undefined)
      }
      catch (error) {
        setFailure(t("Could not open file or it's not an image. Error: {message}", { message: error instanceof Error ? error.message : String(error) }))
      }
    })
  }
  const move = (delta: number): void => {
    const target = selected + delta
    if (selected < 0 || target < 0 || target >= state.images.length)
      return
    const images = [...state.images]
    ;[images[selected], images[target]] = [images[target], images[selected]]
    patch({ images })
    setSelected(target)
  }
  const widthInvalid = sizeOf(state.width) === undefined
  const heightInvalid = sizeOf(state.height) === undefined
  const colorInvalid = parseColor(state.transparentColor) === undefined
  const content = (
    <div className="image-list-dialog-body">
      <div className="options-form">
        <label>{t('Name')}<input aria-label={t('Name')} value={state.name} onChange={(event) => patch({ name: event.target.value })} /></label>
        <label>{t('Color Depth')}
          <select aria-label={t('Color Depth')} value={state.colorDepth} onChange={(event) => patch({ colorDepth: Number(event.target.value) as ImageListColorDepth })}>
            {COLOR_DEPTHS.map((depth) => <option key={depth.value} value={depth.value}>{t(depth.label)}</option>)}
          </select>
        </label>
        <label>{t('Transparent Color')}<input aria-label={t('Transparent Color')} aria-invalid={colorInvalid} value={state.transparentColor} onChange={(event) => patch({ transparentColor: event.target.value })} /></label>
        <label>{t('Size')}
          <span className="options-inline">
            <input aria-label={t('Width')} aria-invalid={widthInvalid} value={state.width} onChange={(event) => patch({ width: event.target.value })} />
            <span>x</span>
            <input aria-label={t('Height')} aria-invalid={heightInvalid} value={state.height} onChange={(event) => patch({ height: event.target.value })} />
          </span>
        </label>
      </div>
      <div className="typesig-list-body">
        <div className="typesig-list image-list" role="listbox" aria-label={t('Images')}>
          {state.images.map((image, index) => (
            <div key={index} role="option" aria-selected={index === selected} className={`typesig-list-row${index === selected ? ' selected' : ''}`} onClick={() => setSelected(index)}>
              <ImageRow image={image} />
            </div>
          ))}
        </div>
        <div className="typesig-list-move">
          <button type="button" disabled={selected <= 0} title={t('Move Up')} aria-label={t('Move Up')} onClick={() => move(-1)}>↑</button>
          <button type="button" disabled={selected < 0 || selected >= state.images.length - 1} title={t('Move Down')} aria-label={t('Move Down')} onClick={() => move(1)}>↓</button>
        </div>
      </div>
      <div className="typesig-buttons">
        <button type="button" disabled={selected < 0} onClick={() => pickImage((image) => patch({ images: state.images.map((existing, index) => index === selected ? image : existing) }))}>{t('Edit...')}</button>
        <button type="button" onClick={() => pickImage((image) => {
          setState((current) => current ? { ...current, images: [...current.images, image] } : current)
          setSelected(state.images.length)
        })}>{t('Add...')}</button>
        <button type="button" disabled={selected < 0} onClick={() => {
          patch({ images: state.images.filter((_, index) => index !== selected) })
          setSelected(Math.min(selected, state.images.length - 2))
        }}>{t('Remove')}</button>
      </div>
    </div>
  )
  return (
    <OptionsShell
      title={title}
      hideTabStrip
      className="image-list-dialog"
      tabs={[{ label: title, content }]}
      invalid={state.images.length === 0 || widthInvalid || heightInvalid || colorInvalid}
      busy={busy}
      error={failure}
      onAccept={() => {
        let data: string
        try {
          data = encodeImageListState(state)
        }
        catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
          return
        }
        setBusy(true)
        setFailure(undefined)
        void onSubmit(state.name, data).then((written) => { setBusy(false); if (written) onClose(); else setFailure(useAppStore.getState().error) })
      }}
      onClose={onClose}
      onReset={() => { if (initial) { setState(initial); setSelected(-1) } }}
    />
  )
}
