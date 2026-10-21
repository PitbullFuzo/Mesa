import { useEffect, useRef } from 'react';
import { Component, MarkdownRenderer, type App } from 'obsidian';
import { collapseCodeBlocks } from './codeBlocks';

/**
 * Obsidian owns markdown rendering so vault links retain native navigation. Long code blocks are collapsed
 * once rendered; while the reply streams, the last block stays open until its closing fence arrives.
 */
export function MarkdownContent({
  app,
  content,
  sourcePath,
  streaming = false,
}: {
  app: App;
  content: string;
  sourcePath: string;
  streaming?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const owner = new Component();
    owner.load();
    const target = element.createDiv();
    void MarkdownRenderer.render(app, content, target, sourcePath, owner).then(
      () => {
        if (target.isConnected) collapseCodeBlocks(target, streaming);
      },
      () => {
        // Do not log user/AI content. A detached failed render must not replace a newer one.
        if (target.isConnected) target.setText(content);
      },
    );
    return () => {
      owner.unload();
      target.remove();
    };
  }, [app, content, sourcePath, streaming]);
  return (
    <div className="agenthq-message-markdown markdown-rendered" ref={ref} />
  );
}
