# BigBlueButton map for audits

Paths are relative to the repo root. Client code: `bigbluebutton-html5/imports/ui/components/`.

## Flows

Core flows decide impact (see `rubric.md`). Review them first when time is limited.

| Flow | Core | Main code | Runtime states (`<scenario>/<state>`) |
| --- | --- | --- | --- |
| Join and guest lobby | yes | `join-handler/`, `join-handler/guest-wait/`, `common/lobby-message-input/`, `user-list/guest-management/` | guest/guest-lobby, guest/mod-waiting-list, guest/guest-lobby-message, guest/guest-admitted |
| Audio modal, join audio | yes | `audio/audio-modal/`, `audio/audio-graphql/` | moderator/audio-modal, moderator/audio-echo-test, mobile/audio-modal |
| Mute, unmute, leave audio, device selection | yes | `audio/audio-graphql/audio-controls/` (incl. `input-stream-live-selector/`), `muted-alert/` | moderator/meeting, moderator/audio-menu |
| Actions bar | yes | `actions-bar/`, `actions-bar/media-area/` | moderator/meeting, moderator/media-area-menu |
| User list | yes | `user-list/`, `sidebar-navigation/` | moderator/user-list, moderator/user-item-menu, interactions/attendee-user-list, interactions/mod-raised-hand |
| Public and private chat | yes | `chat/chat-graphql/` | moderator/public-chat, moderator/chat-options, interactions/mod-unread-chat, interactions/attendee-private-message |
| Presentation viewing | yes | `presentation/`, `presentation/presentation-toolbar/` | moderator/meeting, interactions/attendee-meeting |
| Leave meeting, meeting ended | yes | `nav-bar/`, `meeting-ended/` | moderator/options-menu, moderator/leave-menu, moderator/end-meeting (meeting-ended screen not covered) |
| Settings | no | `settings/`, `common/locales-dropdown/` | moderator/settings, moderator/settings-shortcuts, locale-pt-br/settings, dark-theme/settings |
| Polling | no | `poll/`, `polling/` | moderator/poll-create, moderator/poll-running, interactions/attendee-poll, interactions/mod-poll-results |
| Breakout rooms | no | `breakout-room/`, `breakout-join-confirmation/` | moderator/breakout (invitation for attendees not covered) |
| Shared notes | no | `bn-shared-notes/`, `notes/` (BlockNote editor) | moderator/shared-notes |
| Whiteboard | no | `whiteboard/` (tldraw) | moderator/whiteboard-toolbar, moderator/whiteboard-menu (drawing itself not exercised) |
| Webcams | no | `video-provider/`, `video-preview/`, `webcam/` | moderator/webcam-preview, moderator/webcam-on, moderator/webcam-menu (fake camera) |
| Screen share | no | `screenshare/`, `actions-bar/screenshare/` | moderator/screenshare |
| Presentation upload | no | `presentation/presentation-uploader/` | moderator/presentation-upload |
| Reactions, raise hand | no | `user-reaction/`, `emoji-picker/`, `emoji-rain/`, `raisehand-notifier/` | moderator/reactions, moderator/raise-hand, interactions/mod-raised-hand |
| Notifications and toasts | yes for announcements | `notifications/`, `common/toast/`, `screenreader-alert/` | `announcements` in every scenario |
| Timer, captions, apps gallery, plugins | no | `timer/`, `audio/audio-graphql/audio-captions/`, `apps-gallery/`, `plugins-engine/` | moderator/timer (captions, apps gallery and plugins not opened) |
| Session info, connection status | no | `session-details/`, `connection-status/` | moderator/session-details, moderator/connection-status |

## Shared building blocks

A problem here usually affects many screens: mark findings `shared`.

- `common/button/`, `common/menu/`, `common/modal/`, `common/tooltip/`, `common/toast/`, `common/switch/`, `common/checkbox/`, `common/radio/`, `common/toggle-group/`, `common/visually-hidden/`
- `stylesheets/styled-components/` (palette, typography, general styles)
- `client/main.html` (viewport, base document)
- `imports/startup/client/intlAdapter.tsx` (sets `<html lang>` from the locale)
- `screenreader-alert/` (global announcer for screen readers)

## External code

When the root cause is in a dependency, mark `external: true` and name the place for the fix.

- `@bigbluebutton/bbb-ui-components-react` (used by many components; source is in `node_modules` when installed)
- tldraw (whiteboard), BlockNote (shared notes), react-player and custom players (external video), tippy (tooltips)

## Existing accessibility tests

In `bigbluebutton-tests/playwright/accessibility/`:

- `document-title.spec.ts`: 2.4.2, runs in CI.
- `nonTextContrast.spec.ts` + `nonTextContrast.ts`: 1.4.11 checker. Tagged `@need-update` because 4.0 border colors fail 3:1 (`colorBorder #B8C9D8`, `colorBlueLightest #E4ECF2`, `defaultBorder #B0BDC9`). Treat that as a known, confirmed finding.
- `wcagAudit.spec.ts`: the runtime layer of this skill (not in CI).

## Setting up the runtime layer

The runtime layer lives in the skill (`runtime/wcagAudit.spec.ts` and `runtime/wcagAuditRecorder.ts`) and runs inside the BigBlueButton Playwright suite, because it uses that suite's helpers (`core/page`, `user/multiusers`, `core/elements`, polling and screenshare utils).

1. Find the suite: `bigbluebutton-tests/playwright/` at the repo root (it has `playwright.config.ts` and `core/`). If it does not exist, the runtime layer cannot run; record why.
2. Compare `$SKILL/runtime/*.ts` with `bigbluebutton-tests/playwright/accessibility/` (`cmp`). If they are missing or differ, copy the skill's files there (the skill's copy is the source of truth).
3. If `@axe-core/playwright` is not in that folder's `package.json`, run `npm install --save-exact @axe-core/playwright@4.14.0` there. If `node_modules` is missing, run `npm ci`. If no Chromium is installed for Playwright, run `npx playwright install chromium` (on Linux distributions Playwright does not recognize, prefix it with `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64`).
4. Report in the final message what you installed or updated.

## Running the runtime layer

Needs a BigBlueButton server. In `bigbluebutton-tests/playwright/`:

- `.env` with `BBB_URL` and `BBB_SECRET` (template: `.env.template`; get them with `bbb-conf --secret` on the server)
- `npm ci` and `npx playwright install chromium` once

```bash
cd bigbluebutton-tests/playwright
A11Y_AUDIT_DIR=<abs run dir>/raw/runtime npx playwright test accessibility/wcagAudit.spec.ts --project=chromium --workers=1
```

With `A11Y_GUIDELINES` set (a guideline, several, a principle or a criterion), axe runs only the rules tagged with the topic's criteria, and checks and scenarios that cannot inform the topic are recorded as skipped:

| Topic | Custom checks that run | Scenarios skipped |
| --- | --- | --- |
| 1.4 | reflow, textSpacing, nonTextContrast, hoverFocus | none |
| 2.1, 2.4 | keyboard walks, focusReturn | dark-theme, locale-pt-br, mobile |
| 3.2 | focusReturn | dark-theme, locale-pt-br, mobile |
| 3.1 | none | dark-theme, mobile |
| 2.5 | none | dark-theme |
| 1.1, 1.3, 4.1 | none (announcements are always recorded) | dark-theme, locale-pt-br |
| 1.2, 2.2, 2.3, 3.3 | none | dark-theme, locale-pt-br, mobile |

The moderator, interactions and guest scenarios always run: every topic needs those screens.

The spec does not fail on violations. Each scenario is its own test, so one scenario breaking does not lose the others; a scenario that stops early records `checks.scenarioError`.

| Scenario (`id`) | What it does |
| --- | --- |
| `moderator` | Joins as moderator, connects audio and opens every panel, menu and modal it can (about 30 states). Runs keyboard walks on the main screen (`keyboard`), with the user list open (`keyboard-user-list`), with the chat open (`keyboard-public-chat`) and inside the settings modal (`keyboard-settings-modal`, focus must stay in the dialog); `focusReturn` (open each menu or modal from its trigger with Enter, close with Escape, report where focus lands); `hoverFocus` (for buttons with tooltips: appears on hover and on focus, Escape dismisses it without moving the pointer, it stays while the pointer moves onto it; tooltips already on screen are ignored); reflow, text spacing and non-text contrast on the main state. |
| `interactions` | Moderator + attendee. Audits the attendee's screens; the attendee sends chat messages (moderator's chat open, then closed), raises a hand, answers a poll, gets a private message and leaves. Records the announcements each side receives. |
| `guest` | Meeting with `guestPolicy=ASK_MODERATOR`. Guest lobby, moderator's waiting list, a lobby message, approval. Keyboard and reflow checks on the lobby. |
| `locale-pt-br` | Client in pt-BR: `lang`, longer strings, text spacing, reflow. |
| `dark-theme` | Dark mode turned on in settings: contrast. |
| `mobile` | Pixel 7 emulation, portrait and landscape. |

Output: `<scenario>.json` with `states[]` (each: `id`, `name`, `actor`, `ok`/`error`, `shot`, `viewport`, `lang`, axe `violations` and `incomplete` with `nodes[].target/html/summary/box`, and `elements`: the on-screen box of every visible `data-test`/`data-testid`), `checks` (`keyboard.stops[]` with boxes and `possibleTrap`, `reflow`, `textSpacing.newlyClipped[]`, `nonTextContrast`, plus notes), and `announcements[]` (`actor` = moment label, `politeness`, `text`, `regionCreatedWithMessage`; an entry with `none: true` means nothing at all was announced in that moment). Screenshots are in `shots/`. Refer to a state as `<scenario>/<state id>` in a finding's `shots`.

Environment artifacts, not findings: toasts such as "Error acquiring wake lock" or camera/microphone permission messages come from the headless, emulated test browser with fake devices. Ignore them unless the same thing would happen to a real user.

To trace a runtime node to source: search the `data-test` / `data-testid` value, the `id`, or the i18n text (`public/locales/en.json` key → `intlMessages` in the component).
