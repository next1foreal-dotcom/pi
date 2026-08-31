import { useScreen } from "../../lab/screen-context";
import Browse from "./components/Browse";
import "./styles/fonts.css";
import "./styles/screen.css";

export const name = "Product list";
export const width = 1440;
export const height = 900;
export const position = { x: 1640, y: 0 };

export default function ProductListScreen() {
  const { frameSize } = useScreen();
  return (
    <div
      className="product-list-root"
      style={{ width: "100%", minHeight: frameSize.height }}
    >
      <Browse />
    </div>
  );
}
