import type { CodeStatement } from '../../../shared/protocol'

/**
 * The instructions an IL view's selection covers, top to bottom: dnSpy's Copy IL Bytes reads the instruction
 * references the selection spans, and the IL view's statement table has one statement per instruction. Nothing is
 * selected in any other view, and an empty selection covers nothing — the caret alone is not enough.
 */
export const ilSelectionOf = (
  document: { language: string; codeStatements?: CodeStatement[] } | undefined,
  selection: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number; isEmpty(): boolean } | null | undefined,
): { modulePath: string; metadataToken: number; ilOffset: number }[] => {
  if (document?.language !== 'il' || !selection || selection.isEmpty())
    return []
  const before = (line: number, column: number, otherLine: number, otherColumn: number): boolean =>
    line < otherLine || (line === otherLine && column < otherColumn)
  return (document.codeStatements ?? [])
    .filter((statement) => !statement.isHidden
      && before(selection.startLineNumber, selection.startColumn, statement.endLine, statement.endColumn)
      && before(statement.startLine, statement.startColumn, selection.endLineNumber, selection.endColumn))
    .sort((left, right) => left.startLine - right.startLine || left.startColumn - right.startColumn)
    .map((statement) => ({ modulePath: statement.modulePath, metadataToken: statement.metadataToken, ilOffset: statement.ilOffset }))
}
