import SamanthaLanding from "./page";

export const name = "Landing · desktop";
export const width = 1440;
/*
 * Framer's model, and the one the artboard already supports: the frame is a
 * WINDOW and the page scrolls inside it. Declaring the whole page height here
 * would make a 3760px artboard you have to zoom out to read instead.
 *
 * The page itself lives in ./page.tsx because three artboards render it —
 * desktop, tablet, phone. Resizing any of those frames on the canvas is the
 * responsive test: the page reads its width from the frame it is in, so there
 * is no viewport switcher to keep in sync and no device chrome to fake.
 */
export const height = 900;
export const position = { x: 5160, y: 1140 };

export default function LandingDesktop() {
	return <SamanthaLanding />;
}
