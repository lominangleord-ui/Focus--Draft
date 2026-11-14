import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export default function AttentionWindow({
  title,
  description,
  onClose,
  onBack,
  wide = false,
  children,
}: {
  title: string;
  description: string;
  onClose: () => void;
  onBack?: () => void;
  wide?: boolean;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const previousActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []).filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
      if (activeIndex < 0) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && activeIndex === 0) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeIndex === focusable.length - 1) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    closeButtonRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousActive?.focus();
    };
  }, []);

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLHeadingElement>(".attention-dialog-title")?.focus();
  }, [title]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="attention-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeRef.current();
      }}
    >
      <section
        ref={dialogRef}
        className={`attention-dialog-window ${wide ? "is-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="attention-dialog-title"
        aria-describedby="attention-dialog-description"
        tabIndex={-1}
      >
        <header className="attention-dialog-header">
          {onBack && (
            <button type="button" className="attention-dialog-back" onClick={onBack} aria-label="Back to Attention Guard settings" title="Back to settings">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 5-7 7 7 7M8 12h12" /></svg>
            </button>
          )}
          <div className="attention-dialog-heading-copy">
            <h2 id="attention-dialog-title" className="attention-dialog-title" tabIndex={-1}>{title}</h2>
            <p id="attention-dialog-description">{description}</p>
          </div>
          <button ref={closeButtonRef} type="button" className="attention-dialog-close" onClick={() => closeRef.current()} aria-label="Close Attention Guard window" title="Close">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </header>
        <div className="attention-dialog-body">{children}</div>
      </section>
    </div>,
    document.body,
  );
}
