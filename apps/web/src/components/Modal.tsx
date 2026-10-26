import { type ReactNode, type RefObject, useEffect, useRef } from "react";

interface ModalProps {
  labelledBy: string;
  describedBy?: string;
  /** "alertdialog" for disruptive confirmations. */
  role?: "dialog" | "alertdialog";
  /** Receives focus when the dialog opens. For a confirmation this is the safe button. */
  initialFocus: RefObject<HTMLElement | null>;
  /** Esc and every cancel path. The caller unmounts the modal and restores focus to the opener. */
  onClose: () => void;
  className?: string;
  children: ReactNode;
}

/**
 * Native modal <dialog>: showModal() makes the rest of the page inert, so Tab stays inside the dialog, and Esc fires
 * `cancel`. Mounted only while open.
 */
export function Modal({ labelledBy, describedBy, role = "dialog", initialFocus, onClose, className, children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;
    if (!dialog.open) dialog.showModal();
    initialFocus.current?.focus();
    return () => { if (dialog.open) dialog.close(); };
    // Opening is a mount-time effect only; later renders must not move focus.
  }, []);

  return <dialog
    ref={ref}
    className={className ? `modal ${className}` : "modal"}
    role={role === "alertdialog" ? "alertdialog" : undefined}
    aria-modal="true"
    aria-labelledby={labelledBy}
    aria-describedby={describedBy}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
  >
    {children}
  </dialog>;
}
