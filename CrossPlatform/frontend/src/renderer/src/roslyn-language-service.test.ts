import { describe, it, expect, vi } from 'vitest'
import { registerRoslynLanguageService, updateDiagnostics } from './roslyn-language-service'
import type * as Monaco from 'monaco-editor'

describe('Roslyn Language Service', () => {
  it('should register completion provider', () => {
    const mockMonaco = {
      languages: {
        registerCompletionItemProvider: vi.fn(),
        registerHoverProvider: vi.fn(),
        registerSignatureHelpProvider: vi.fn(),
        registerCodeActionProvider: vi.fn(),
        CompletionItemKind: {
          Class: 6,
          Interface: 7,
          Method: 0,
          Property: 9,
          Field: 4,
          Keyword: 14,
        },
      },
    } as unknown as typeof Monaco

    registerRoslynLanguageService(mockMonaco)

    expect(mockMonaco.languages.registerCompletionItemProvider).toHaveBeenCalledWith(
      'csharp',
      expect.objectContaining({
        triggerCharacters: expect.arrayContaining(['.', '(', '<']),
        provideCompletionItems: expect.any(Function),
      })
    )
  })

  it('should register hover provider', () => {
    const mockMonaco = {
      languages: {
        registerCompletionItemProvider: vi.fn(),
        registerHoverProvider: vi.fn(),
        registerSignatureHelpProvider: vi.fn(),
        registerCodeActionProvider: vi.fn(),
        CompletionItemKind: {},
      },
    } as unknown as typeof Monaco

    registerRoslynLanguageService(mockMonaco)

    expect(mockMonaco.languages.registerHoverProvider).toHaveBeenCalledWith(
      'csharp',
      expect.objectContaining({
        provideHover: expect.any(Function),
      })
    )
  })

  it('should register signature help provider', () => {
    const mockMonaco = {
      languages: {
        registerCompletionItemProvider: vi.fn(),
        registerHoverProvider: vi.fn(),
        registerSignatureHelpProvider: vi.fn(),
        registerCodeActionProvider: vi.fn(),
        CompletionItemKind: {},
      },
    } as unknown as typeof Monaco

    registerRoslynLanguageService(mockMonaco)

    expect(mockMonaco.languages.registerSignatureHelpProvider).toHaveBeenCalledWith(
      'csharp',
      expect.objectContaining({
        signatureHelpTriggerCharacters: ['(', ','],
        provideSignatureHelp: expect.any(Function),
      })
    )
  })
})
