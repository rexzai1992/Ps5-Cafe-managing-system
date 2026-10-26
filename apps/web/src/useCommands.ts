import { useCallback, useRef, useState } from "react";
import { type CommandRequest, createCommandRequest, sendCommand } from "./api.js";

/** An operator intent: one click, or one confirmed dialog. `scope` is a station id, or "simulation". */
export interface Intent {
  scope: string;
  /** Identifies the control that started it, so only that control shows the pending label. */
  control: string;
  /** Short action name used in errors and announcements, e.g. "Pause". */
  title: string;
  /** Pending text, e.g. "Starting…". */
  pendingLabel: string;
  url: string;
  body: unknown;
}

export interface PendingIntent { key: string; control: string; label: string }

export interface ScopedError {
  title: string;
  message: string;
  at: number;
  /** Present only when the outcome is unknown; resending it reuses the same Idempotency-Key and body. */
  retry: { intent: Intent; request: CommandRequest } | null;
}

export interface CommandCallbacks {
  onSuccess: (intent: Intent, body: unknown) => void;
}

/**
 * The single path for every mutating request. One key is created per intent; a second intent for a scope is ignored
 * while one is in flight; errors persist per scope until dismissed or until that scope's next success.
 */
export function useCommands(callbacks: CommandCallbacks) {
  const pendingRef = useRef(new Map<string, PendingIntent>());
  const [pending, setPending] = useState<ReadonlyMap<string, PendingIntent>>(() => new Map());
  const [errors, setErrors] = useState<ReadonlyMap<string, ScopedError>>(() => new Map());
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const setError = useCallback((scope: string, error: ScopedError | null) => {
    setErrors((previous) => {
      if (!error && !previous.has(scope)) return previous;
      const next = new Map(previous);
      if (error) next.set(scope, error); else next.delete(scope);
      return next;
    });
  }, []);

  const execute = useCallback(async (intent: Intent, request: CommandRequest, label: string): Promise<boolean> => {
    // The ref, not state, is the guard: it is updated synchronously, before any re-render.
    if (pendingRef.current.has(intent.scope)) return false;
    pendingRef.current.set(intent.scope, { key: request.key, control: intent.control, label });
    setPending(new Map(pendingRef.current));
    const result = await sendCommand(request);
    pendingRef.current.delete(intent.scope);
    setPending(new Map(pendingRef.current));
    const at = Date.now();
    if (result.kind === "ok") {
      setError(intent.scope, null);
      callbacksRef.current.onSuccess(intent, result.body);
      return true;
    }
    setError(intent.scope, {
      title: intent.title,
      message: result.message,
      at,
      retry: result.kind === "retryable" ? { intent, request } : null,
    });
    return false;
  }, [setError]);

  /** Starts a new intent with a fresh Idempotency-Key. */
  const run = useCallback((intent: Intent) => execute(intent, createCommandRequest(intent.url, intent.body), intent.pendingLabel), [execute]);

  /** Resends the unanswered request for a scope with the same key and body. */
  const retry = useCallback((scope: string) => {
    const error = errors.get(scope);
    if (!error?.retry) return Promise.resolve(false);
    return execute(error.retry.intent, error.retry.request, "Retrying…");
  }, [errors, execute]);

  const dismiss = useCallback((scope: string) => setError(scope, null), [setError]);

  const isPending = useCallback((scope: string) => pendingRef.current.has(scope), []);

  return { pending, errors, run, retry, dismiss, isPending };
}

export type Commands = ReturnType<typeof useCommands>;
