import { createContext, useContext } from "react";

export type ScreenState = {
  screenId: string;
  active: boolean;
  visible: boolean;
  frameSize: { width: number; height: number };
  zoom: number;
  clientToFrame: (p: { clientX: number; clientY: number }) => {
    x: number;
    y: number;
  };
  setEscapeInterceptor: (fn: (() => boolean) | null) => void;
};

const ScreenContext = createContext<ScreenState | null>(null);

export const ScreenProvider = ScreenContext.Provider;

export function useScreen(): ScreenState {
  const ctx = useContext(ScreenContext);
  if (!ctx) {
    throw new Error("useScreen() must be used inside a lab screen frame");
  }
  return ctx;
}
