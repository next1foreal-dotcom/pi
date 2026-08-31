export type Camera = {
  x: number;
  y: number;
  z: number;
};

export type Point = {
  x: number;
  y: number;
};

export type Size = {
  width: number;
  height: number;
};

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Mode = "explore" | "focus" | "fill";

export type ScreenLayout = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PersistedV1 = {
  camera: Camera;
  screens: Record<string, Partial<ScreenLayout>>;
  canvasColor?: string;
  savedColors?: string[];
};
