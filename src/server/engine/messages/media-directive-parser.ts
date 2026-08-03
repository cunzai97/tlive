const MEDIA_PREFIX = 'MEDIA:';

/**
 * Extracts standalone MEDIA:<path> lines while preserving normal streamed text.
 *
 * Only the short prefix is buffered, so ordinary model output can still be rendered as it arrives
 * even when provider deltas split the directive across arbitrary boundaries.
 */
export class MediaDirectiveParser {
  private state: 'detecting' | 'text' | 'media' = 'detecting';
  private candidate = '';
  private mediaPath = '';
  private readonly paths: string[] = [];
  private finished = false;

  push(chunk: string): string {
    if (this.finished || !chunk) return '';

    let visible = '';
    for (const char of chunk) {
      if (this.state === 'text') {
        visible += char;
        if (char === '\n') this.state = 'detecting';
        continue;
      }

      if (this.state === 'media') {
        if (char === '\n') {
          visible += this.finishMediaLine(true);
          this.state = 'detecting';
        } else {
          this.mediaPath += char;
        }
        continue;
      }

      this.candidate += char;
      if (char === '\n') {
        visible += this.candidate;
        this.candidate = '';
        continue;
      }

      if (this.candidate === MEDIA_PREFIX) {
        this.candidate = '';
        this.state = 'media';
        continue;
      }
      if (MEDIA_PREFIX.startsWith(this.candidate)) continue;

      visible += this.candidate;
      this.candidate = '';
      this.state = 'text';
    }
    return visible;
  }

  finish(): string {
    if (this.finished) return '';
    this.finished = true;

    if (this.state === 'media') return this.finishMediaLine(false);
    const visible = this.candidate;
    this.candidate = '';
    return visible;
  }

  getPaths(): readonly string[] {
    return this.paths;
  }

  private finishMediaLine(hadNewline: boolean): string {
    const rawPath = this.mediaPath;
    this.mediaPath = '';
    const path = unwrapPath(rawPath.trim());
    if (path) {
      this.paths.push(path);
      return '';
    }
    return `${MEDIA_PREFIX}${rawPath}${hadNewline ? '\n' : ''}`;
  }
}

function unwrapPath(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if (
    (first === '`' && last === '`') ||
    (first === '"' && last === '"') ||
    (first === "'" && last === "'")
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}
