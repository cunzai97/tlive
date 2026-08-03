import { describe, expect, it } from 'vitest';
import { MediaDirectiveParser } from '../../server/engine/messages/media-directive-parser.js';

describe('MediaDirectiveParser', () => {
  it('extracts a standalone media line from streamed text', () => {
    const parser = new MediaDirectiveParser();

    const visible = [
      parser.push('Generated file:\nMED'),
      parser.push('IA:/tmp/chart.png\nDone'),
      parser.finish(),
    ].join('');

    expect(visible).toBe('Generated file:\nDone');
    expect(parser.getPaths()).toEqual(['/tmp/chart.png']);
  });

  it('supports multiple paths, relative paths, spaces, and optional wrappers', () => {
    const parser = new MediaDirectiveParser();

    const visible = parser.push(
      'MEDIA: output/chart one.png\nMEDIA:`/tmp/report.pdf`\nMEDIA:"notes.txt"\n',
    );

    expect(visible).toBe('');
    expect(parser.getPaths()).toEqual([
      'output/chart one.png',
      '/tmp/report.pdf',
      'notes.txt',
    ]);
  });

  it('streams ordinary text without waiting for the whole line', () => {
    const parser = new MediaDirectiveParser();

    expect(parser.push('Meaningful response')).toBe('Meaningful response');
    expect(parser.push(' continues')).toBe(' continues');
    expect(parser.finish()).toBe('');
    expect(parser.getPaths()).toEqual([]);
  });

  it('preserves incomplete and empty directives as visible text', () => {
    const incomplete = new MediaDirectiveParser();
    expect(incomplete.push('MED')).toBe('');
    expect(incomplete.finish()).toBe('MED');

    const empty = new MediaDirectiveParser();
    expect(empty.push('MEDIA:\n')).toBe('MEDIA:\n');
    expect(empty.getPaths()).toEqual([]);
  });

  it('only recognizes MEDIA at the beginning of a line', () => {
    const parser = new MediaDirectiveParser();

    expect(parser.push('Example: MEDIA:/tmp/not-sent.png\n')).toBe(
      'Example: MEDIA:/tmp/not-sent.png\n',
    );
    expect(parser.getPaths()).toEqual([]);
  });
});
