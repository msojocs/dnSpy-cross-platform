import { useEffect, useRef, useState } from 'react'
import type { CreateResourceEntry, ResourceCreateKind, ResourceElementKind, ResourceElementOptions, ResourceOptions, TreeNode } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import { useLanguage } from '../localization'
import { CustomAttributeListEditor } from './widgets/CustomAttributeListEditor'
import { customAttributeDraft, customAttributeDto, type CustomAttributeDraft } from './widgets/custom-attribute'
import { ImageListDialog, ImageResourceElementDialog } from './ImageResourceDialogs'
import { OptionsShell, type OptionsTab } from './OptionsShell'

/** dnlib's ManifestResourceAttributes.Public/Private, which are the low two bits of the row's flags. */
const VISIBILITY_PUBLIC = 1
const VISIBILITY_PRIVATE = 2
const VISIBILITY_MASK = 3

const base64 = (data: Uint8Array): string => {
  let binary = ''
  for (const byte of data)
    binary += String.fromCharCode(byte)
  return btoa(binary)
}

const readFile = async (file: File): Promise<string> => base64(new Uint8Array(await file.arrayBuffer()))

interface ResourceOptionsDialogProps {
  node: TreeNode
  onClose(): void
}

/**
 * dnSpy's `ResourceDlg`: a manifest resource's name, visibility and — for the two link kinds — what it is
 * linked to. The type is shown but not offered, because dnSpy's own dialog does not let a resource change
 * from embedded to linked either.
 */
export const ResourceOptionsDialog = ({ node, onClose }: ResourceOptionsDialogProps): React.JSX.Element => {
  const { t } = useLanguage()
  const workspaceId = useAppStore((state) => state.workspaceId)
  const applyResourceOptions = useAppStore((state) => state.applyResourceOptions)
  const [options, setOptions] = useState<ResourceOptions>()
  const [initial, setInitial] = useState<ResourceOptions>()
  const [customAttributes, setCustomAttributes] = useState<CustomAttributeDraft[]>([])
  const [failure, setFailure] = useState<string>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!workspaceId)
      return
    let cancelled = false
    void window.dnSpy.getResourceOptions(workspaceId, node.id)
      .then((loaded) => { if (!cancelled) { setOptions(loaded); setInitial(loaded); setCustomAttributes(loaded.customAttributes.map(customAttributeDraft)) } })
      .catch((reason: unknown) => { if (!cancelled) setFailure(reason instanceof Error ? reason.message : String(reason)) })
    return () => { cancelled = true }
  }, [workspaceId, node.id])

  if (!options || !workspaceId) {
    return (
      <OptionsShell
        title="Edit Resource"
        hideTabStrip
        tabs={[{ label: 'Resource', content: <div className={failure ? 'modal-error' : 'il-loading'}>{failure ?? t('Loading...')}</div> }]}
        invalid={failure !== undefined}
        error={failure}
        onAccept={onClose}
        onClose={onClose}
      />
    )
  }

  const patch = (next: Partial<ResourceOptions>): void => setOptions((current) => current ? { ...current, ...next } : current)
  const visibility = options.attributes & VISIBILITY_MASK
  const content = (
    <div className="resource-dialog-body">
      <label>{t('Name')}<input aria-label={t('Name')} value={options.name} onChange={(event) => patch({ name: event.target.value })} /></label>
      <label>{t('Visibility')}
        <select
          aria-label={t('Visibility')}
          value={visibility === VISIBILITY_PRIVATE ? VISIBILITY_PRIVATE : VISIBILITY_PUBLIC}
          onChange={(event) => patch({ attributes: (options.attributes & ~VISIBILITY_MASK) | Number(event.target.value) })}
        >
          <option value={VISIBILITY_PUBLIC}>{t('Public')}</option>
          <option value={VISIBILITY_PRIVATE}>{t('Private')}</option>
        </select>
      </label>
      <label>{t('Type')}<input readOnly aria-label={t('Type')} value={options.kind} /></label>
      {options.kind === 'assemblyLinked' && (
        <label>{t('Assembly')}<input aria-label={t('Assembly')} value={options.assemblyFullName ?? ''} onChange={(event) => patch({ assemblyFullName: event.target.value })} /></label>
      )}
      {options.kind === 'linked' && (
        <>
          <label>{t('File name')}<input aria-label={t('File name')} value={options.linkedFileName ?? ''} onChange={(event) => patch({ linkedFileName: event.target.value })} /></label>
          <label><input type="checkbox" checked={options.fileContainsNoMetadata} onChange={(event) => patch({ fileContainsNoMetadata: event.target.checked })} /> {t('File contains no metadata')}</label>
          <label>{t('Hash')}<input aria-label={t('Hash')} value={options.fileHash ?? ''} onChange={(event) => patch({ fileHash: event.target.value })} /></label>
        </>
      )}
      <CustomAttributeListEditor
        workspaceId={workspaceId}
        items={customAttributes}
        onChange={setCustomAttributes}
      />
    </div>
  )
  const tabs: OptionsTab[] = [{ label: 'Resource', content }]
  return (
    <OptionsShell
      title="Edit Resource"
      className="resource-dialog"
      tabs={tabs}
      invalid={!options.name.trim() || (options.kind === 'assemblyLinked' && !options.assemblyFullName?.trim()) || (options.kind === 'linked' && !options.linkedFileName?.trim())}
      busy={busy}
      error={failure}
      onAccept={() => {
        setBusy(true)
        setFailure(undefined)
        let written: ResourceOptions
        try {
          written = { ...options, customAttributes: customAttributes.map(customAttributeDto) }
        }
        catch (reason) {
          setBusy(false)
          setFailure(reason instanceof Error ? reason.message : String(reason))
          return
        }
        void applyResourceOptions(node, written).then((applied) => { setBusy(false); if (applied) onClose(); else setFailure(useAppStore.getState().error) })
      }}
      onClose={onClose}
      onReset={() => { if (initial) { setOptions(initial); setCustomAttributes(initial.customAttributes.map(customAttributeDraft)) } }}
    />
  )
}

interface ResourceElementDialogProps {
  node: TreeNode
  onClose(): void
}

/** dnSpy's `ResourceElementDlg`: the entry's name and value, typed by the kind it already has. */
export const ResourceElementDialog = ({ node, onClose }: ResourceElementDialogProps): React.JSX.Element => {
  const { t } = useLanguage()
  const workspaceId = useAppStore((state) => state.workspaceId)
  const applyResourceElementOptions = useAppStore((state) => state.applyResourceElementOptions)
  const [options, setOptions] = useState<ResourceElementOptions>()
  const [initial, setInitial] = useState<ResourceElementOptions>()
  const [failure, setFailure] = useState<string>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!workspaceId)
      return
    let cancelled = false
    void window.dnSpy.getResourceElementOptions(workspaceId, node.id)
      .then((loaded) => { if (!cancelled) { setOptions(loaded); setInitial(loaded) } })
      .catch((reason: unknown) => { if (!cancelled) setFailure(reason instanceof Error ? reason.message : String(reason)) })
    return () => { cancelled = true }
  }, [workspaceId, node.id])

  if (!options) {
    return (
      <OptionsShell
        title="Edit Resource Element"
        hideTabStrip
        tabs={[{ label: 'Resource', content: <div className={failure ? 'modal-error' : 'il-loading'}>{failure ?? t('Loading...')}</div> }]}
        invalid={failure !== undefined}
        error={failure}
        onAccept={onClose}
        onClose={onClose}
      />
    )
  }

  // dnSpy opens its image windows for an image resource: ImageResourceElementDlg for a Bitmap, an Icon or a byte array
  // or stream that holds an image file, and ImageListDlg for an ImageListStreamer.
  if (options.kind === 'serializedImage' || options.isImage)
    return <ImageResourceElementDialog options={options} onSubmit={(next) => applyResourceElementOptions(node, next)} onClose={onClose} />
  if (options.kind === 'imageListStreamer') {
    return (
      <ImageListDialog
        title="Edit Resource"
        name={options.name}
        base64Data={options.base64Data}
        onSubmit={(name, data) => applyResourceElementOptions(node, { ...options, name, base64Data: data })}
        onClose={onClose}
      />
    )
  }

  const patch = (next: Partial<ResourceElementOptions>): void => setOptions((current) => current ? { ...current, ...next } : current)
  const binary = options.kind === 'byteArray' || options.kind === 'stream' || options.kind === 'binary'
  const content = (
    <div className="resource-dialog-body">
      <label>{t('Name')}<input aria-label={t('Name')} value={options.name} onChange={(event) => patch({ name: event.target.value })} /></label>
      <label>{t('Type')}<input readOnly aria-label={t('Type')} value={options.display || options.kind} /></label>
      {options.kind === 'null'
        ? <div className="il-loading">{t('The value is null.')}</div>
        : binary
          ? <label>{t('Value')}<textarea aria-label={t('Value')} className="resource-value" value={options.base64Data ?? ''} onChange={(event) => patch({ base64Data: event.target.value })} /></label>
          : <label>{t('Value')}<input aria-label={t('Value')} value={options.text ?? ''} onChange={(event) => patch({ text: event.target.value })} /></label>}
      {binary && (
        <label>{t('Value is base64')}<input type="file" aria-label={t('Load value from a file')} onChange={(event) => {
          const file = event.target.files?.[0]
          if (file)
            void readFile(file).then((data) => patch({ base64Data: data }))
        }} /></label>
      )}
    </div>
  )
  return (
    <OptionsShell
      title="Edit Resource Element"
      className="resource-dialog"
      tabs={[{ label: 'Resource', content }]}
      invalid={!options.name.trim()}
      busy={busy}
      error={failure}
      onAccept={() => {
        setBusy(true)
        setFailure(undefined)
        void applyResourceElementOptions(node, options).then((written) => { setBusy(false); if (written) onClose(); else setFailure(useAppStore.getState().error) })
      }}
      onClose={onClose}
      onReset={() => { if (initial) setOptions(initial) }}
    />
  )
}

interface CreateResourceDialogProps {
  owner: TreeNode
  kind: ResourceCreateKind
  onClose(): void
}

const CREATE_TITLES: Record<ResourceCreateKind, string> = {
  file: 'Create File Resource',
  multiFile: 'Create Multi File Resource',
  assemblyLinked: 'Create Assembly Linked Resource',
  fileLinked: 'Create File Linked Resource',
  byteArray: 'Create Byte Array Resource',
  stream: 'Create Stream Resource',
  string: 'Create Resource',
}

/**
 * dnSpy's Create ... Resource commands. A file-based resource takes the file's name as its own; the
 * .resources kinds also take their name from the file, as `CreateMultiFileResourceCommand` does.
 */
export const CreateResourceDialog = ({ owner, kind, onClose }: CreateResourceDialogProps): React.JSX.Element => {
  const { t } = useLanguage()
  const createResource = useAppStore((state) => state.createResource)
  const [name, setName] = useState('')
  const [visibility, setVisibility] = useState(VISIBILITY_PUBLIC)
  const [files, setFiles] = useState<{ name: string; base64: string }[]>([])
  const [text, setText] = useState('')
  const [assembly, setAssembly] = useState('')
  const [linkedFile, setLinkedFile] = useState('')
  const [containsNoMetadata, setContainsNoMetadata] = useState(false)
  const [failure, setFailure] = useState<string>()
  const [busy, setBusy] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const fileBased = kind === 'file' || kind === 'byteArray' || kind === 'stream'
  const multiFile = kind === 'multiFile'
  const content = (
    <div className="resource-dialog-body">
      <label>{t('Name')}<input aria-label={t('Name')} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>{t('Visibility')}
        <select aria-label={t('Visibility')} value={visibility} onChange={(event) => setVisibility(Number(event.target.value))}>
          <option value={VISIBILITY_PUBLIC}>{t('Public')}</option>
          <option value={VISIBILITY_PRIVATE}>{t('Private')}</option>
        </select>
      </label>
      {fileBased && (
        <label>{t('File')}<input ref={fileInput} type="file" aria-label={t('File')} onChange={(event) => {
          const file = event.target.files?.[0]
          if (!file)
            return
          setName(file.name)
          void readFile(file).then((data) => setFiles([{ name: file.name, base64: data }]))
        }} /></label>
      )}
      {multiFile && (
        <label>{t('Files')}<input type="file" multiple aria-label={t('Files')} onChange={(event) => {
          const picked = [...(event.target.files ?? [])]
          if (picked.length > 0 && !name)
            setName(picked[0].name.replace(/\.[^.]+$/, '') + '.resources')
          void Promise.all(picked.map(async (file) => ({ name: file.name, base64: await readFile(file) }))).then(setFiles)
        }} /></label>
      )}
      {kind === 'string' && <label>{t('Value')}<input aria-label={t('Value')} value={text} onChange={(event) => setText(event.target.value)} /></label>}
      {kind === 'assemblyLinked' && <label>{t('Assembly')}<input aria-label={t('Assembly')} value={assembly} onChange={(event) => setAssembly(event.target.value)} /></label>}
      {kind === 'fileLinked' && (
        <>
          <label>{t('File name')}<input aria-label={t('File name')} value={linkedFile} onChange={(event) => setLinkedFile(event.target.value)} /></label>
          <label><input type="checkbox" checked={containsNoMetadata} onChange={(event) => setContainsNoMetadata(event.target.checked)} /> {t('File contains no metadata')}</label>
        </>
      )}
      {files.length > 0 && <div className="il-loading">{t('{count} file(s) selected.', { count: files.length })}</div>}
    </div>
  )
  const tabs: OptionsTab[] = [{ label: 'Resource', content }]
  const invalid = !name.trim()
    || (fileBased && files.length === 0)
    || (multiFile && files.length === 0)
    || (kind === 'assemblyLinked' && !assembly.trim())
    || (kind === 'fileLinked' && !linkedFile.trim())
  return (
    <OptionsShell
      title={CREATE_TITLES[kind]}
      className="resource-dialog"
      tabs={tabs}
      invalid={invalid}
      busy={busy}
      error={failure}
      onAccept={() => {
        setBusy(true)
        setFailure(undefined)
        const entries: CreateResourceEntry[] = multiFile ? files.map((file) => ({ name: file.name, base64Data: file.base64 })) : []
        void createResource(owner, {
          kind,
          name,
          attributes: visibility,
          base64Data: fileBased ? files[0]?.base64 : undefined,
          text: kind === 'string' ? text : undefined,
          assemblyFullName: kind === 'assemblyLinked' ? assembly : undefined,
          linkedFileName: kind === 'fileLinked' ? linkedFile : undefined,
          fileContainsNoMetadata: kind === 'fileLinked' ? containsNoMetadata : false,
          entries,
        }).then((written) => { setBusy(false); if (written) onClose(); else setFailure(useAppStore.getState().error) })
      }}
      onClose={onClose}
    />
  )
}

interface CreateResourceElementDialogProps {
  resourceNode: TreeNode
  onClose(): void
}

/** The New Resource command of a .resources file: an entry with a name and a value of the chosen kind. */
export const CreateResourceElementDialog = ({ resourceNode, onClose }: CreateResourceElementDialogProps): React.JSX.Element => {
  const { t } = useLanguage()
  const createResourceElement = useAppStore((state) => state.createResourceElement)
  const [kind, setKind] = useState<ResourceElementKind>('string')
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [base64Data, setBase64Data] = useState('')
  const [failure, setFailure] = useState<string>()
  const [busy, setBusy] = useState(false)
  const binary = kind === 'byteArray' || kind === 'stream' || kind === 'binary'
  const content = (
    <div className="resource-dialog-body">
      <label>{t('Name')}<input aria-label={t('Name')} value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>{t('Type')}
        <select aria-label={t('Type')} value={kind} onChange={(event) => setKind(event.target.value as ResourceElementKind)}>
          {(['string', 'boolean', 'char', 'int32', 'int64', 'single', 'double', 'decimal', 'byteArray', 'stream', 'null'] as const).map((entry) => <option key={entry} value={entry}>{t(entry)}</option>)}
        </select>
      </label>
      {kind !== 'null' && (binary
        ? <label>{t('Value')}<textarea aria-label={t('Value')} className="resource-value" value={base64Data} onChange={(event) => setBase64Data(event.target.value)} /></label>
        : <label>{t('Value')}<input aria-label={t('Value')} value={text} onChange={(event) => setText(event.target.value)} /></label>)}
      {binary && (
        <label>{t('Load value from a file')}<input type="file" aria-label={t('Load value from a file')} onChange={(event) => {
          const file = event.target.files?.[0]
          if (file)
            void readFile(file).then(setBase64Data)
        }} /></label>
      )}
    </div>
  )
  return (
    <OptionsShell
      title="Create Resource"
      className="resource-dialog"
      tabs={[{ label: 'Resource', content }]}
      invalid={!name.trim()}
      busy={busy}
      error={failure}
      onAccept={() => {
        setBusy(true)
        setFailure(undefined)
        void createResourceElement(resourceNode, { kind, name, text: kind === 'null' ? undefined : text, base64Data: kind === 'null' ? undefined : base64Data }).then((written) => {
          setBusy(false)
          if (written) onClose()
          else setFailure(useAppStore.getState().error)
        })
      }}
      onClose={onClose}
    />
  )
}

interface CreateImageListDialogProps {
  resourceNode: TreeNode
  onClose(): void
}

/** dnSpy's Create System.Windows.Forms.ImageListStreamer Resource: an empty image list named "my.ImageStream". */
export const CreateImageListDialog = ({ resourceNode, onClose }: CreateImageListDialogProps): React.JSX.Element => {
  const createResourceElement = useAppStore((state) => state.createResourceElement)
  return (
    <ImageListDialog
      title="Create System.Windows.Forms.ImageListStreamer Resource"
      name="my.ImageStream"
      onSubmit={(name, base64Data) => createResourceElement(resourceNode, { kind: 'imageListStreamer', name, base64Data })}
      onClose={onClose}
    />
  )
}
