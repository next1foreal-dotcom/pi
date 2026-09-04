import type { LabPlugin } from "../../plugin-api";

/**
 * Live proof that a plugin is just a folder.
 *
 * This one imports nothing from the lab's core, owns no host in the JSX, and
 * was added without editing lab-view: press P in explore mode and the pointer's
 * page coordinates follow the cursor. Delete the folder and it is gone.
 */
export const plugin: LabPlugin = {
  id: "coords",
  order: 40,
  mount(ctx) {
    let on = false;
    const chip = document.createElement("div");
    chip.dataset.labChrome = "";
    chip.style.cssText = [
      "position:absolute",
      "left:0",
      "top:0",
      "display:none",
      "pointer-events:none",
      "background:#1c1c1c",
      "color:#fff",
      "font:500 11px/1 Inter, system-ui, sans-serif",
      "padding:4px 6px",
      "border-radius:4px",
      "transform:translate(14px, 14px)",
      "z-index:30",
    ].join(";");
    ctx.host.appendChild(chip);

    const onMove = (e: PointerEvent) => {
      if (!on) return;
      const cam = ctx.getCamera();
      const origin = ctx.getOrigin();
      // Same conversion the lab uses: (screen - origin) / z - camera.
      const x = (e.clientX - origin.x) / cam.z - cam.x;
      const y = (e.clientY - origin.y) / cam.z - cam.y;
      chip.textContent = `${Math.round(x)}, ${Math.round(y)}`;
      chip.style.left = `${e.clientX - origin.x}px`;
      chip.style.top = `${e.clientY - origin.y}px`;
    };
    window.addEventListener("pointermove", onMove);

    return {
      handleKey(e) {
        if (e.code !== "KeyP") return false;
        if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
        on = !on;
        chip.style.display = on ? "block" : "none";
        return true;
      },
      destroy() {
        window.removeEventListener("pointermove", onMove);
        chip.remove();
      },
    };
  },
};
