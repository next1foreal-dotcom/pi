/**
 * The pane chrome — a stand-in for the Studio's `PaneShell`, which is not
 * ported because it pulls `lucide-react` in behind it and the lab has no icon
 * dependency. Same anatomy: a title bar, a `[data-pane-actions]` cluster the
 * stylesheet dims on unfocused panes, and a scrolling body.
 *
 * The close glyph is a text "×", not an icon component, for the same reason.
 */

import type { ReactNode } from "react";

export function PaneBox({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="mos-box">
      <div className="mos-box-bar">
        <span className="mos-box-title">{title}</span>
        <span className="mos-box-actions" data-pane-actions>
          <button
            type="button"
            className="mos-box-btn"
            aria-label={`Close ${title}`}
            onClick={onClose}
          >
            ×
          </button>
        </span>
      </div>
      <div className="mos-box-body">{children}</div>
    </div>
  );
}
