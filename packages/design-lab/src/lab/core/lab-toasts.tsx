import { useSyncExternalStore } from "react";

export type Toast = {
  id: number;
  text: string;
};

type Listener = () => void;

const listeners = new Set<Listener>();
let toasts: Toast[] = [];
let nextId = 1;
const timers = new Map<number, number>();

function emit(): void {
  for (const fn of listeners) fn();
}

export function pushToast(text: string, ms = 3200): void {
  const id = nextId++;
  toasts = [...toasts, { id, text }];
  emit();
  const t = window.setTimeout(() => dismissToast(id), ms);
  timers.set(id, t);
}

export function dismissToast(id: number): void {
  const t = timers.get(id);
  if (t) window.clearTimeout(t);
  timers.delete(id);
  const next = toasts.filter((x) => x.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}

function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getSnapshot(): Toast[] {
  return toasts;
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
