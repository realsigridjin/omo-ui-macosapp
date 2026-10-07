/**
 * Open state of the project picker, shared by `useNewSessionFlow()`, which requests it, and `<ProjectPickerHost/>`,
 * which renders it. A request stays pending until the host settles it with the started thread id, or with null when
 * the picker was dismissed.
 */
interface PendingRequest {
  promise: Promise<string | null>;
  resolve(threadId: string | null): void;
}

let pending: PendingRequest | null = null;
let hosts = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export const projectPicker = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  isOpen: (): boolean => pending !== null,
  /** True while a host is mounted; without one the new-session flow keeps the native folder picker. */
  hasHost: (): boolean => hosts > 0,
  /** Registers a mounted host; the returned cleanup dismisses a request still pending when the last host unmounts. */
  registerHost(): () => void {
    hosts += 1;
    return () => {
      hosts -= 1;
      if (hosts === 0) projectPicker.settle(null);
    };
  },
  /** Opens the picker; resolves the started thread id, or null when dismissed. A call while it is open joins that request. */
  request(): Promise<string | null> {
    if (pending !== null) return pending.promise;
    let resolve: PendingRequest["resolve"] = () => undefined;
    const promise = new Promise<string | null>((done) => {
      resolve = done;
    });
    pending = { promise, resolve };
    emit();
    return promise;
  },
  /** Closes the picker and resolves its request; does nothing while it is closed. */
  settle(threadId: string | null): void {
    if (pending === null) return;
    const { resolve } = pending;
    pending = null;
    emit();
    resolve(threadId);
  },
};
