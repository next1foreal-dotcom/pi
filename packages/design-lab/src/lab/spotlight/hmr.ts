type Listener = () => void;

const listeners = new Set<Listener>();

export function subscribeScreenHotUpdate(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function notifyScreenHotUpdate(): void {
  for (const fn of listeners) fn();
}
