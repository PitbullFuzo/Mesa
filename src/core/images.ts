export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export interface ImageAttachment {
  path: string;
  url: string;
}
export function validateImage(
  file: { type: string; size: number },
  bytes: Uint8Array,
): string {
  if (file.size > MAX_IMAGE_BYTES || bytes.length > MAX_IMAGE_BYTES)
    throw new Error('Images must be 10 MB or smaller.');
  if (file.size !== bytes.length)
    throw new Error('Image size changed while reading.');
  const supported = ['', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const starts = (signature: number[]) =>
    signature.every((byte, index) => bytes[index] === byte);
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.slice(start, end));
  const extension = starts([137, 80, 78, 71, 13, 10, 26, 10])
    ? 'png'
    : starts([255, 216, 255])
      ? 'jpg'
      : ['GIF87a', 'GIF89a'].includes(ascii(0, 6))
        ? 'gif'
        : ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP'
          ? 'webp'
          : '';
  if (!supported.includes(file.type) || !extension)
    throw new Error('Only PNG, JPEG, GIF or WebP image files are supported.');
  return extension;
}
export function imageMessage(
  text: string,
  images: ImageAttachment[],
  root: string,
): string {
  if (!images.length) return text;
  const entries = images.map((image) => {
    if (
      !image.path.startsWith(`${root}/Attachments/`) ||
      !/^image-[a-z0-9-]+\.(png|jpg|gif|webp)$/.test(
        image.path.slice(`${root}/Attachments/`.length),
      )
    )
      throw new Error('Invalid image attachment path.');
    return `![[${image.path}]]`;
  });
  return [text, ...entries].filter(Boolean).join('\n\n');
}

/** Inference-only context: never persist absolute image paths in messages. */
export function imagePrompt(text: string, root: string, base: string): string {
  const paths = [
    ...new Set(
      [...text.matchAll(/!\[\[([^\]]+)\]\]/g)]
        .map((match) => match[1]!)
        .filter((path) => path.startsWith(`${root}/Attachments/`)),
    ),
  ];
  for (const path of paths) imageMessage('', [{ path, url: '' }], root);
  const hints = paths.map(
    (path) =>
      `Image file (use the Read tool to view): ${JSON.stringify(`${base.replace(/\\/g, '/').replace(/\/$/, '')}/${path}`)}`,
  );
  return [text, ...hints].join('\n\n');
}
