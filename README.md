# pi-session-color

[![CI](https://github.com/MKmasterg/pi-session-color/actions/workflows/ci.yml/badge.svg)](https://github.com/MKmasterg/pi-session-color/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/@mkmasterg/pi-session-color)](https://www.npmjs.com/package/@mkmasterg/pi-session-color)

`/color` for [pi](https://pi.dev): give every session its own color. The color tints the accents, borders, message backgrounds, and the input-editor border of whatever theme is active, and it is written into the session itself — close pi, resume the session, and the color comes back. Other sessions keep their own color, or the default.

```
/color ocean
```

It is one file, [`extensions/session-color.ts`](extensions/session-color.ts), with no dependencies beyond pi itself.

## Install

```bash
pi install npm:@mkmasterg/pi-session-color            # from npm
pi install git:github.com/MKmasterg/pi-session-color  # or straight from GitHub
pi -e ./extensions/session-color.ts                  # or try it once from a clone, without installing
```

## Use

| | |
|---|---|
| `/color` | Open the picker. Arrow through the palette and the whole UI recolors live; Enter applies, Esc cancels and reverts. |
| `/color <name>` | Apply a color directly. Prefix match works: `/color emer` applies `emerald`. |
| `/color default` | Reset this session to the theme from pi's settings. `reset`, `none`, and `off` also work. |
| `/color list` | Show the palette and the active color. |

The palette: `rose`, `crimson`, `ember`, `amber`, `lime`, `emerald`, `jade`, `teal`, `cyan`, `sky`, `ocean`, `indigo`, `violet`, `orchid`.

The current color also shows in the footer status line as `● name`.

## How it works

**Per session, not global.** The choice is stored in the session file as a custom entry (`session-color`), the same mechanism pi extensions use for durable state. Resume scans the active branch for the last entry and re-applies it. Forking carries the color over; `/new` starts without one. The theme *setting* in `settings.json` is never modified — variants are in-memory `Theme` instances, so `pi --use-theme` and `/settings` keep working.

**Tints, not replacements.** A color does not swap the theme; it shifts its identity tokens to the palette hue, deriving every value from the active theme's own surface colors:

- `accent`, `borderAccent`, `border`, `customMessageLabel`, `mdListBullet` take the palette hue at the theme's accent lightness (darker on light themes, for contrast).
- `selectedBg`, `userMessageBg`, `customMessageBg` take the hue at the theme's own surface lightness, so panels stay readable on both dark and light themes.
- The input-editor border reads pi's thinking-level gradient (`thinkingOff` … `thinkingMax`). Every step of the ramp is re-hued while keeping its saturation and lightness, so the border still communicates how hard the model is thinking — just in the session's color.

Because variants are built from the live theme each time, they compose with `system`, `dark`, `light`, light/dark pairs, and custom themes. Re-applying the same color is idempotent.

**Startup timing.** On startup the color is applied after pi's terminal color query settles (~1.5 s), so the saved tint is built from the final colors rather than the grayscale startup guess.

**Surviving the resume theme re-apply.** After `session_start` on a session switch, pi re-applies the theme from your settings, which would discard an in-memory variant. The extension keeps a cheap guard (one theme-name comparison every 250 ms) while a color is active: as soon as the live theme is no longer its own, it rebuilds the tint from whatever theme is now active and applies it again. So `/resume` keeps its color, the footer's `● name` never goes stale, and a theme you pick with `/settings` or `--use-theme` gets tinted with the session color too. `/color default` stops the guard.

**Headless sessions.** `pi -p` and RPC mode have no UI to recolor, but `/color` still records the profile, so the next interactive resume of that session picks it up.

## Development

```bash
npm install
npm run check                       # type-check against pi 1.6
npm test                            # behaviour tests through pi's real extension loader and Theme
npm run verify:package              # the npm tarball holds only the extension and its docs
```

The tests load the extension through `discoverAndLoadExtensions`, drive the command and `session_start` handlers with a real in-memory `SessionManager`, and assert on the `Theme` instances the extension builds (token values, gradient hue-shifts, idempotency, last-entry-wins on resume, and the color surviving pi's post-switch re-apply of the settings theme).

## Releasing

Releases come from conventional commits: `fix:` bumps the patch version, `feat:` the minor version (while below 1.0), and `feat!:` or `BREAKING CHANGE:` marks a breaking change.

1. On every push to `main`, CI type-checks and tests against the locked pi version and the newest pi release.
2. release-please keeps a release PR open with the next version and its `CHANGELOG.md` entry. pi shows that changelog to users when the package updates.
3. Merging the release PR tags the version and creates a GitHub release. The `publish` job then tests again and runs `npm publish --provenance` in the `npm` environment.

Publishing uses npm trusted publishing, so there is no npm token in the repository. Set up trusted publishing for the package on npmjs.com against the `release.yml` workflow in the `npm` environment of this repository before the first release.
