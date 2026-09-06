import { useScreen } from "../../lab/screen-context";
import "./styles/landing.css";

/*
 * The page itself, shared by three artboards: phone, tablet, desktop. It reads
 * its width from the artboard it is mounted in, so resizing the frame on the
 * canvas is the responsive test — no viewport switcher, no device chrome.
 */

const LOG: Array<[string, string, string, "done" | "wait" | "ask"]> = [
	["03:14", "read", "seven days of session logs · kept four decisions", "done"],
	["03:51", "wrote", "narrative/CONTEXT.md — the pricing argument", "done"],
	["04:02", "asked", "which of these two is the real constraint?", "ask"],
	["04:02", "held", "waiting on you · 5h 12m", "wait"],
	["09:20", "read", "your note on the pricing page", "done"],
	["09:22", "changed", "screens/pricing.tsx:41 — tightened the ladder", "done"],
	["09:26", "looked", "took a frame, checked it against the six", "done"],
];

const COMMITS: Array<[string, string, string]> = [
	["2026-09-06", "narrative/CONTEXT.md", "+18 −4"],
	["2026-09-05", "episodic/raw/0905.md", "+211"],
	["2026-09-05", "world/judgment-trails.md", "+7"],
	["2026-09-03", "narrative/SAMANTHA.md", "+42 −11"],
	["2026-08-31", "world/decisions.md", "+9"],
];

const HOW: Array<[string, string, string]> = [
	[
		"She reads what happened",
		"Every session you run lands in an append-only log. Nothing is edited after the fact, because everything happened.",
		"episodic/raw/",
	],
	[
		"She keeps what matters",
		"The raw log is not the memory. She distils it into a narrative you can read in one sitting, and every write is reversible.",
		"narrative/CONTEXT.md",
	],
	[
		"You keep the file",
		"Plain Markdown in a git repository on your disk. Vector and graph indexes are derived and rebuildable — delete one and you lose nothing.",
		"her-memory/",
	],
];

const RUNGS: Array<[string, string, string, boolean]> = [
	["01", "Eyes", "She looks at her own work before she calls it done, and says what she saw.", true],
	["02", "Judge", "She decides what passes and what goes back, and shows the reasoning either way.", false],
	["03", "Taste", "She knows which of two good answers is the one you would have picked.", false],
];

const NOTS: Array<[string, string]> = [
	["Not a chat you drive", "You are not the loop. She starts work you did not ask for, on a schedule you can see."],
	["Not a service", "It runs on your machine. No account, no server holding your record, no telemetry."],
	["Not a database", "The truth is files. Anything queryable is an index built from them and thrown away at will."],
	["Not model-locked", "Claude Code, Codex, her own runtime — the memory is the part that does not move."],
];

const DOT: Record<string, string> = { done: "#7d9a82", wait: "#b8a06a", ask: "#c9c5bd" };

export default function SamanthaLanding() {
	const { frameSize } = useScreen();

	return (
		<div className="lp" style={{ minHeight: frameSize.height }}>
			{/* ── nav ─────────────────────────────────────────────── */}
			<nav className="lp-nav">
				<span className="lp-wordmark">Samantha</span>
				<div className="lp-nav-links">
					<span>How it works</span>
					<span>The record</span>
					<span>Where she is</span>
					<span className="lp-nav-cta">Read the spec</span>
				</div>
			</nav>

			{/* ── act one: the proof ──────────────────────────────── */}
			<header className="lp-hero">
				<div className="lp-hero-copy">
					<div className="lp-eyebrow">
						<span className="lp-pulse" />
						awake · 6h 41m this shift
					</div>
					<h1>
						She worked
						<br />
						while you slept.
					</h1>
					<p className="lp-lede">
						Not an assistant waiting for a prompt. A colleague who reads what happened, does the work she
						can defend, and leaves the rest on your desk with the reasoning attached.
					</p>
					<div className="lp-actions">
						<span className="lp-btn">See last night</span>
						<span className="lp-btn is-ghost">Read the spec</span>
					</div>
					<p className="lp-fine">Runs on your machine · no account · no telemetry</p>
				</div>

				<div className="lp-log">
					<div className="lp-log-head">
						<span>tonight</span>
						<span className="lp-log-date">2026-09-06</span>
					</div>
					{LOG.map(([t, verb, what, kind]) => (
						<div className="lp-log-row" key={t + what}>
							<span className="lp-log-time">{t}</span>
							<span className="lp-log-dot" style={{ background: DOT[kind] }} />
							<span className="lp-log-verb">{verb}</span>
							<span className={kind === "wait" ? "lp-log-what is-wait" : "lp-log-what"}>{what}</span>
						</div>
					))}
					<div className="lp-log-foot">
						<span>[ PLACEHOLDER — the number that earns trust ]</span>
						<span>hours unattended, or decisions you kept</span>
					</div>
				</div>
			</header>

			{/* ── act two: the argument ───────────────────────────── */}
			<section className="lp-turn">
				<div className="lp-turn-copy">
					<h2>
						You rent the model.
						<br />
						You keep the memory.
					</h2>
					<p>
						Every model you use is a tenancy. The thing worth owning is what it learned about your work,
						and that is why it lives in plain Markdown in a git repository you control — not in a vendor's
						database and not in a context window that ends when the session does.
					</p>
					<p className="lp-turn-claim">
						Change harnesses, change models, change machines. The record comes with you.
					</p>
				</div>
				<div className="lp-commits">
					<div className="lp-commits-head">her-memory/ · last five commits</div>
					{COMMITS.map(([date, path, delta]) => (
						<div className="lp-commit" key={path}>
							<span className="lp-commit-date">{date}</span>
							<span className="lp-commit-path">{path}</span>
							<span className="lp-commit-delta">{delta}</span>
						</div>
					))}
				</div>
			</section>

			{/* ── how it works ────────────────────────────────────── */}
			<section className="lp-how">
				<div className="lp-section-head">
					<span className="lp-kicker">How it works</span>
					<h2>Three files and one rule.</h2>
					<p>
						The rule: what happened is never edited, and what she concluded is always reversible. Everything
						else follows from it.
					</p>
				</div>
				<div className="lp-how-grid">
					{HOW.map(([title, body, path], i) => (
						<article className="lp-card" key={title}>
							<span className="lp-card-n">{String(i + 1).padStart(2, "0")}</span>
							<h3>{title}</h3>
							<p>{body}</p>
							<code>{path}</code>
						</article>
					))}
				</div>
			</section>

			{/* ── act three: the ladder, on a light plate ─────────── */}
			<section className="lp-ladder">
				<div className="lp-section-head is-light">
					<span className="lp-kicker">Where she is</span>
					<h2>The goal is that you stop reading this.</h2>
					<p>
						Every other agent asks for more of your attention. This one is built to need less of it, in a
						fixed order, and to say out loud which rung it is standing on today.
					</p>
				</div>
				<div className="lp-rungs">
					{RUNGS.map(([n, title, line, here]) => (
						<div className={here ? "lp-rung is-here" : "lp-rung"} key={n}>
							<div className="lp-rung-top">
								<span className="lp-rung-n">{n}</span>
								<span className="lp-rung-title">{title}</span>
								{here && <span className="lp-rung-badge">here now</span>}
							</div>
							<p>{line}</p>
						</div>
					))}
				</div>
			</section>

			{/* ── objections ──────────────────────────────────────── */}
			<section className="lp-nots">
				<div className="lp-section-head">
					<span className="lp-kicker">Before you ask</span>
					<h2>What it is not.</h2>
				</div>
				<div className="lp-nots-grid">
					{NOTS.map(([title, body]) => (
						<div className="lp-not" key={title}>
							<h3>{title}</h3>
							<p>{body}</p>
						</div>
					))}
				</div>
			</section>

			{/* ── start ───────────────────────────────────────────── */}
			<section className="lp-start">
				<h2>Start with one night.</h2>
				<p>
					Point her at a repository, go to bed, and read what she did in the morning. If the log is not worth
					your time, you have lost a night and kept the files.
				</p>
				<div className="lp-cmd">
					<span className="lp-cmd-prompt">$</span>
					<span className="lp-cmd-text">npm install &amp;&amp; npm run her</span>
					<span className="lp-cmd-copy">copy</span>
				</div>
				<p className="lp-fine">
					[ PLACEHOLDER — the honest state of this: alpha, private beta, or open? ]
				</p>
			</section>

			<footer className="lp-foot">
				<span>Samantha</span>
				<span>Own the memory · borrow the harness</span>
				<span>[ links ]</span>
			</footer>
		</div>
	);
}
