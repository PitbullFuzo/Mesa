import { codeBlockSummary, languageOf } from '../../core/codeBlocks';

/**
 * Wraps each rendered code block with a header: its language and line count, Show/Hide for long blocks, and Copy.
 * Display only: the rendered text is moved, never changed, and the note on disk is untouched. While a reply
 * streams, the last block stays open until its closing fence arrives.
 */
export function collapseCodeBlocks(
  root: HTMLElement,
  streaming: boolean,
): void {
  const blocks = Array.from(root.querySelectorAll('pre'));
  blocks.forEach((pre, index) => {
    const parent = pre.parentElement;
    if (!parent || parent.classList.contains('agenthq-code')) return;
    const code = pre.querySelector('code') ?? pre;
    const text = (code.textContent ?? '').replace(/\n$/, '');
    const summary = codeBlockSummary(
      text,
      languageOf([...Array.from(pre.classList), ...Array.from(code.classList)]),
    );
    const openForNow = streaming && index === blocks.length - 1;
    const collapsible = summary.collapsible && !openForNow;

    const wrapper = parent.createDiv({ cls: 'agenthq-code' });
    parent.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);

    const header = wrapper.createDiv({ cls: 'agenthq-code-header' });
    const label = header.createSpan();
    const setLabel = (collapsed: boolean) =>
      label.setText(summary.header(collapsed));

    if (collapsible) {
      const toggle = header.createEl('button', { type: 'button' });
      const setCollapsed = (collapsed: boolean) => {
        wrapper.classList.toggle('is-collapsed', collapsed);
        toggle.setText(collapsed ? 'Show' : 'Hide');
        setLabel(collapsed);
      };
      toggle.addEventListener('click', () =>
        setCollapsed(!wrapper.classList.contains('is-collapsed')),
      );
      setCollapsed(true);
    } else {
      setLabel(false);
    }

    const copy = header.createEl('button', { type: 'button', text: 'Copy' });
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(text).then(
        () => {
          copy.setText('Copied');
          window.setTimeout(() => copy.setText('Copy'), 1500);
        },
        () => {
          // A refused clipboard leaves the button as it is; the text is still on screen.
        },
      );
    });

    wrapper.insertBefore(header, pre);
  });
}
