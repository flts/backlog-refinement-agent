import type { CSSProperties, ReactNode } from 'react';
import { Splitter } from './Splitter';
import { maxFor } from './layout';
import type { WorkspaceLayout as Layout } from './useWorkspaceLayout';

export interface WorkspaceLayoutProps {
  layout: Layout;
  /** Disables all panels (a project mutation is running). */
  inert?: boolean;
  tree: ReactNode;
  chat: ReactNode;
  preview: ReactNode;
}

const focusText = { chat: 'Focus mode on: only the refinement chat is shown.', document: 'Focus mode on: only the document is shown.' };

/**
 * The `main` landmark: backlog tree | chat | document with keyboard-accessible splitters. Up to the mobile breakpoint
 * (860 px) the splitters are hidden and the panels are switched with the mobile tabs instead.
 */
export function WorkspaceLayout({ layout, inert, tree, chat, preview }: WorkspaceLayoutProps) {
  const { widths, limits, containerWidth, focus } = layout;
  const style = { '--tree-w': `${widths.tree}px`, '--doc-w': `${widths.doc}px` } as CSSProperties;
  return <main id="main" tabIndex={-1} ref={layout.gridRef} className={`workspace-grid ${focus ? `focus-${focus}` : ''}`} style={style} inert={inert}
    onFocus={(event) => layout.trackFocus(event.target)}>
    {tree}
    <Splitter className="splitter-tree" label="Resize backlog tree" side="start" value={widths.tree} min={limits.tree.min} max={maxFor('tree', widths, containerWidth)}
      onChange={(value) => layout.setWidth('tree', value)} onReset={() => layout.resetWidth('tree')} />
    {chat}
    <Splitter className="splitter-doc" label="Resize document panel" side="end" value={widths.doc} min={limits.doc.min} max={maxFor('doc', widths, containerWidth)}
      onChange={(value) => layout.setWidth('doc', value)} onReset={() => layout.resetWidth('doc')} />
    {preview}
    <p className="sr-only" role="status">{focus ? focusText[focus] : ''}</p>
  </main>;
}
