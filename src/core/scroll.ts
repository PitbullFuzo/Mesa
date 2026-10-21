/** Auto-scroll follows new messages only while the reader is already at the bottom. */
export function isAtBottom(
  metrics: { scrollTop: number; scrollHeight: number; clientHeight: number },
  threshold = 24,
): boolean {
  return (
    metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold
  );
}
