import { useState } from "react";
import { useScreen } from "../../lab/screen-context";
import LiveCanvas from "./canvas";
import "./styles/wireframe.css";

export const name = "loora landing (wireframe)";
export const width = 1440;
export const height = 900;
export const position = { x: 3400, y: 0 };

/*
 * Wireframe v2 after returned gate. The page is the canvas.
 * HUD is edge type. Look-pass 1 cut the leftover hero sentence.
 */

const CMD = "npm install && npm run dev";

export default function LooraLandingWireframe() {
  const { frameSize, active } = useScreen();
  const narrow = frameSize.width < 720;
  const [copied, setCopied] = useState(false);

  const onRun = async () => {
    try {
      await navigator.clipboard.writeText(CMD);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      className={narrow ? "wf-page is-narrow" : "wf-page"}
      style={{ height: frameSize.height }}
    >
      <h1 className="sr-only">loora — 本地无限矢量画布</h1>
      <LiveCanvas />

      <div className="wf-mark" data-hud>
        loora
      </div>
      <p className="wf-fact" data-hud>
        本地无限画布。agent 落真节点,你能拖。
        <span>无账号 · 无服务器 · 无遥测</span>
      </p>
      <a
        className="wf-link"
        data-hud
        href="https://github.com/next1foreal/brilliant-local"
      >
        源码
      </a>
      <p className="wf-hint" data-hud>
        拖空白平移 · 滚轮缩放 · 点空白落一个矩形
        {active ? "" : " · 双击画面进入"}
      </p>
      <button type="button" className="wf-cmd" data-hud onClick={onRun}>
        <code>{CMD}</code>
        <span>{copied ? "已复制" : "本机运行"}</span>
      </button>
    </div>
  );
}
