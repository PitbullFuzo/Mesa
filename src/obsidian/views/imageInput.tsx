import { useState, type ClipboardEvent, type DragEvent } from 'react';
import type { WorkspaceActions } from '../../core/workspace';
import type { ImageAttachment } from '../../core/images';
import { acceptImageTransfer } from '../images';

export function useImageInput(workspace: WorkspaceActions, disabled: boolean) {
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState('');
  async function receive(files: File[], preventDefault: () => void) {
    if (!files.length) return;
    preventDefault();
    if (disabled) return;
    setPending((value) => value + 1);
    setError('');
    try {
      await acceptImageTransfer(
        files,
        () => {},
        (file) => workspace.saveImage(file),
        (image) => setImages((value) => [...value, image]),
        setError,
      );
    } finally {
      setPending((value) => value - 1);
    }
  }
  return {
    images,
    saving: pending > 0,
    error,
    clear: () => setImages([]),
    remove: (path: string) =>
      setImages((value) => value.filter((image) => image.path !== path)),
    handlers: {
      onPaste: (event: ClipboardEvent) => {
        void receive(Array.from(event.clipboardData.files), () =>
          event.preventDefault(),
        );
      },
      onDrop: (event: DragEvent) => {
        void receive(Array.from(event.dataTransfer.files), () =>
          event.preventDefault(),
        );
      },
      onDragOver: (event: DragEvent) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      },
    },
  };
}
export function AttachmentPreviews({
  images,
  onRemove,
}: {
  images: ImageAttachment[];
  onRemove: (path: string) => void;
}) {
  if (!images.length) return null;
  return (
    <div className="agenthq-attachments">
      {images.map((image) => (
        <figure key={image.path}>
          <img src={image.url} alt="Image attachment" />
          <figcaption>
            {image.path.split('/').at(-1)}{' '}
            <button
              type="button"
              aria-label={`Remove ${image.path.split('/').at(-1)}`}
              onClick={() => onRemove(image.path)}
            >
              Remove
            </button>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
