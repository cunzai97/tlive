import type { Button } from '../../../shared/ui/types.js';
import { buildFeishuButtonElements, type FeishuCardElement } from './card-builder.js';
import { downgradeHeadings } from './markdown.js';
import { redactSensitiveContent } from '../../../shared/utils/content-filter.js';

export interface CollapsiblePanelOptions {
  expanded?: boolean;
}

export function markdownElement(content: string): FeishuCardElement {
  return { tag: 'markdown', content: downgradeHeadings(redactSensitiveContent(content)) };
}

/**
 * A fenced markdown body is what Feishu turns into its native code block, so verbatim text
 * (model reasoning, diffs) needs one. Heading downgrading is not fence-aware and would rewrite
 * any `#` line inside the body, so this deliberately bypasses markdownElement().
 */
export function codeBlockElement(content: string): FeishuCardElement {
  const body = redactSensitiveContent(content);
  let length = 3;
  for (const run of body.matchAll(/`+/g)) length = Math.max(length, run[0].length + 1);
  const fence = '`'.repeat(length);
  return { tag: 'markdown', content: `${fence}\n${body}\n${fence}` };
}

/** Inverse of codeBlockElement: the fence and verbatim body, or undefined for plain markdown. */
export function codeBlockBody(content: string): { fence: string; body: string } | undefined {
  const match = /^(`{3,})\n([\s\S]*)\n\1$/u.exec(content);
  return match ? { fence: match[1], body: match[2] } : undefined;
}

export function buttonElements(buttons?: Button[]): FeishuCardElement[] {
  return buildFeishuButtonElements(buttons);
}

export function collapsiblePanel(
  title: string,
  elements: FeishuCardElement[],
  options: CollapsiblePanelOptions = {},
): FeishuCardElement {
  return {
    tag: 'collapsible_panel',
    expanded: options.expanded ?? false,
    header: { title: { tag: 'plain_text', content: title } },
    elements,
  };
}

export function markdownPanel(
  title: string,
  content: string,
  options?: CollapsiblePanelOptions,
): FeishuCardElement {
  return collapsiblePanel(title, [markdownElement(content)], options);
}

export function formElement(
  name: string,
  elements: FeishuCardElement[],
  buttons?: Button[],
): FeishuCardElement {
  return {
    tag: 'form',
    name,
    elements: [...elements, ...buttonElements(buttons)],
  };
}

export function dividerElement(): FeishuCardElement {
  return { tag: 'hr' };
}
