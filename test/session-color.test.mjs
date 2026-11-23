// Behaviour of /color, exercised through pi's real extension loader, session manager
// and Theme. The terminal host is stubbed; the OKHSL theme math runs for real.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions, initTheme, SessionManager, Theme } from "@earendil-works/pi-coding-agent";
import { colorToHex, colorToOkhsl, okhslColor } from "@earendil-works/pi-tui";

initTheme("dark", false);

const root = fileURLToPath(new URL("..", import.meta.url));
const OCEAN = 235;
const EMERALD = 145;
const THINKING_TOKENS = [
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"thinkingMax",
];

/** A minimal real Theme with the identity tokens /color derives from. */
function fixtureBaseTheme() {
	const colors = {
		accent: "#a695e0",
		border: "#7f86c8",
		borderAccent: "#9c86d6",
		customMessageLabel: "#a695e0",
		mdListBullet: "#a695e0",
		selectedBg: "#3a3d55",
		userMessageBg: "#3a3d55",
		customMessageBg: "#453f63",
		toolPendingBg: "#262833",
		text: "#e3e5e9",
		toolTitle: "#e3e5e9",
		muted: "#9a9db0",
		dim: "#7d8095",
		success: "#6ab38d",
		error: "#d8897b",
		warning: "#c3985d",
		scrollbarTrack: "#4a4d5c",
		scrollbarThumb: "#8f93a8",
		searchMatchBg: "#4a4430",
		searchMatchText: "#9a9db0",
		thinkingOff: "#6c767b",
		thinkingMinimal: "#68808d",
		thinkingLow: "#5489a4",
		thinkingMedium: "#6185cc",
		thinkingHigh: "#9776e5",
		thinkingXhigh: "#de54c1",
		thinkingMax: "#fe5462",
	};
	return new Theme(colors, {}, "truecolor", { name: "dark", appearance: "dark" });
}

async function setup({ branch = [] } = {}) {
	const agentDir = mkdtempSync(join(tmpdir(), "session-color-agent-"));
	const { extensions, errors, runtime } = await discoverAndLoadExtensions([join(root, "extensions/session-color.ts")], root, agentDir);
	assert.deepEqual(errors, []);
	const extension = extensions[0];

	const entries = [];
	runtime.appendEntry = (customType, data) => {
		entries.push({ customType, data });
	};

	const session = SessionManager.inMemory(root);
	for (const item of branch) session.appendCustomEntry(item.customType, item.data);

	const base = fixtureBaseTheme();
	const host = { base, entries, applied: [], notifications: [], status: undefined, session };
	host.ctx = {
		mode: "tui",
		hasUI: true,
		sessionManager: session,
		ui: {
			theme: base,
			setTheme(themeOrName) {
				host.applied.push(themeOrName);
				return { success: true };
			},
			getTheme(name) {
				return name === "dark" ? base : undefined;
			},
			notify: (message, type) => host.notifications.push({ message, type }),
			setStatus: (_key, text) => {
				host.status = text;
			},
		},
	};

	return { host, entries, command: extension.commands.get("color"), sessionStart: extension.handlers.get("session_start")[0] };
}

test("registers /color with completions", async () => {
	const { command } = await setup();
	assert.equal(command.name, "color");
	assert.match(command.description, /session/i);
	const completions = command.getArgumentCompletions("oce");
	assert.ok(completions.some((item) => item.value === "ocean"));
	assert.equal(command.getArgumentCompletions("zz"), null);
});

test("applies a color, tints the theme, and persists the profile", async () => {
	const { host, command, entries } = await setup();
	await command.handler("ocean", host.ctx);

	assert.deepEqual(entries, [{ customType: "session-color", data: { name: "ocean" } }]);
	const variant = host.applied.at(-1);
	assert.ok(variant instanceof Theme);
	assert.equal(variant.name, "color:ocean");
	assert.equal(variant.appearance, "dark");
	// Accent takes the palette hue at the dark-theme accent lightness.
	assert.equal(colorToHex(variant.colors.accent), colorToHex(okhslColor(OCEAN, 0.55, 0.66)));
	// The footer status shows the active color.
	assert.ok(String(host.status).includes("● ocean"));
});

test("prefix matching applies, ambiguous and unknown names do not", async () => {
	const { host, command, entries } = await setup();

	await command.handler("emer", host.ctx);
	assert.deepEqual(entries.at(-1), { customType: "session-color", data: { name: "emerald" } });
	assert.equal(host.applied.at(-1).name, "color:emerald");

	const before = entries.length;
	await command.handler("c", host.ctx); // crimson and cyan both match
	assert.equal(entries.length, before);
	assert.match(host.notifications.at(-1).message, /[Aa]mbiguous/);

	await command.handler("zzz", host.ctx);
	assert.equal(entries.length, before);
	assert.match(host.notifications.at(-1).message, /[Uu]nknown/);
});

test("shifts the thinking-level gradient and tints backgrounds, keeping the ramp", async () => {
	const { host, command } = await setup();
	await command.handler("ocean", host.ctx);
	const variant = host.applied.at(-1);

	// Every thinking token keeps its saturation and lightness, changing hue only:
	// the editor border still communicates the thinking level, in the session color.
	for (const token of THINKING_TOKENS) {
		const channels = colorToOkhsl(host.base.colors[token]);
		assert.equal(
			colorToHex(variant.colors[token]),
			colorToHex(okhslColor(OCEAN, channels.s, channels.l)),
			`token ${token}`,
		);
	}
	// Backgrounds take the hue at the base surface's lightness.
	const surfaceL = colorToOkhsl(host.base.colors.toolPendingBg).l;
	assert.equal(colorToHex(variant.colors.userMessageBg), colorToHex(okhslColor(OCEAN, 0.32, surfaceL)));
	// Non-identity tokens are untouched.
	assert.equal(colorToHex(variant.colors.text), colorToHex(host.base.colors.text));
	assert.equal(colorToHex(variant.colors.toolTitle), colorToHex(host.base.colors.toolTitle));
});

test("re-applying the same color is idempotent", async () => {
	const { host, command } = await setup();
	await command.handler("ocean", host.ctx);
	const first = host.applied.at(-1);
	await command.handler("ocean", host.ctx);
	const second = host.applied.at(-1);
	for (const token of Object.keys(second.colors)) {
		assert.equal(colorToHex(second.colors[token]), colorToHex(first.colors[token]), `token ${token}`);
	}
});

test("resume restores the last profile on the branch, without appending", async () => {
	const { host, command, sessionStart, entries } = await setup({
		branch: [
			{ customType: "session-color", data: { name: "ocean" } },
			{ customType: "session-color", data: { name: "emerald" } },
		],
	});
	await sessionStart({ reason: "resume" }, host.ctx);
	assert.equal(host.applied.at(-1).name, "color:emerald");
	assert.deepEqual(entries, []);
	assert.ok(String(host.status).includes("● emerald"));
	// The command still works afterwards.
	await command.handler("ocean", host.ctx);
	assert.deepEqual(entries, [{ customType: "session-color", data: { name: "ocean" } }]);
});

test("resume without a profile falls back to the settings theme", async () => {
	const { host, sessionStart, entries } = await setup();
	await sessionStart({ reason: "resume" }, host.ctx);
	assert.equal(host.applied.at(-1), host.base);
	assert.deepEqual(entries, []);
	assert.equal(host.status, undefined);
});

test("startup restore waits for the terminal color query, then applies", async () => {
	const { host, sessionStart, entries } = await setup({
		branch: [{ customType: "session-color", data: { name: "ocean" } }],
	});
	await sessionStart({ reason: "startup" }, host.ctx);
	assert.equal(host.applied.length, 0); // not applied synchronously
	await new Promise((resolve) => setTimeout(resolve, 1700));
	assert.equal(host.applied.at(-1).name, "color:ocean");
	assert.deepEqual(entries, []);
});

test("/color reset persists the reset and restores the base theme", async () => {
	const { host, command, sessionStart, entries } = await setup();
	await sessionStart({ reason: "startup" }, host.ctx); // captures the settings theme
	await command.handler("ocean", host.ctx);
	await command.handler("reset", host.ctx);
	assert.deepEqual(entries.at(-1), { customType: "session-color", data: { name: null } });
	assert.equal(host.applied.at(-1), host.base);
});

test("/color list reports the active color", async () => {
	const { host, command } = await setup();
	await command.handler("ocean", host.ctx);
	await command.handler("list", host.ctx);
	assert.match(host.notifications.at(-1).message, /active: ocean/);
});
