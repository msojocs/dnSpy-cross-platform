// The Monaco contributions a Roslyn code editor uses and the bare editor API leaves out: the suggest widget,
// the hover, parameter hints, smart select and on-type formatting. They have to be loaded before the editor is
// created, so they come with the language service module rather than with the editor that is attached to it;
// the decompiled documents and the C# Interactive window, which import neither, stay as they are.
import 'monaco-editor/editor/contrib/suggest/browser/suggestController'
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution'
import 'monaco-editor/editor/contrib/parameterHints/browser/parameterHints'
import 'monaco-editor/editor/contrib/smartSelect/browser/smartSelect'
import 'monaco-editor/editor/contrib/format/browser/formatActions'
