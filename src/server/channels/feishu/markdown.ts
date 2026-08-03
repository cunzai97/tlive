import { t, type Locale } from '../../../shared/i18n/index.js';

export function markdownToFeishu(text: string): string {
  let result = text;
  result = result.replace(/<b>(.*?)<\/b>/g, '**$1**');
  result = result.replace(/<i>(.*?)<\/i>/g, '*$1*');
  result = result.replace(/<s>(.*?)<\/s>/g, '~~$1~~');
  result = result.replace(/<code>(.*?)<\/code>/g, '`$1`');
  result = result.replace(/<a href="(.*?)">(.*?)<\/a>/g, '[$2]($1)');
  result = result.replace(/<pre>([\s\S]*?)<\/pre>/g, '```\n$1\n```');
  result = result.replace(/<\/?[^>]+>/g, '');
  return sanitizeFeishuMarkdown(result);
}

/**
 * Feishu Card markdown does not accept arbitrary Markdown image URLs. It treats
 * `![alt](url)` as an image element and expects a Feishu-uploaded image_key,
 * so external badges/images make card create/edit fail with 400. Keep the
 * information as a normal link instead.
 */
export function sanitizeFeishuMarkdown(text: string): string {
  const lines = text.split('\n');
  let inFence = false;
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line
        .replace(
          /\[!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
          (_match, alt, _imageUrl, targetUrl) => {
            const label = String(alt || '').trim() || String(targetUrl);
            return `[${label}](${targetUrl})`;
          },
        )
        .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, alt, url) => {
          const label = String(alt || '').trim();
          return label ? `[${label}](${url})` : String(url);
        });
    })
    .join('\n');
}

/**
 * Downgrade markdown headings (## Title) to bold text (**Title**).
 * Feishu Card renders headings very large; bold is more appropriate for card content.
 * Ensures a blank line before each heading for proper spacing.
 */
export function downgradeHeadings(text: string): string {
  text = sanitizeFeishuMarkdown(text);
  // Ensure blank line before heading lines (unless already blank or start of text)
  let result = text.replace(/([^\n])\n(#{1,6}\s)/g, '$1\n\n$2');
  // Convert headings to bold
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '**$1**');
  return result;
}

/** Maximum rows per table in Feishu card (platform limit ~10) */
const MAX_TABLE_ROWS = 10;

/** Maximum number of tables in a Feishu card (platform hard limit) */
const MAX_TABLES_PER_CARD = 5;

/** Match a markdown table: header + separator + data rows */
const TABLE_REGEX = /^(\|.*\|)\n(\|[-:| ]+\|)\n((?:\|.*\|\n?)+)/gm;

/**
 * Split large markdown tables into multiple smaller tables.
 * Feishu cards have a limit on table rows (~10). This function:
 * 1. Detects markdown tables in content
 * 2. Splits tables with more than MAX_TABLE_ROWS into multiple tables
 * 3. Adds a separator hint between split tables
 */
export function splitLargeTables(text: string, _locale: Locale = 'zh'): string {
  return text.replace(TABLE_REGEX, (match, headerRow, separatorRow, dataRows) => {
    const rows = dataRows
      .trim()
      .split('\n')
      .filter((r: string) => r.trim().startsWith('|'));

    if (rows.length <= MAX_TABLE_ROWS) return match;

    const tables: string[] = [];
    const header = `${headerRow}\n${separatorRow}\n`;

    for (let i = 0; i < rows.length; i += MAX_TABLE_ROWS) {
      const chunk = rows.slice(i, i + MAX_TABLE_ROWS);
      const chunkIndex = Math.floor(i / MAX_TABLE_ROWS);
      const totalChunks = Math.ceil(rows.length / MAX_TABLE_ROWS);

      if (chunkIndex === 0) {
        tables.push(header + chunk.join('\n'));
      } else {
        const hint =
          t('markdown.tableChunk')
            .replace('{index}', String(chunkIndex + 1))
            .replace('{total}', String(totalChunks)) + '\n';
        tables.push(hint + header + chunk.join('\n'));
      }
    }

    return tables.join('\n\n---\n\n');
  });
}

/**
 * Split content by table count so each chunk has at most MAX_TABLES_PER_CARD tables.
 * Returns an array of text chunks. Each chunk (except the first) starts with a
 * continuation hint. Used to avoid Feishu API error 230099 (card table number over limit).
 */
export function splitByTableCount(text: string): string[] {
  const tablePositions: number[] = [];
  const regex = new RegExp(TABLE_REGEX);

  let match: RegExpExecArray | null = regex.exec(text);
  while (match !== null) {
    tablePositions.push(match.index);
    match = regex.exec(text);
  }

  if (tablePositions.length <= MAX_TABLES_PER_CARD) {
    return [text];
  }

  const chunks: string[] = [];
  let start = 0;
  let tableIndex = 0;

  for (let i = 0; i < tablePositions.length; i++) {
    // If adding this table would exceed the limit, split before it
    if (i - tableIndex >= MAX_TABLES_PER_CARD) {
      const chunkText = text.slice(start, tablePositions[i]).trim();
      if (chunkText) {
        chunks.push(chunkText);
      }

      // Start new chunk from this table
      start = tablePositions[i];
      tableIndex = i;
    }
  }

  // Add remaining text after last split point
  if (start < text.length) {
    const remaining = text.slice(start).trim();
    if (remaining) chunks.push(remaining);
  }

  // Add continuation hint to chunks after the first
  if (chunks.length > 0) {
    const result: string[] = [chunks[0]];
    for (let i = 1; i < chunks.length; i++) {
      result.push(`**表格（续）**\n\n` + chunks[i]);
    }
    return result;
  }

  return chunks;
}
