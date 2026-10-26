import { useRef } from "react";
import type { Confirmation } from "../logic.js";
import { Modal } from "./Modal.js";

interface ConfirmDialogProps {
  confirmation: Confirmation;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Disruptive-action confirmation. role="alertdialog", initial focus on the safe button, Esc cancels. */
export function ConfirmDialog({ confirmation, onConfirm, onCancel }: ConfirmDialogProps) {
  const safeRef = useRef<HTMLButtonElement>(null);
  return <Modal
    role="alertdialog"
    labelledBy="confirm-title"
    describedBy="confirm-body"
    initialFocus={safeRef}
    onClose={onCancel}
    className={`confirm tone-${confirmation.tone}`}
  >
    <h2 id="confirm-title">{confirmation.title}</h2>
    <div id="confirm-body" className="dialog-body">
      {confirmation.body.map((line) => <p key={line}>{line}</p>)}
    </div>
    <div className="dialog-actions">
      <button ref={safeRef} type="button" className="safe" onClick={onCancel}>{confirmation.safeLabel}</button>
      <button type="button" className={confirmation.tone === "danger" ? "danger-solid" : "warning-solid"} onClick={onConfirm}>
        {confirmation.confirmLabel}
      </button>
    </div>
  </Modal>;
}
