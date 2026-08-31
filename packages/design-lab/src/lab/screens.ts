import type { ComponentType } from "react";

export type ScreenDef = {
  id: string;
  dir: string;
  name: string;
  width: number;
  height: number;
  defaultPosition: { x: number; y: number };
  component: ComponentType;
};

type Manifest = {
  default: ComponentType;
  name?: string;
  width?: number;
  height?: number;
  position?: { x: number; y: number };
  id?: string;
};

const modules = import.meta.glob<Manifest>("../screens/*/screen.tsx", {
  eager: true,
});

function parseDir(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 2] ?? path;
}

const seen = new Map<string, string>();

export const SCREENS: ScreenDef[] = Object.entries(modules)
  .map(([path, mod]) => {
    const dir = parseDir(path);
    let id = typeof mod.id === "string" && mod.id ? mod.id : dir;
    const prev = seen.get(id);
    if (prev) {
      console.warn(
        `[lab] duplicate screen id "${id}" (${prev} vs ${dir}); using folder name`,
      );
      id = dir;
    }
    seen.set(id, dir);
    const width = typeof mod.width === "number" ? mod.width : 1440;
    const height = typeof mod.height === "number" ? mod.height : 900;
    const position = mod.position ?? { x: 0, y: 0 };
    return {
      id,
      dir,
      name: typeof mod.name === "string" ? mod.name : dir,
      width,
      height,
      defaultPosition: { x: position.x, y: position.y },
      component: mod.default,
    };
  })
  .sort((a, b) => a.defaultPosition.x - b.defaultPosition.x);

export function screenById(id: string): ScreenDef | undefined {
  return SCREENS.find((s) => s.id === id);
}
