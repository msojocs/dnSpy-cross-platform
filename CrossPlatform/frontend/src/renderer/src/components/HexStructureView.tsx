import { Fragment, useEffect, useState } from 'react'
import type { HexField, HexStructure } from '../../../shared/protocol'
import { useAppStore } from '../app-store'
import {
  bitFieldValue,
  encodeHexFieldText,
  encodeLittleEndian,
  formatHexOffset,
  hexFieldValue,
  isHexFieldError,
  withBitField,
} from '../hex-fields'
import { useLanguage } from '../localization'

/** The tree rows dnSpy shows as a form of fields: a PE header, the tables stream header and a metadata table row. */
export const HEX_STRUCTURE_KINDS = new Set(['pestructure', 'tablesstream', 'metadatarecord'])

interface FieldRowProps {
  nodeId: string
  field: HexField
}

/**
 * One field the way dnSpy's templates lay it out: its offset, its name and a box with its value that is written
 * when the box loses the focus — or on Enter — and only when the text is a value the field can hold. A flags field
 * has its bits under it, a check box each or a list for a bit field that holds a number.
 */
const FieldRow = ({ nodeId, field }: FieldRowProps): React.JSX.Element => {
  const { t } = useLanguage()
  const hexWriteBytes = useAppStore((state) => state.hexWriteBytes)
  const [text, setText] = useState(field.text)
  const encoded = encodeHexFieldText(field, text)
  const error = isHexFieldError(encoded) ? t(encoded.template, encoded.args) : undefined
  const commit = (): void => {
    if (isHexFieldError(encoded) || text === field.text)
      return
    void hexWriteBytes(nodeId, field.offset, encoded)
  }
  const value = hexFieldValue(field)
  const writeValue = (next: bigint): void => {
    if (next !== value)
      void hexWriteBytes(nodeId, field.offset, encodeLittleEndian(next, field.size))
  }
  return (
    <>
      <tr className="hex-structure-field">
        <td><input readOnly tabIndex={-1} className="hex-structure-offset" aria-label={t('Offset of {name}', { name: field.name })} value={formatHexOffset(field.offset)} /></td>
        <td><label htmlFor={`hex-field-${nodeId}-${field.offset}`}>{field.name}</label></td>
        <td>
          <input
            id={`hex-field-${nodeId}-${field.offset}`}
            className="hex-structure-value"
            aria-invalid={error !== undefined}
            title={error}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => { if (event.key === 'Enter') commit() }}
          />
        </td>
        <td>{field.note && <input readOnly tabIndex={-1} className="hex-structure-note" aria-label={t('{name} as text', { name: field.name })} value={field.note} />}</td>
      </tr>
      {field.bits && field.bits.length > 0 && (
        <tr className="hex-structure-bits">
          <td colSpan={4}>
            <div className="hex-structure-bit-grid">
              {field.bits.map((bit) => bit.values
                ? (
                  <label key={bit.bit} className="hex-structure-enum">
                    <span>{bit.name}</span>
                    <select
                      aria-label={bit.name}
                      value={bitFieldValue(value, bit).toString()}
                      onChange={(event) => writeValue(withBitField(value, bit, BigInt(event.target.value)))}
                    >
                      {/* A value no name stands for is shown as the number it is, as WPF's empty selection would not. */}
                      {!bit.values.some((entry) => BigInt(entry.value) === bitFieldValue(value, bit)) && <option value={bitFieldValue(value, bit).toString()}>{bitFieldValue(value, bit).toString()}</option>}
                      {bit.values.map((entry) => <option key={entry.value} value={String(entry.value)}>{entry.name}</option>)}
                    </select>
                  </label>
                )
                : (
                  <label key={bit.bit} className="hex-structure-flag">
                    <input type="checkbox" checked={bitFieldValue(value, bit) !== 0n} onChange={(event) => writeValue(withBitField(value, bit, event.target.checked ? 1n : 0n))} />
                    <span>{bit.name}</span>
                  </label>
                ))}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

/**
 * The document of one of dnSpy's AsmEditor hex nodes that is a structure: its fields in the order its view model
 * has them, the ones in a box of their own — the flags, a data directory — under that box's heading. Every edit is
 * a patch of the field's bytes, which undo takes back like any other, and the form reads the structure again after
 * every change to the workspace, so what it shows is always what the file holds now.
 */
export const HexStructureView = ({ nodeId }: { nodeId: string }): React.JSX.Element => {
  const { t } = useLanguage()
  const workspaceId = useAppStore((state) => state.workspaceId)
  const stateId = useAppStore((state) => state.workspaceStateId)
  const [structure, setStructure] = useState<HexStructure>()
  const [failure, setFailure] = useState<string>()

  useEffect(() => {
    if (!workspaceId)
      return
    let cancelled = false
    void window.dnSpy.getHexStructure(workspaceId, nodeId)
      .then((loaded) => { if (!cancelled) { setStructure(loaded); setFailure(undefined) } })
      .catch((reason: unknown) => { if (!cancelled) setFailure(reason instanceof Error ? reason.message : String(reason)) })
    return () => { cancelled = true }
  }, [workspaceId, nodeId, stateId])

  if (!structure)
    return <div className={failure ? 'modal-error' : 'loading-state'}>{failure ?? t('Loading...')}</div>

  // Consecutive fields of one group share its box.
  const runs: { group?: string | null; fields: HexField[] }[] = []
  for (const field of structure.fields) {
    const last = runs.at(-1)
    if (last && (last.group ?? null) === (field.group ?? null))
      last.fields.push(field)
    else
      runs.push({ group: field.group, fields: [field] })
  }
  return (
    <div className="hex-structure-view" role="form" aria-label={structure.name}>
      {runs.map((run, index) => {
        const table = (
          <table className="hex-structure-table">
            <tbody>
              {/* The key holds the value too, so a field whose bytes changed starts over from what the file says. */}
              {run.fields.map((field) => <FieldRow key={`${field.offset}:${field.name}:${field.text}`} nodeId={nodeId} field={field} />)}
            </tbody>
          </table>
        )
        return run.group
          ? <fieldset key={index} className="hex-structure-group"><legend>{run.group}</legend>{table}</fieldset>
          : <Fragment key={index}>{table}</Fragment>
      })}
    </div>
  )
}
