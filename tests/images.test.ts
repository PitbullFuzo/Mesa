import { expect, it } from 'vitest';
import {
  validateImage,
  imageMessage,
  MAX_IMAGE_BYTES,
} from '../src/core/images';

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
it.each([
  ['png', png],
  ['jpg', Uint8Array.from([255, 216, 255])],
  ['gif', new TextEncoder().encode('GIF89a')],
  ['webp', new TextEncoder().encode('RIFF0000WEBP')],
])('accepts %s image signatures', (extension, bytes) => {
  expect(validateImage({ type: '', size: bytes.length }, bytes)).toBe(
    extension,
  );
});
it('refuses non-images, mismatched declared sizes and files over 10 MiB', () => {
  expect(() => validateImage({ type: 'text/plain', size: 8 }, png)).toThrow(
    'PNG, JPEG, GIF or WebP',
  );
  expect(() =>
    validateImage(
      { type: 'image/png', size: 4 },
      new TextEncoder().encode('nope'),
    ),
  ).toThrow('PNG, JPEG, GIF or WebP');
  expect(() =>
    validateImage({ type: 'image/png', size: MAX_IMAGE_BYTES + 1 }, png),
  ).toThrow('10 MB');
  expect(() => validateImage({ type: 'image/png', size: 9 }, png)).toThrow(
    'size',
  );
});
it('adds visible embeds without exposing agent-only Read hints', () => {
  expect(imageMessage('hello', [], 'HQ')).toBe('hello');
  const message = imageMessage(
    'Look',
    [{ path: 'HQ/Attachments/image-123.png', url: 'app://img' }],
    'HQ',
  );
  expect(message).toBe('Look\n\n![[HQ/Attachments/image-123.png]]');
  expect(() =>
    imageMessage(
      'Look',
      [{ path: 'HQ/Attachments/../../private.png', url: '' }],
      'HQ',
    ),
  ).toThrow('attachment');
});
