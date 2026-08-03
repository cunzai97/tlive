/**
 * Pi Ask Bridge — bridges Pi's ask tool (ctx.ui.select/input) to tlive's
 * SDK ask-question handler so that Pi's `ask` tool works through Feishu/Lark.
 */

import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import type { AskUserQuestionHandler } from '../../shared/providers/types.js';

/**
 * Build a stub UIContext that bridges `select`/`input` to tlive's
 * AskUserQuestionHandler.
 *
 * The returned object is compatible with the noOpUIContext shape so the
 * extension runner's hasUI() check returns `true`, but all interactive
 * calls are forwarded to the handler instead of silently returning undefined.
 */
export function createPiAskBridge(
  handler: AskUserQuestionHandler | undefined,
  signal?: AbortSignal,
): ExtensionUIContext {
  async function ask(
    title: string,
    options?: string[],
    multiSelect?: boolean,
  ): Promise<string | undefined> {
    if (!handler) return undefined;

    const answerMap = await handler(
      [
        {
          question: title,
          header: title,
          options: options
            ? options.map((label) => ({ label, description: undefined }))
            : [],
          multiSelect: multiSelect ?? false,
        },
      ],
      signal,
    );

    return answerMap[title];
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return {
    select: async (title, opts): Promise<string | undefined> => {
      return ask(title, opts, false);
    },
    confirm: async (title, message): Promise<boolean> => {
      const answer = await ask(title, [message], false);
      return answer !== undefined;
    },
    input: async (title): Promise<string | undefined> => {
      return ask(title, undefined, false);
    },
    notify: (_message: string, _type?: 'info' | 'warning' | 'error'): void => {},
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: <T>() => Promise.resolve(undefined as T),
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => '',
    editor: () => Promise.resolve(undefined) as ReturnType<ExtensionUIContext['editor']>,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    get theme() {
      return undefined as unknown as ExtensionUIContext['theme'];
    },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: 'UI not available' }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  } satisfies ExtensionUIContext as unknown as ExtensionUIContext;
}
