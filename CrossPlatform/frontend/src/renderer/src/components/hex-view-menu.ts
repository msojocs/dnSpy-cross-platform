import type { HexEditField } from '../../../shared/protocol'
import { VALUE_FORMAT_CHOICES } from './HexDialogs'
import type { HexValuesFormat } from '../hex-model'
import type { MenuItem } from './edit-menu'
import type { HexCommand } from '../hex-commands'

/** What the hex view's context menu needs to know about the view when it opens. */
export interface HexViewMenuContext {
  t(message: string, values?: Record<string, string | number>): string
  hasSelection: boolean
  /** The view shows less than the whole buffer: Show All Bytes is there. */
  narrowed: boolean
  readOnly: boolean
  /** A process's memory: its bytes change, so Refresh is there (`HexBuffer.IsVolatile`). */
  volatile: boolean
  bytesPerLine: number
  valuesFormat: HexValuesFormat
  editField: HexEditField | undefined
  run(command: HexCommand): void
  dialog(kind: 'fill' | 'settings' | 'goToPosition' | 'goToMetadata' | 'select'): void
  setBytesPerLine(value: number): void
  setValuesFormat(value: HexValuesFormat): void
  copyData(kind: 'uint16' | 'uint16Be' | 'uint32Be' | 'uint64' | 'uint64Be'): void
  editFieldItem(index: number): void
  /** Entries the source's owner adds, the Memory window's Process submenu. */
  extra: MenuItem[]
}

/** Whether an Edit Field entry is checked: `(field & mask) == value`, in 64 bits. */
const isChecked = (field: HexEditField, index: number): boolean => {
  const item = field.items[index]
  return (BigInt(field.value) & BigInt(item.mask)) === BigInt(item.value)
}

/**
 * dnSpy's hex view context menu (Hex/ContextMenuCommands/Commands.cs and EditFieldCommand.cs), group by group in
 * MenuConstants order: SHOW, EDIT, MISC, COPY, OPTS and FIND, each entry with its gesture and its own rule for
 * when it is shown and when it can be clicked.
 */
export function buildHexViewMenu(ctx: HexViewMenuContext): MenuItem[] {
  const { t } = ctx
  const groups: MenuItem[][] = []
  groups.push([
    { label: t('Go to Offset...'), shortcut: 'Ctrl+G', action: () => ctx.dialog('goToPosition') },
    { label: t('Go to Metadata...'), shortcut: 'Ctrl+M', action: () => ctx.dialog('goToMetadata') },
    { label: t('Go to Code or Structure'), shortcut: 'F12', action: () => ctx.run('goToCodeOrStructure') },
    { label: t('Follow Reference'), shortcut: 'Ctrl+F12', action: () => ctx.run('followFieldValueReference') },
    { label: t('Save Selection...'), icon: 'Save', shortcut: 'Ctrl+Alt+S', disabled: !ctx.hasSelection, action: () => ctx.run('saveSelection') },
    ...(ctx.hasSelection ? [{ label: t('Show Only Selected Bytes'), shortcut: 'Ctrl+D', action: () => ctx.run('showOnlySelectedBytes') }] : []),
    ...(ctx.narrowed ? [{ label: t('Show All Bytes'), shortcut: 'Ctrl+Shift+D', action: () => ctx.run('showAllBytes') }] : []),
  ])
  const edit: MenuItem[] = []
  if (!ctx.readOnly) {
    edit.push({ label: ctx.hasSelection ? t('Clear Selected Bytes') : t('Clear Byte'), icon: 'Cancel', shortcut: 'Del', action: () => ctx.run('delete') })
    edit.push({ label: t('Fill Selection with Byte...'), icon: 'Fill', disabled: !ctx.hasSelection, action: () => ctx.dialog('fill') })
  }
  const field = ctx.editField
  if (field && field.items.length > 0) {
    edit.push({
      label: t('Edit Field'),
      submenu: field.items.map((item, index) => ({ label: item.name, checked: isChecked(field, index), action: () => ctx.editFieldItem(index) })),
    })
  }
  groups.push(edit)
  groups.push([
    ...(ctx.volatile ? [{ label: t('Refresh'), icon: 'Refresh', shortcut: 'F5', action: () => ctx.run('refresh') }] : []),
    ...ctx.extra,
  ])
  const copyEnabled = !ctx.hasSelection
  groups.push([
    {
      label: t('Copy Special'),
      icon: 'Copy',
      submenu: [
        { label: t('Copy'), icon: 'Copy', shortcut: 'Ctrl+C', disabled: copyEnabled, action: () => ctx.run('copy') },
        { label: t('Copy UTF-8 String'), shortcut: 'Ctrl+Shift+8', disabled: copyEnabled, action: () => ctx.run('copyUtf8String') },
        { label: t('Copy Unicode String'), shortcut: 'Ctrl+Shift+U', disabled: copyEnabled, action: () => ctx.run('copyUnicodeString') },
        { label: t('Copy C# Array'), shortcut: 'Ctrl+Shift+H', disabled: copyEnabled, action: () => ctx.run('copyCSharpArray') },
        { label: t('Copy Visual Basic Array'), shortcut: 'Ctrl+Shift+B', disabled: copyEnabled, action: () => ctx.run('copyVisualBasicArray') },
        { label: t('Copy Text'), shortcut: 'Ctrl+Shift+C', disabled: copyEnabled, action: () => ctx.run('copyText') },
        { label: t('Copy Offset'), shortcut: 'Ctrl+Alt+O', action: () => ctx.run('copyOffset') },
        { label: t('Copy Value'), shortcut: 'Ctrl+Shift+V', action: () => ctx.run('copyValue') },
        { label: t('Copy {format}', { format: 'UInt16' }), action: () => ctx.copyData('uint16') },
        { label: t('Copy {format}', { format: `UInt16 (${t('Big Endian')})` }), action: () => ctx.copyData('uint16Be') },
        { label: t('Copy {format}', { format: 'UInt32' }), shortcut: 'Ctrl+Shift+Q', action: () => ctx.run('copyUInt32') },
        { label: t('Copy {format}', { format: `UInt32 (${t('Big Endian')})` }), action: () => ctx.copyData('uint32Be') },
        { label: t('Copy {format}', { format: 'UInt64' }), action: () => ctx.copyData('uint64') },
        { label: t('Copy {format}', { format: `UInt64 (${t('Big Endian')})` }), action: () => ctx.copyData('uint64Be') },
        { label: t('Copy File Offset'), shortcut: 'Ctrl+Shift+O', action: () => ctx.run('copyFileOffset') },
        { label: t('Copy Absolute Offset'), shortcut: 'Ctrl+Shift+A', action: () => ctx.run('copyAbsoluteFileOffset') },
        { label: t('Copy RVA'), shortcut: 'Ctrl+Shift+R', action: () => ctx.run('copyRva') },
      ],
    },
    ...(ctx.readOnly ? [] : [{
      label: t('Paste Special'),
      icon: 'Paste',
      submenu: [
        { label: t('Paste'), icon: 'Paste', shortcut: 'Ctrl+V', action: () => ctx.run('paste') },
        { label: t('Paste (UTF-8)'), shortcut: 'Ctrl+8', action: () => ctx.run('pasteUtf8String') },
        { label: t('Paste (UTF-8 and Length)'), shortcut: 'Ctrl+K, Ctrl+8', action: () => ctx.run('pasteUtf8StringLength') },
        { label: t('Paste (Unicode)'), shortcut: 'Ctrl+U', action: () => ctx.run('pasteUnicodeString') },
        { label: t('Paste (Unicode and Length)'), shortcut: 'Ctrl+K, Ctrl+U', action: () => ctx.run('pasteUnicodeStringLength') },
        { label: t('Paste (#Blob Data)'), shortcut: 'Ctrl+B', action: () => ctx.run('pasteBlob') },
      ],
    } satisfies MenuItem]),
    {
      label: t('Select Special'),
      icon: 'Select',
      submenu: [
        { label: t('Select...'), icon: 'Select', shortcut: 'Ctrl+L', action: () => ctx.dialog('select') },
        { label: t('Select File'), shortcut: 'Ctrl+E, Ctrl+F', action: () => ctx.run('selectFile') },
        { label: t('Select Nested File'), shortcut: 'Ctrl+E, Ctrl+N', action: () => ctx.run('selectNestedFile') },
        { label: t('Select Structure'), shortcut: 'Ctrl+E, Ctrl+S', action: () => ctx.run('selectStructure') },
      ],
    },
  ])
  groups.push([
    {
      label: t('Bytes per Line'),
      submenu: [0, 8, 16, 32, 48, 64].map((value) => ({
        label: value === 0 ? t('Fit to Width') : t('{count} Bytes', { count: value }),
        checked: ctx.bytesPerLine === value,
        action: () => ctx.setBytesPerLine(value),
      })),
    },
    {
      label: t('Value Format'),
      // SettingsConstants.ValueFormatList is written in English and shown untranslated.
      submenu: VALUE_FORMAT_CHOICES.map((choice) => ({ label: choice.label, checked: ctx.valuesFormat === choice.value, action: () => ctx.setValuesFormat(choice.value) })),
    },
    { label: t('Settings...'), icon: 'Settings', action: () => ctx.dialog('settings') },
  ])
  groups.push([
    { label: t('Find'), icon: 'Search', shortcut: 'Ctrl+F', action: () => ctx.run('find') },
    { label: t('Incremental Search'), icon: 'Search', shortcut: 'Ctrl+I', action: () => ctx.run('incrementalSearchForward') },
  ])
  const items: MenuItem[] = []
  for (const group of groups) {
    if (group.length === 0)
      continue
    if (items.length > 0)
      items.push({ separator: true })
    items.push(...group)
  }
  return items
}
