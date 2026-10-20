import type { languages } from 'monaco-editor'

const opcodes = [
  'add', 'add.ovf', 'add.ovf.un', 'and', 'arglist', 'beq', 'beq.s', 'bge', 'bge.s', 'bge.un', 'bge.un.s',
  'bgt', 'bgt.s', 'bgt.un', 'bgt.un.s', 'ble', 'ble.s', 'ble.un', 'ble.un.s', 'blt', 'blt.s', 'blt.un',
  'blt.un.s', 'bne.un', 'bne.un.s', 'box', 'br', 'br.s', 'break', 'brfalse', 'brfalse.s', 'brtrue',
  'brtrue.s', 'call', 'calli', 'callvirt', 'castclass', 'ceq', 'cgt', 'cgt.un', 'ckfinite', 'clt', 'clt.un',
  'constrained.', 'conv.i', 'conv.i1', 'conv.i2', 'conv.i4', 'conv.i8', 'conv.ovf.i', 'conv.ovf.i.un',
  'conv.ovf.i1', 'conv.ovf.i1.un', 'conv.ovf.i2', 'conv.ovf.i2.un', 'conv.ovf.i4', 'conv.ovf.i4.un',
  'conv.ovf.i8', 'conv.ovf.i8.un', 'conv.ovf.u', 'conv.ovf.u.un', 'conv.ovf.u1', 'conv.ovf.u1.un',
  'conv.ovf.u2', 'conv.ovf.u2.un', 'conv.ovf.u4', 'conv.ovf.u4.un', 'conv.ovf.u8', 'conv.ovf.u8.un',
  'conv.r.un', 'conv.r4', 'conv.r8', 'conv.u', 'conv.u1', 'conv.u2', 'conv.u4', 'conv.u8', 'cpblk', 'cpobj',
  'div', 'div.un', 'dup', 'endfilter', 'endfinally', 'initblk', 'initobj', 'isinst', 'jmp', 'ldarg', 'ldarg.0',
  'ldarg.1', 'ldarg.2', 'ldarg.3', 'ldarg.s', 'ldarga', 'ldarga.s', 'ldc.i4', 'ldc.i4.0', 'ldc.i4.1',
  'ldc.i4.2', 'ldc.i4.3', 'ldc.i4.4', 'ldc.i4.5', 'ldc.i4.6', 'ldc.i4.7', 'ldc.i4.8', 'ldc.i4.m1',
  'ldc.i4.s', 'ldc.i8', 'ldc.r4', 'ldc.r8', 'ldelem', 'ldelem.i', 'ldelem.i1', 'ldelem.i2', 'ldelem.i4',
  'ldelem.i8', 'ldelem.r4', 'ldelem.r8', 'ldelem.ref', 'ldelem.u1', 'ldelem.u2', 'ldelem.u4', 'ldelema',
  'ldfld', 'ldflda', 'ldftn', 'ldind.i', 'ldind.i1', 'ldind.i2', 'ldind.i4', 'ldind.i8', 'ldind.r4',
  'ldind.r8', 'ldind.ref', 'ldind.u1', 'ldind.u2', 'ldind.u4', 'ldlen', 'ldloc', 'ldloc.0', 'ldloc.1',
  'ldloc.2', 'ldloc.3', 'ldloc.s', 'ldloca', 'ldloca.s', 'ldnull', 'ldobj', 'ldsfld', 'ldsflda', 'ldstr',
  'ldtoken', 'ldvirtftn', 'leave', 'leave.s', 'localloc', 'mkrefany', 'mul', 'mul.ovf', 'mul.ovf.un', 'neg',
  'newarr', 'newobj', 'no.', 'nop', 'not', 'or', 'pop', 'readonly.', 'refanytype', 'refanyval', 'rem',
  'rem.un', 'ret', 'rethrow', 'shl', 'shr', 'shr.un', 'sizeof', 'starg', 'starg.s', 'stelem', 'stelem.i',
  'stelem.i1', 'stelem.i2', 'stelem.i4', 'stelem.i8', 'stelem.r4', 'stelem.r8', 'stelem.ref', 'stfld',
  'stind.i', 'stind.i1', 'stind.i2', 'stind.i4', 'stind.i8', 'stind.r4', 'stind.r8', 'stind.ref', 'stloc',
  'stloc.0', 'stloc.1', 'stloc.2', 'stloc.3', 'stloc.s', 'stobj', 'stsfld', 'sub', 'sub.ovf', 'sub.ovf.un',
  'switch', 'tail.', 'throw', 'unaligned.', 'unbox', 'unbox.any', 'volatile.', 'xor',
]

const directives = [
  '.addon', '.algorithm', '.assembly', '.backing', '.class', '.corflags', '.custom', '.data', '.emitbyte',
  '.entrypoint', '.event', '.export', '.field', '.file', '.fire', '.get', '.hash', '.imagebase', '.interfaceimpl', '.language',
  '.line', '.locale', '.locals', '.manifestres', '.maxstack', '.method', '.module', '.mresource', '.namespace',
  '.other', '.override', '.pack', '.param', '.permission', '.permissionset', '.property', '.publickey',
  '.publickeytoken', '.removeon', '.set', '.size', '.stackreserve', '.subsystem', '.try', '.ver', '.vtentry',
  '.vtfixup', '.zeroinit',
]

const typeKeywords = [
  'bool', 'char', 'class', 'float32', 'float64', 'int', 'int8', 'int16', 'int32', 'int64', 'native', 'object',
  'string', 'typedref', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'unsigned', 'valuetype', 'void',
]

const modifiers = [
  'abstract', 'aggressiveinlining', 'aggressiveoptimization', 'algorithm', 'alignment', 'ansi', 'any', 'assembly',
  'auto', 'autochar', 'beforefieldinit', 'bestfit', 'byreflike', 'bytearray', 'catch', 'charmaperror', 'constraint', 'cdecl', 'cil', 'default', 'endfault', 'endfilter', 'endfinally', 'enum', 'error',
  'explicit', 'extends', 'extern', 'famandassem', 'family', 'famorassem', 'fault', 'field', 'filter', 'final', 'finally',
  'flags', 'forwarder', 'forwardref', 'fromunmanaged', 'handler', 'hidebysig', 'hresult', 'implements', 'implicitcom', 'import', 'in',
  'init', 'initonly', 'instance', 'interface', 'internalcall', 'literal', 'managed', 'marshal', 'method', 'modopt', 'modreq',
  'nested', 'newslot', 'noinlining', 'nomangle', 'nometadata', 'noncasdemand', 'noncasinheritance',
  'noncaslinkdemand', 'nooptimization', 'notserialized', 'nullref', 'opt', 'out', 'permitonly', 'pinned', 'pinvokeimpl', 'preservesig',
  'private', 'privatescope', 'property', 'public', 'reqsecobj', 'request', 'reqmin', 'reqopt', 'reqrefuse', 'rtspecialname', 'runtime',
  'securitymitigations', 'sealed', 'sequential', 'serializable', 'specialname', 'static', 'stdcall', 'strict',
  'struct', 'synchronized', 'thiscall', 'tls', 'to', 'try', 'type', 'unicode', 'unmanaged', 'unmanagedexp', 'vararg',
  'virtual', 'winapi', 'windowsruntime',
]

export const ilLanguage: languages.IMonarchLanguage = {
  defaultToken: '',
  ignoreCase: true,
  tokenPostfix: '.il',
  opcodes,
  directives,
  typeKeywords,
  modifiers,
  tokenizer: {
    root: [
      [/[ \t\r\n]+/, ''],
      [/\/\//, 'comment', '@lineComment'],
      [/\/\*/, 'comment', '@blockComment'],
      [/(<Module>)(\{)([^}\r\n]+)(\})(::)([a-z_$?@<][\w$?@.`<>]*)/, [
        'type.identifier', '@brackets', 'constant.module-id', '@brackets', 'delimiter', 'identifier.member',
      ]],
      [/(<Module>)(\{)([^}\r\n]+)(\})/, [
        'type.identifier', '@brackets', 'constant.module-id', '@brackets',
      ]],
      [/\.[a-z_][\w.]*/, {
        cases: {
          '@directives': 'keyword.directive',
          '@default': 'identifier.member',
        },
      }],
      [/\bIL_[0-9a-f]+\b(?=:?)/, 'constant.offset'],
      [/\b(?:V|A)_[0-9]+\b/, 'variable'],
      [/\[[^\]\r\n]+\]/, 'type.identifier'],
      [/"/, 'string', '@string'],
      // ilasm quotes a name that is no identifier in single quotes (`'<Code>k__BackingField'`); strings take double.
      [/'(?:[^'\\]|\\.)*'/, 'identifier.member'],
      [/0x[0-9a-f]+|[0-9a-f]{8}(?=\s*\})/, 'number.hex'],
      [/[+-]?(?:\d+\.\d*|\.\d+)(?:e[+-]?\d+)?/, 'number.float'],
      [/[+-]?\d+/, 'number'],
      [/([a-z_$?@<][\w$?@.`<>]*)(::)([a-z_$?@<][\w$?@.`<>]*)/, ['type.identifier', 'delimiter', 'identifier.member']],
      [/<Module>/, 'type.identifier'],
      [/<[^>\r\n]+>[\w$?@.`]*/, 'identifier.member'],
      // A name before a parenthesis is a method's — unless it is a keyword that takes one: `.locals init (`,
      // `marshal(`, `modopt(`, `pinvokeimpl(`.
      [/[a-z_$?@<][\w$?@.`<>]*(?=\s*\()/, {
        cases: {
          '@typeKeywords': 'type.keyword',
          '@modifiers': 'keyword.modifier',
          '@default': 'identifier.member',
        },
      }],
      [/[a-z_$?@<][\w$?@`<>]*(?:\.[a-z_$?@<][\w$?@`<>]*)+/, 'type.identifier'],
      [/[a-z_$?@][\w$?@`]*(?:<[^>\r\n]+>)/, 'type.identifier'],
      [/[a-z_$?@][\w$?@.`]*/, {
        cases: {
          '@opcodes': 'keyword.opcode',
          '@typeKeywords': 'type.keyword',
          '@modifiers': 'keyword.modifier',
          '@default': 'identifier',
        },
      }],
      [/[{}()[\]]/, '@brackets'],
      [/[,.:=*&<>+\-/]/, 'delimiter'],
    ],
    lineComment: [
      [/.+$/, 'comment', '@pop'],
      [/$/, 'comment', '@pop'],
    ],
    blockComment: [
      [/[^*/]+/, 'comment'],
      [/\/\*/, 'comment', '@push'],
      [/\*\//, 'comment', '@pop'],
      [/[*/]/, 'comment'],
    ],
    string: [
      [/[^"\\]+/, 'string'],
      [/\\(?:[abfnrtv\\"']|u[0-9a-f]{4}|x[0-9a-f]+|[0-7]{1,3})/, 'string.escape'],
      [/\\./, 'string.escape.invalid'],
      [/"/, 'string', '@pop'],
    ],
  },
}

export const ilLanguageConfiguration: languages.LanguageConfiguration = {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [['{', '}'], ['[', ']'], ['(', ')']],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"', notIn: ['string', 'comment'] },
    { open: "'", close: "'", notIn: ['string', 'comment'] },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
  folding: { markers: { start: /^\s*\/\/\s*#?region\b/, end: /^\s*\/\/\s*#?endregion\b/ } },
}
