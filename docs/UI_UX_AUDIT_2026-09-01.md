# RerunTV Intensive UI/UX and Theme Audit

Date: 2026-09-01
Scope: live Electron application, Control Center, live TV, channel changes, channel card, docked guide, full guide, all current themes, keyboard interaction states, accessibility contrast, responsive behavior, and theme-plugin parity.

## Executive assessment

RerunTV already has an unusually complete cable-box interaction model: live scheduling, remote-first navigation, docked and full guides, channel/now-playing cards, CRT behavior, and theme plugins that can alter sound and guide behavior rather than only color. The guide is the strongest part of the product. Its main usability weakness was scale and workspace geometry: the text-heavy Control Center inherited the simulated output's 4:3 or low-resolution frame, producing pillarboxes and making dense setup screens unnecessarily small on large displays.

The audit resulted in two shared changes and three complete theme packs:

- The Control Center now uses the full application canvas, independent of TV output aspect and simulated resolution. Live TV, channel cards, and both guide modes continue to respect box emulation.
- Guide information, time headings, channel numbers/names, and program titles now scale within readable bounds relative to the actual display frame.
- New provider-neutral themes add three distinct hardware identities: Addressable Converter '89, Dual-Tuner DVR '05, and Hotel Headend '92.

## Audit coverage

### Control Center

Both workspaces and all primary tabs were opened and captured.

- Watch & Lineup: Lineup; Picture & Guide; Manual.
- Master Control: Lineup; Programming; System & Storage; Status; Plug-ins; Manual.

All 24 primary-tab submenus were visited:

- Picture & Guide: Picture, Interface.
- Programming: Presets, Flows, Pool, On-screen, Auto-curate, Tag taxonomy, Aircheck.
- System & Storage: System, Network, Security, Backups, Library sync.
- Status: Status, Monitor, Telemetry.
- Plug-ins: Installed, Appearance, Diagnostics.
- Manual: Guide, Shortcuts, Updates, Releases.

The static control inventory includes approximately 130 buttons, 68 inputs, 20 selects, two workspaces, seven primary tabs, and 24 submenus. Search, filters, active/idle/hover/focus states, plugin management, theme selection, taxonomy, neutral/primary/danger actions, and empty/loading/error surfaces were included.

### TV and guide

- Live TV and the now-playing/channel card.
- Three sequential real-channel changes per theme.
- Docked guide with live picture.
- Full guide, including guide selection and information header.
- Guide live-preview defaults, including themes that intentionally suppress picture-in-picture for period accuracy.
- Keyboard-visible selection, hover, idle, primary, neutral, and danger states.

### Themes

All 23 pre-audit themes completed the live TV/channel-change/docked-guide/full-guide sweep without a renderer error:

Digital 2000s, Analog '90s, Aqua Grid '06, Cable Box OSD, Cloud Guide '16, Cyberpunk Synth, Dark Grid '12, Digital Satellite 2000s, Emerald Matrix, Frutiger Aero, Master Control, Midnight OLED, Neo Brutalist, Network Primetime '90s, Ops Dashboard, Outrun Synthwave, Passport '03, Prevue Guide '94, Slate Grid '10, UHF Public Access '80s, VHS Retro '80s, Widescreen Grid '13, and Wood Console '70s.

The audit then added Addressable Converter '89, Dual-Tuner DVR '05, and Hotel Headend '92. The post-change acceptance target is 26 themes under the same sweep.

## Findings and disposition

### P1 — Control Center geometry reduced large-screen usability

The entire app, including setup, inherited the selected cable-box aspect ratio and simulated resolution. A 4:3 mode on a 16:9 display left large black sidebars around an already dense administrative UI. This was authentic for TV output but counterproductive for managing folders, schedules, plug-ins, and settings.

Disposition: fixed. Setup now fills the available window and renders sharply. Returning to TV reapplies the selected box aspect and resolution. The explicit window-lock preference is preserved.

### P1 — Guide typography needed stronger couch-distance scaling

The guide grid was structurally sound, but channel names, program titles, time headings, and selected-program details used several fixed pixel sizes. Automatic 4K interface scaling helped, yet those local caps still made the guide feel visually timid on large televisions.

Disposition: fixed. Core guide typography now uses bounded container-relative scaling. It grows on a large guide canvas without overrunning compact or simulated low-resolution layouts. Themes retain their row-height and density personality.

### P2 — Control Center navigation consumes too many vertical layers

Workspace switch, primary tabs, breadcrumb, global settings search, and sub-tabs can form five consecutive navigation layers. The model is understandable and search is valuable, but the repetition delays access to the actual controls, especially in Programming.

Disposition: improved. Full-canvas setup recovers substantial space; the workspace, primary-tab, breadcrumb, and search spacing is tighter, while primary workspace targets grow to 42px. A future iteration should merge the breadcrumb into the page heading and conditionally collapse the workspace description after users learn the model.

### P2 — Theme identity was uneven

The strongest packs—Prevue, Cable Box OSD, Passport/Cobalt, Network Primetime, and several era themes—change grid structure, focus, motion, sounds, and picture-preview behavior. A number of thinner packs mainly change palette and component chrome, so the TV/guide experience can feel like the same box wearing a skin.

Disposition: improved with three benchmark themes. Every new pack supplies palette tokens, guide geometry, channel-card treatment, control states, guide entrance behavior, power/channel sounds, CRT bias, caption styling, preview swatches, reduced-motion behavior, and an era-appropriate live-preview default. Existing thinner themes remain compatible; deeper differentiation is a good incremental backlog rather than a breaking rewrite.

### P2 — Non-critical notices can compete with live TV

The configuration-migration notice appeared during visual captures and could overlap the TV experience while a user is channel surfing or opening the guide. The notice is useful, but its duration and placement give internal maintenance information the same visual priority as playback feedback.

Disposition: backlog. Prefer showing migration detail in Status/Telemetry, with a short one-line acknowledgement on TV that expires quickly and never covers the selected guide row or now-playing card.

### P2 — Dense management screens need progressive disclosure

Programming and channel editing expose extensive capability, but large sections can become long scanning exercises. Users can search settings and switch workspaces, which helps, but expert controls still compete visually with everyday actions.

Disposition: backlog. Preserve the current power-user paths while adding remembered collapsed groups, short task-oriented summaries, and “advanced” disclosure for low-frequency timing/metadata controls. Do not hide error state, schedule conflicts, or save status.

### P3 — Theme browser could communicate behavior, not only appearance

Preview swatches make a large theme collection scannable, but they do not convey whether a theme changes guide preview, CRT bias, captions, audio feedback, density, or motion.

Disposition: backlog. Add compact capability chips such as LIVE PREVIEW, ANALOG, DENSE GRID, LARGE TYPE, SOUND, and LOW MOTION, plus a mini channel-card/guide preview. Keep full keyboard operation and avoid autoplaying sound.

### P3 — Couch and desktop workflows deserve named presets

Automatic display scaling is the correct default and now handles large canvases. Some users will still want a single clear “Couch / Desk / Compact” choice rather than reasoning about numeric scale and guide density separately.

Disposition: backlog. Present presets as aliases over existing scale and guide options, keeping Custom for exact control.

## Accessibility and interaction results

- All 26 final themes passed the automated 4.5:1 interaction-contrast threshold across selected, idle, hover, focus, primary, neutral, and danger samples. The first pass found five weak hover states in each of the new DVR and hotel packs; their button ramps were corrected and the complete 26-theme matrix then passed with zero failures.
- No renderer errors occurred during the final 26-theme guide/channel sweep: 26 channel cards, 26 docked guides, 26 full guides, and 78 sequential channel changes.
- Keyboard-visible focus is present in primary tabs, sub-tabs, list rows, guide entries, theme choices, and action buttons.
- Reduced-motion fallbacks are retained in core and required for each new theme's hardware animation.
- The new full-canvas setup layout retains a single-column responsive fallback below 760px.

Contrast compliance is not a substitute for usability: large-distance legibility, selection clarity, information density, and motion character were assessed separately in live screenshots.

## Theme design notes

### Addressable Converter '89

Black molded-plastic panels, amber character-generator text, red LED channel feedback, hard stepped interaction, coarse tune noise, no guide picture-in-picture, hidden pre-guidelines rating bug, and a compact upper-case grid. This is the most appliance-like of the three.

### Dual-Tuner DVR '05

Midnight/cobalt information panels, silver channel rails, yellow remote focus, a taller information-dense grid, quieter digital tune sound, and live guide preview. It represents the moment a cable box became a recorder and content browser.

### Hotel Headend '92

Institutional teal, warm ivory channel rails, large 60px rows, oversized focus boundaries, simple remote behavior, no picture-in-picture, and restrained square-wave feedback. It prioritizes immediate legibility for an unfamiliar remote and room TV.

## Acceptance results

- Complete static suite: 19/19 tests passed.
- Theme runtime sweep: 26/26 themes passed, three channel changes per theme, zero renderer errors.
- Interaction contrast: 26/26 themes passed, zero failing states at 4.5:1.
- Control Center: all 28 workspace/tab/submenu states captured at large-display geometry, zero renderer errors.
- Full-width Control Center and both guide modes visually inspected for overflow, focus clarity, readability, and theme identity.
- Packaged Windows application built successfully; bundled theme assets verified in the application archive.
- Disposable Electron profile restored after every run. The real `channels.json` SHA-256 remained `27B1B60B05F35183BA2489415566FA61D0BE265A796AE6DC72EF5FA53FA6830E`, and no sweep backup remained.
