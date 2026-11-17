# WCAG 2.2 A/AA checklist for BigBlueButton

55 criteria. **How** says which layer can decide it:
`S` static scan / eslint, `R` runtime (axe or a custom check in `wcagAudit.spec.ts`), `V` the agent reading code, screenshots and runtime data, `H` only a person can decide (judging media content).

Always classify axe results by their `wcag…` tag; the axe names in this table are hints, not the mapping.

## Coverage rule

The goal is that every guideline can be closed completely. Every criterion in scope ends in exactly one status (`coverage` in findings.input.json, one entry per criterion that is not failing):

| Status | Use when | Required fields |
| --- | --- | --- |
| `fail` | derived from findings; do not write it | — |
| `pass` | the criterion was checked across the scope and nothing fails | `method`, `how` |
| `na` | the condition of the criterion does not exist in the scope (no prerecorded media, no authentication) | `method`, `how` (why it does not apply) |
| `human` | **only** criteria marked `H` whose decision needs a person (quality of captions or audio description that exists) | `how`, `check` (the `flow` name of the manual check with the script) |
| `not-covered` | a decidable criterion this run could not decide (a state did not open, a layer did not run) | `how` (what is missing and how to get it) |
| `skip` | outside the requested scope (`criterio`, `diretriz`, `diff`, `path` modes) | — |

`method` is `tool` (axe, a custom check or the static scan decided it), `agent` (you decided it by reading code, screenshots or runtime data) or `human`. `how` is one plain sentence in the report language, e.g. "axe color-contrast em 57 telas, tema claro e escuro" or "li os handlers de teclado de user-list e chat; nenhum atalho de uma tecla".

**Never** mark a criterion `human` or `not-covered` because reading the code would take time: if `S`, `R` or `V` can decide it, decide it (in `full` mode, prioritize core flows but still decide every criterion for the whole client; in `diretriz` mode, go through every flow). Screen-reader confirmation of announcements is recommended (`manualChecks`) but does not block `pass`/`fail` of 4.1.3: decide it from the `announcements` data and the code.

Format: `"coverage": { "1.4.3": { "status": "pass", "method": "tool", "how": "…" }, "1.2.2": { "status": "human", "how": "…", "check": "Legendas do vídeo externo" } }`.

The EN 301 549 clause for each is `9.` + the number (1.1.1 → 9.1.1.1).

## 1 Perceivable

| SC | Lvl | How | What to check in BBB |
| --- | --- | --- | --- |
| 1.1.1 Non-text Content | A | S R V | Icon-only buttons (`Styled.Button` with `icon` and `hideLabel`) need a label; avatars, reaction emojis, whiteboard images, presentation slides (slide text alternative), decorative SVG hidden with `aria-hidden`. axe: `image-alt`, `button-name`, `svg-img-alt`, `role-img-alt`. |
| 1.2.1 Audio-only and Video-only (Prerecorded) | A | V H | Only if the scope plays prerecorded media (external video, recordings). The HTML5 client itself usually `na`. Decide `na` by checking the scope (V). If such media is present, whether its alternatives exist is `V`; judging their quality is `H`. |
| 1.2.2 Captions (Prerecorded) | A | V H | Same as 1.2.1. External video player: can it show captions the source has? |
| 1.2.3 Audio Description or Media Alternative | A | V H | Same as 1.2.1. |
| 1.2.4 Captions (Live) | AA | R V H | Live captions feature (`audio/audio-graphql/audio-captions`): available, can be turned on by any user, synchronized. That the feature exists and is operable is `R`/`V`; caption accuracy and delay are `H`. |
| 1.2.5 Audio Description (Prerecorded) | AA | V H | Same as 1.2.1. |
| 1.3.1 Info and Relationships | A | S R V | Headings in panels, lists rendered as lists (user list, chat), form labels, tables (breakout assignment). axe: `list`, `listitem`, `label`, `heading-order`, `aria-required-children`. |
| 1.3.2 Meaningful Sequence | A | R V | DOM order vs visual order in the layout manager (absolute positioning of sidebar, media, webcams). Keyboard walk order is a proxy. |
| 1.3.3 Sensory Characteristics | A | V | Instructions in locale strings (`public/locales/en.json`) that rely on color, shape or position ("click the green button"). |
| 1.3.4 Orientation | AA | R V | No orientation lock (`screen.orientation.lock`, CSS forcing landscape). |
| 1.3.5 Identify Input Purpose | AA | S V | Fields about the user (name in guest lobby, join forms): `autocomplete="name"`, `email`. |
| 1.4.1 Use of Color | A | V R | Status shown only by color: talking indicator, mute state, presenter/moderator markers, poll errors, connection status. axe: `link-in-text-block`. |
| 1.4.2 Audio Control | A | S V | Autoplaying audio (notification sounds are short; check anything over 3 s). |
| 1.4.3 Contrast (Minimum) | AA | R | axe `color-contrast`. Check both light and dark themes if the client has one. |
| 1.4.4 Resize Text | AA | S R V | `meta viewport` zoom blocking (`client/main.html`), fixed px heights clipping text at 200%. |
| 1.4.5 Images of Text | AA | V | Text baked into images or SVG icons used as words. |
| 1.4.10 Reflow | AA | R | Custom check `reflow` (320 px). Offenders are listed with data-test/class. |
| 1.4.11 Non-text Contrast | AA | R | `nonTextContrast` check (borders, icons, focus rings ≥ 3:1). Already known: 4.0 borders fail (see the comment in `accessibility/nonTextContrast.spec.ts`). |
| 1.4.12 Text Spacing | AA | R | Custom check `textSpacing`: text newly clipped after applying WCAG spacing. |
| 1.4.13 Content on Hover or Focus | AA | R V | Tooltips (`common/tooltip`, tippy): dismissible with Esc, hoverable, persistent. Runtime `hoverFocus` checks real tooltips: appears on hover and on focus, Esc dismisses without moving the pointer, stays while the pointer moves onto it. |

## 2 Operable

| SC | Lvl | How | What to check in BBB |
| --- | --- | --- | --- |
| 2.1.1 Keyboard | A | S R V | Every control reachable and operable by keyboard: custom dropdowns, whiteboard toolbar, video tiles menu, reactions, drag-only features. eslint: `click-events-have-key-events`, `interactive-supports-focus`, `no-static-element-interactions`. Runtime `keyboard` walk. Freehand drawing is the documented exception. The runtime walks only cover the states listed in `bbb-map.md`; other flows need the review (read their key handlers) until decided. |
| 2.1.2 No Keyboard Trap | A | R V | Runtime `keyboard.possibleTrap`; modals must close with Esc; focus traps in whiteboard and shared notes editors must have a way out. |
| 2.1.4 Character Key Shortcuts | A | S V | Single-key shortcuts (no modifier). BBB shortcuts use Alt+Shift (accesskey), which is fine. Check whiteboard (tldraw) single-letter tool shortcuts: can they be turned off or are they only active when the canvas has focus? Static pattern `single-key-shortcut` lists keydown handlers comparing `key` to a single character. |
| 2.2.1 Timing Adjustable | A | V | Session or inactivity timeouts (activity check modal), auto-dismissing notifications/toasts with actions in them. |
| 2.2.2 Pause, Stop, Hide | A | V | Animations over 5 s (emoji rain, raise-hand animation), auto-updating content. Respect `prefers-reduced-motion`. |
| 2.3.1 Three Flashes or Below Threshold | A | V | Flashing alerts or animations. Usually `pass` after review. |
| 2.4.1 Bypass Blocks | A | R V | Skip link or landmarks (`main`, `nav`, `aside`). axe: `bypass`, `region`, `landmark-*`. |
| 2.4.2 Page Titled | A | R | `document.title` per view. Covered by `accessibility/document-title.spec.ts`. |
| 2.4.3 Focus Order | A | S R V | tabindex > 0, focus moved into modals and returned to the trigger on close, order matches layout. Runtime `focusReturn` shows where focus lands after closing each menu or modal. |
| 2.4.4 Link Purpose (In Context) | A | R V | Links in chat and notes are user content (out of scope); app links need meaningful text. axe: `link-name`. |
| 2.4.5 Multiple Ways | AA | V | Applies to sets of pages. The meeting client is a single application view: usually `na`, explain why. |
| 2.4.6 Headings and Labels | AA | V | Panel headings and field labels describe the content (i18n strings). |
| 2.4.7 Focus Visible | AA | S R | `outline: none` candidates, runtime `keyboard.stops[].noOutlineOrShadow` candidates. Confirm by reading the styles (background or border change can be a valid indicator). |
| 2.4.11 Focus Not Obscured (Minimum) | AA | R V | Runtime `keyboard.stops[].obscured`; floating windows, toasts and the actions bar covering focused elements. |
| 2.5.1 Pointer Gestures | A | V | Pinch zoom or multi-finger gestures in presentation/whiteboard without button alternatives. |
| 2.5.2 Pointer Cancellation | A | S V | Actions on `onMouseDown`/`onPointerDown`/`onTouchStart` instead of click. |
| 2.5.3 Label in Name | A | S R V | `aria-label` vs visible text (the i18n label vs `aria-label` on the same Button). axe: `label-content-name-mismatch`. |
| 2.5.4 Motion Actuation | A | V | Device motion APIs. Usually `na`. |
| 2.5.7 Dragging Movements | AA | V | Drag-only: whiteboard shapes, breakout room assignment, webcam reordering, floating window resize, presentation slide navigation. |
| 2.5.8 Target Size (Minimum) | AA | R | axe `target-size` (24×24 or spacing). |

## 3 Understandable

| SC | Lvl | How | What to check in BBB |
| --- | --- | --- | --- |
| 3.1.1 Language of Page | A | R V | `<html lang>` follows the chosen locale (`imports/startup/client/intlAdapter.tsx`). axe: `html-has-lang`, `html-lang-valid`. |
| 3.1.2 Language of Parts | AA | V | Locale selector items carry `lang` (`common/locales-dropdown`). User content is out of scope. |
| 3.2.1 On Focus | A | V | Nothing opens or navigates when an element just receives focus. |
| 3.2.2 On Input | A | V | Selects/toggles that apply settings immediately and move focus or change view without warning (settings modal, layout selector). |
| 3.2.3 Consistent Navigation | AA | V | Applies to sets of pages; within the client, sidebar navigation order stays the same. Often `na` with explanation. |
| 3.2.4 Consistent Identification | AA | V | Same function, same name and icon everywhere (e.g. "Leave audio" vs "Disconnect"). |
| 3.2.6 Consistent Help | A | V | Help links (if configured) in the same place. Usually `na`. |
| 3.3.1 Error Identification | A | V | Form errors in text, tied to the field (poll creation, breakout creation, presentation upload, guest lobby). |
| 3.3.2 Labels or Instructions | A | S R V | Inputs have visible labels or instructions (not placeholder only). Note: axe's `label` rule is tagged `wcag412` (missing accessible name → 4.1.2); report it under 3.3.2 only when the visible label or instruction is missing too. |
| 3.3.3 Error Suggestion | AA | V | Errors say how to fix (file type/size on upload, empty poll options). |
| 3.3.4 Error Prevention (Legal, Financial, Data) | AA | V | Destructive actions confirm or can be undone: end meeting, remove user, delete presentation, clear whiteboard. |
| 3.3.7 Redundant Entry | A | V | Multi-step flows re-asking data (breakout creation, poll). Usually `pass` or `na`. |
| 3.3.8 Accessible Authentication (Minimum) | AA | S V | Join is by URL; check guest lobby and any password/access-code input: paste allowed, autocomplete allowed. |

## 4 Robust

| SC | Lvl | How | What to check in BBB |
| --- | --- | --- | --- |
| 4.1.2 Name, Role, Value | A | S R V | Custom controls expose role, name and state (`aria-pressed` on mute/webcam toggles, `aria-expanded` on menus, `aria-checked` on toggles, `aria-selected` on tabs). axe: `button-name`, `aria-*`, `nested-interactive`. |
| 4.1.3 Status Messages | AA | S V | Toasts, chat messages, user join/leave, raise hand, poll results, connection status announced without focus (`screenreader-alert`, live regions mounted before content changes). |

## Beyond WCAG: EN 301 549 clause 9

These are part of clause 9 but are not WCAG success criteria. Report failures with `"standard": "EN"`.

- **9.6 WCAG conformance requirements**: full pages, complete processes. Note in the summary when a core process (join → audio → leave) has any failing step.
- **9.7 User preferences**: no `forced-color-adjust: none` without need; root font size not in px; respect `prefers-reduced-motion` and `prefers-contrast` where the UI overrides system settings.

The rest of EN 301 549 (clauses 5, 6, 7, 10, 12) is outside this skill.
