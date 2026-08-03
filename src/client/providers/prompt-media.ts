import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getTliveHome } from '../../shared/core/path.js';
import type { FileAttachment } from '../../shared/providers/types.js';

/**
 * Prepare prompt with image attachments.
 * Images are saved to temp files and referenced by path.
 */
export function preparePromptWithImages(
  prompt: string,
  attachments?: FileAttachment[],
  tmpImageDir?: string,
): { prompt: string; imagePaths: string[] } {
  if (!attachments?.length) {
    return { prompt, imagePaths: [] };
  }

  const imagePaths: string[] = [];
  const imgDir = tmpImageDir || join(getTliveHome(), 'tmp-images');

  try {
    mkdirSync(imgDir, { recursive: true });
    for (const att of attachments) {
      if (att.type !== 'image') continue;
      const ext =
        att.mimeType === 'image/png' ? '.png' : att.mimeType === 'image/gif' ? '.gif' : '.jpg';
      const digest = createHash('sha1').update(att.base64Data).digest('hex').slice(0, 12);
      const filePath = join(imgDir, `img-${digest}${ext}`);
      writeFileSync(filePath, Buffer.from(att.base64Data, 'base64'));
      imagePaths.push(filePath);
    }
  } catch {
    // Ignore errors creating directory or writing files.
  }

  if (imagePaths.length > 0) {
    const imageRefs = imagePaths.join('\n');
    prompt = `[User sent ${imagePaths.length} image(s) — read them to see the content]\n${imageRefs}\n\n${prompt}`;
  }

  return { prompt, imagePaths };
}
