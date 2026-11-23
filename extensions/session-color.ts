/**
 * /color: a per-session color profile for pi.
 *
 * Every session carries its own color. The color tints the accent-family tokens
 * (accent, borders, message backgrounds) and the thinking-level gradient that
 * colors the input-editor border, on top of whatever theme is active — dark,
 * light, system, or custom. The choice is written into the session file as a
 * custom entry, so quitting and resuming restores it, while other sessions keep
 * their own color or the default. The theme setting itself is never modified:
 * variants are in-memory Theme instances.
 */

import {
	DynamicBorder,
	Theme,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	colorToHex,
	colorToOkhsl,
	Container,
	okhslColor,
	Text,
	type AutocompleteItem,
	type Color,
	type SelectItem,
	SelectList,
} from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

/** OKHSL hues (perceptual hues — not HSL). Verified against pi-tui's gamut mapping. */
const PALETTE: Record<string, { h: number; blurb: string }> = {
	rose: { h: 350, blurb: "Soft pink-red" },
	crimson: { h: 12, blurb: "Warm red" },
	ember: { h: 25, blurb: "Burnt orange" },
	amber: { h: 75, blurb: "Honey gold" },
	lime: { h: 105, blurb: "Olive-citron" },
	emerald: { h: 145, blurb: "Classic green" },
	jade: { h: 160, blurb: "Green-teal" },
	teal: { h: 180, blurb: "Muted sea green" },
	cyan: { h: 200, blurb: "Aqua" },
	sky: { h: 220, blurb: "Light blue" },
	ocean: { h: 235, blurb: "Pi's classic blue" },
	indigo: { h: 265, blurb: "Blue-violet" },
	violet: { h: 292, blurb: "Pi's classic violet" },
	orchid: { h: 320, blurb: "Purple-pink" },
};

const ENTRY_TYPE = "session-color";
const STATUS_KEY = "session-color";
const VARIANT_PREFIX = "color:";
/** Terminal color queries settle quickly, but give slow SSH a moment on startup. */
const STARTUP_APPLY_DELAY_MS = 1500;

/** The input-editor border follows this gradient (thinking level → color). */
const THINKING_TOKENS = [
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"thinkingMax",
] as const;

// ---------------------------------------------------------------------------
// Theme variant construction
// ---------------------------------------------------------------------------

type ThemeColorsArg = ConstructorParameters<typeof Theme>[0];
type ThemeBgColorsArg = ConstructorParameters<typeof Theme>[1];

/**
 * Build an in-memory Theme that tints the active theme's identity tokens with
 * the palette hue. Idempotent: re-applying on top of a variant gives the same
 * result, because mixed backgrounds are always derived from toolPendingBg,
 * which is never overridden.
 */
function buildVariant(name: string, base: Theme): Theme | undefined {
	const pal = PALETTE[name];
	if (!pal) return undefined;

	// Start from the live theme's resolved colors (hex strings).
	const colors: Record<string, string> = {};
	for (const [token, color] of Object.entries(base.colors)) {
		colors[token] = colorToHex(color as Color);
	}

	const isDark = base.appearance !== "light";
	const accent = okhslColor(pal.h, isDark ? 0.55 : 0.6, isDark ? 0.66 : 0.45);
	const accentHex = colorToHex(accent);

	// Background tints: same hue as the accent at the base surface's lightness,
	// so they stay consistent with whatever theme is active.
	const surfaceL = colorToOkhsl(base.colors.toolPendingBg as Color).l;
	const tint = (s: number, dl = 0) => colorToHex(okhslColor(pal.h, s, Math.min(0.98, Math.max(0.02, surfaceL + dl))));

	colors.accent = accentHex;
	colors.borderAccent = accentHex;
	colors.border = colorToHex(okhslColor(pal.h, isDark ? 0.45 : 0.5, isDark ? 0.62 : 0.5));
	colors.customMessageLabel = accentHex;
	colors.mdListBullet = accentHex;
	colors.selectedBg = tint(isDark ? 0.32 : 0.28);
	colors.userMessageBg = tint(isDark ? 0.32 : 0.28);
	colors.customMessageBg = tint(isDark ? 0.4 : 0.24);

	// The input-editor border bar takes its color from the thinking-level
	// gradient (off=gray … max=intense). Shift every step to the session hue
	// while keeping its saturation and lightness, so the ramp still communicates
	// the thinking level — just in the session's color.
	for (const token of THINKING_TOKENS) {
		const channels = colorToOkhsl(base.colors[token] as Color);
		colors[token] = colorToHex(okhslColor(pal.h, channels.s, channels.l));
	}

	return new Theme(
		colors as unknown as ThemeColorsArg,
		{} as unknown as ThemeBgColorsArg,
		base.getColorMode(),
		{ name: `${VARIANT_PREFIX}${name}`, appearance: base.appearance },
	);
}

function colorChip(name: string): string {
	const hex = colorToHex(okhslColor(PALETTE[name].h, 0.55, 0.66));
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return `\x1b[38;2;${r};${g};${b}m██\x1b[39m`;
}

// ---------------------------------------------------------------------------
// Extension state + actions
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	/** The applied profile for the current session: a palette name, null (reset), or undefined (untouched). */
	let current: string | null | undefined;
	/** Name of the theme Pi derived from settings, captured before any variant is applied. */
	let defaultThemeName: string | undefined;
	let startupTimer: ReturnType<typeof setTimeout> | undefined;

	function updateStatus(name: string | null, ctx: ExtensionContext) {
		if (!name) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `● ${name}`));
	}

	/** Apply a palette color in-memory. Does not persist unless persist=true. */
	function applyColor(name: string, ctx: ExtensionContext, persist: boolean): boolean {
		const variant = buildVariant(name, ctx.ui.theme);
		if (!variant) {
			ctx.ui.notify(`Unknown color: ${name}`, "error");
			return false;
		}
		const result = ctx.ui.setTheme(variant);
		if (!result.success) {
			// Headless sessions (RPC) don't support visual theme switching; the
			// profile is still recorded so an interactive resume picks it up.
			ctx.ui.notify(`Color applied to session profile (visual apply unavailable here)`, "info");
		}
		current = name;
		updateStatus(name, ctx);
		if (persist) pi.appendEntry(ENTRY_TYPE, { name });
		return true;
	}

	/** Restore the theme Pi derived from settings (in-memory, never writes settings). */
	function resetToBase(ctx: ExtensionContext, persist = false): boolean {
		const base = defaultThemeName ? ctx.ui.getTheme(defaultThemeName) : undefined;
		if (base) {
			ctx.ui.setTheme(base);
		} else if (ctx.hasUI) {
			// Interactive session but no loadable base theme — genuine problem.
			ctx.ui.notify(defaultThemeName ? `Cannot reset: theme "${defaultThemeName}" not found` : "Cannot reset: base theme unknown", "warning");
			return false;
		}
		// Headless: record the reset without a visual apply.
		current = null;
		updateStatus(null, ctx);
		if (persist) pi.appendEntry(ENTRY_TYPE, { name: null });
		return true;
	}

	/** Read the last color entry on the active session branch. */
	function savedColor(ctx: ExtensionContext): string | null | undefined {
		let saved: string | null | undefined;
		try {
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
					saved = (entry.data as { name?: string | null })?.name ?? null;
				}
			}
		} catch {
			// Ephemeral session or unreadable entries — no persisted profile.
		}
		return saved;
	}

	// -----------------------------------------------------------------------
	// Restore on session start / resume / fork / reload
	// -----------------------------------------------------------------------

	pi.on("session_start", (event, ctx) => {
		// Capture the settings-derived theme for /color default. Never overwrite
		// it with one of our own variants (in-process /resume keeps this valid).
		const themeName = ctx.ui.theme.name;
		if (themeName && !themeName.startsWith(VARIANT_PREFIX)) {
			defaultThemeName = themeName;
		}

		const saved = savedColor(ctx);

		if (event.reason === "startup") {
			// The terminal color query may still be pending; the controller would
			// re-apply the settings theme over our variant when it lands. Apply
			// after it settles instead.
			clearTimeout(startupTimer);
			if (saved && PALETTE[saved]) {
				startupTimer = setTimeout(() => applyColor(saved, ctx, false), STARTUP_APPLY_DELAY_MS);
			}
			return;
		}

		if (saved && PALETTE[saved]) {
			applyColor(saved, ctx, false);
		} else {
			// No profile on this session (new/resume/fork/reload): show the
			// settings theme, not the previous session's color.
			resetToBase(ctx);
		}
	});

	pi.on("session_shutdown", () => {
		clearTimeout(startupTimer);
		startupTimer = undefined;
	});

	// -----------------------------------------------------------------------
	// Interactive picker with live preview
	// -----------------------------------------------------------------------

	async function openPicker(ctx: ExtensionContext) {
		if (!ctx.hasUI) {
			ctx.ui.notify("No UI: use /color <name>", "warning");
			return;
		}

		const previous = current;
		const restorePrevious = () => {
			if (typeof previous === "string") applyColor(previous, ctx, false);
			else resetToBase(ctx);
		};

		const items: SelectItem[] = [
			{ value: "__default__", label: "○ default", description: "Theme from settings" },
			...Object.entries(PALETTE).map(([name, p]) => ({
				value: name,
				label: `${colorChip(name)} ${name}${current === name ? "  ●" : ""}`,
				description: p.blurb,
			})),
		];

		const result = await ctx.ui.custom<string | null>((_tui, _theme, _keybindings, done) => {
			const container = new Container();

			container.addChild({
				render(width: number) {
					return [ctx.ui.theme.fg("accent", ctx.ui.theme.bold("Session color"))].map((l) => l.slice(0, width));
				},
				invalidate() {},
			});
			container.addChild({
				render(width: number) {
					return [ctx.ui.theme.fg("dim", "tints the active theme · arrows preview · enter applies · esc cancels")].map((l) =>
						l.slice(0, width),
					);
				},
				invalidate() {},
			});

			// Live-themed select list: theme functions resolve at render time so
			// the picker itself recolors while previewing.
			const selectList = new SelectList(
				items,
				Math.min(items.length, 12),
				{
					selectedPrefix: (text) => ctx.ui.theme.fg("accent", text),
					selectedText: (text) => ctx.ui.theme.fg("accent", text),
					description: (text) => ctx.ui.theme.fg("muted", text),
					scrollInfo: (text) => ctx.ui.theme.fg("dim", text),
					noMatch: (text) => ctx.ui.theme.fg("warning", text),
				},
			);

			selectList.onSelectionChange = (item) => {
				try {
					if (item.value === "__default__") resetToBase(ctx);
					else applyColor(item.value, ctx, false);
				} catch {
					// Preview failures keep the last applied color.
				}
			};
			selectList.onSelect = (item) => done(item.value === "__default__" ? "__default__" : item.value);
			selectList.onCancel = () => done(null);

			container.addChild(selectList);
			container.addChild(new Text("", 0, 0));
			container.addChild({
				render(width: number) {
					return [ctx.ui.theme.fg("dim", "↑↓ navigate · enter select · esc cancel")].map((l) => l.slice(0, width));
				},
				invalidate() {},
			});
			container.addChild(new DynamicBorder((str) => ctx.ui.theme.fg("accent", str)));

			return {
				capturesViewportInput: selectList.capturesViewportInput,
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					selectList.handleInput(data);
				},
				dispose() {
					selectList.onSelectionChange = undefined;
				},
			};
		});

		if (result === null) {
			// Cancelled: undo whatever was previewed.
			restorePrevious();
			return;
		}
		if (result === "__default__") {
			resetToBase(ctx, true);
			ctx.ui.notify("Session color reset to default", "info");
			return;
		}
		if (applyColor(result, ctx, true)) {
			ctx.ui.notify(`Session color: ${result}`, "info");
		}
	}

	// -----------------------------------------------------------------------
	// /color command
	// -----------------------------------------------------------------------

	const matchColor = (arg: string): string | undefined => {
		const lower = arg.toLowerCase();
		if (lower in PALETTE) return lower;
		const matches = Object.keys(PALETTE).filter((name) => name.startsWith(lower));
		return matches.length === 1 ? matches[0] : undefined;
	};

	pi.registerCommand("color", {
		description: "Change this session's color profile (persists across resume)",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const names = ["default", ...Object.keys(PALETTE)];
			const items = names.map((name) => ({
				value: name,
				label: name,
				description: name === "default" ? "Theme from settings" : PALETTE[name].blurb,
			}));
			const filtered = items.filter((item) => item.value.startsWith(prefix.toLowerCase()));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const arg = args?.trim().toLowerCase();

			if (!arg) {
				await openPicker(ctx);
				return;
			}

			if (arg === "default" || arg === "reset" || arg === "none" || arg === "off") {
				if (resetToBase(ctx, true)) ctx.ui.notify("Session color reset to default", "info");
				return;
			}

			if (arg === "list" || arg === "ls") {
				const active = typeof current === "string" ? current : "default";
				ctx.ui.notify(`Colors: ${Object.keys(PALETTE).join(", ")} · default (active: ${active})`, "info");
				return;
			}

			const name = matchColor(arg);
			if (!name) {
				const matches = Object.keys(PALETTE).filter((n) => n.startsWith(arg));
				ctx.ui.notify(
					matches.length > 1
						? `Ambiguous color "${arg}": ${matches.join(", ")}`
						: `Unknown color "${arg}". Available: ${Object.keys(PALETTE).join(", ")}, default`,
					"error",
				);
				return;
			}

			if (applyColor(name, ctx, true)) {
				ctx.ui.notify(`Session color: ${name}`, "info");
			}
		},
	});
}
