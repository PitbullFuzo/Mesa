/** Jumps straight to the newest message, with no animation. */
export function scrollToLatest(panel: {
  scrollTop: number;
  scrollHeight: number;
}): void {
  panel.scrollTop = panel.scrollHeight;
}

/** Auto-scroll follows new messages only while the reader is already at the bottom. */
export function isAtBottom(
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
  threshold = 24,
): boolean {
  return (
    metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold
  );
}
