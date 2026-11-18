# BigBlueButton map for audits

Paths are relative to the repo root. Client code: `bigbluebutton-html5/imports/ui/components/`.

## Flows

Core flows decide impact (see `rubric.md`). Review them first when time is limited.

| Flow | Core | Main code | Runtime states (`<scenario>/<state>`) |
| --- | --- | --- | --- |
| Join and guest lobby | yes | `join-handler/`, `join-handler/guest-wait/`, `common/lobby-message-input/`, `user-list/guest-management/` | guest/guest-lobby, guest/mod-waiting-list, guest/guest-lobby-message, guest/guest-admitted |
| Pre-flight (setup screen before joining, off by default, per session `userdata-bbb_pre_flight`) | yes | `pre-flight/` (session info, setup panel, settings, guest lobby, error screens), `media-setup/` | pre-flight/pre-flight, pre-flight/pre-flight-settings, pre-flight/pre-flight-camera-on, pre-flight/pre-flight-device-permission, pre-flight/pre-flight-guest-lobby, pre-flight/pre-flight-guest-denied |
| Audio modal, join audio | yes | `audio/audio-modal/`, `audio/audio-graphql/` | moderator/audio-modal, moderator/audio-echo-test, mobile/audio-modal |
| Mute, unmute, leave audio, device selection | yes | `audio/audio-graphql/audio-controls/` (incl. `input-stream-live-selector/`), `muted-alert/`, `profile-settings/` | moderator/meeting, moderator/audio-menu, moderator/settings-audio |
| Actions bar | yes | `actions-bar/`, `actions-bar/media-area/` | moderator/meeting, moderator/media-area-menu |
| User list | yes | `user-list/`, `sidebar-navigation/`, `user-avatar/` | moderator/user-list, moderator/user-item-menu, interactions/attendee-user-list, interactions/mod-raised-hand, interactions/mod-attendee-menu, interactions/remove-user-confirm |
| Moderator requests (camera, presenter) | no | `request-camera-modal/`, `request-presenter/`, `lock-viewers/` | interactions/attendee-camera-request, interactions/attendee-request-presenter, interactions/mod-presenter-request, moderator/lock-viewers |
| Public and private chat | yes | `chat/chat-graphql/`, `emoji-picker/`, `text-input/` | moderator/public-chat, moderator/chat-options, moderator/chat-emoji-picker, moderator/chat-message-toolbar, moderator/chat-react-picker, moderator/chat-reply, moderator/chat-pin-confirm, moderator/chat-delete-confirm, interactions/mod-unread-chat, interactions/attendee-private-message, interactions/mod-private-chat |
| Presentation viewing | yes | `presentation/`, `presentation/presentation-toolbar/`, `presentation/presentation-menu/` | moderator/meeting, moderator/presentation-menu, interactions/attendee-meeting |
| Leave meeting, meeting ended, removed | yes | `nav-bar/`, `meeting-ended/`, `end-meeting-confirmation/` | moderator/options-menu, moderator/leave-menu, moderator/end-meeting, moderator/meeting-ended, interactions/attendee-removed |
| Connection lost, reconnecting | yes for announcements | `connection-manager/`, `notifications-bar/`, `reload-button/` | connection/reconnecting |
| Settings | no | `settings/`, `common/locales-dropdown/`, `about/` | moderator/settings, moderator/settings-notifications, moderator/settings-data-saving, moderator/settings-audio, moderator/settings-shortcuts, moderator/settings-about, locale-pt-br/settings, dark-theme/settings |
| Layout | no | `layout/` | moderator/layout-view |
| Recording | no | `recording/`, `nav-bar/nav-bar-graphql/recording-indicator/` | moderator/recording-confirm (meeting created with `record=true`) |
| Polling | no | `poll/`, `polling/` | moderator/poll-create, moderator/poll-running, interactions/attendee-poll, interactions/mod-poll-results |
| Breakout rooms | no | `breakout-room/`, `breakout-join-confirmation/` | moderator/breakout, breakout/attendee-invite, breakout/attendee-in-room, breakout/mod-rooms-running, breakout/mod-room-menu |
| Shared notes | no | `bn-shared-notes/`, `notes/` (BlockNote editor) | moderator/shared-notes, moderator/notes-options |
| Whiteboard | no | `whiteboard/` (tldraw) | moderator/whiteboard-toolbar, moderator/whiteboard-menu (drawing itself not exercised) |
| Webcams | no | `video-provider/`, `video-preview/`, `webcam/`, `camera-settings/` | moderator/webcam-preview, moderator/webcam-on, moderator/webcam-button-menu, moderator/webcam-menu (fake camera) |
| Screen share | no | `screenshare/`, `actions-bar/screenshare/` | moderator/screenshare |
| Presentation upload | no | `actions-bar/media-area/media-sharing/presentation/` (incl. `presentation-download-dropdown/`), `presentation/presentation-toast/presentation-uploader-toast/` | moderator/presentation-upload, moderator/presentation-download-menu |
| External video | no | `external-video-player/` | moderator/external-video-modal, moderator/external-video-playing (video served by the suite's stub) |
| Reactions, raise hand | no | `user-reaction/`, `emoji-picker/`, `emoji-rain/`, `raisehand-notifier/` | moderator/reactions, moderator/raise-hand, interactions/mod-raised-hand |
| Notifications and toasts | yes for announcements | `notifications/`, `common/toast/`, `screenreader-alert/` | `announcements` in every scenario |
| Timer, captions, apps gallery, plugins | no | `timer/`, `audio/audio-graphql/audio-captions/`, `apps-gallery/`, `plugins-engine/`, `plugins/` | moderator/timer, moderator/apps-gallery (captions need speech recognition and plugins need a plugin installed on the server: review only) |
| Session info, connection status | no | `session-details/`, `connection-status/` | moderator/session-details, moderator/connection-status |

Conditional screens with no runtime state, decided by the review only: `activity-check/` (inactivity modal, needs a server timeout), `mobile-app-modal/`, `common/media-consent-modal/`, `livekit/autoplay-modal/`, `error-screen/` (fatal errors), `debug-window/` (developer only).

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

The runtime layer lives in the skill (`runtime/*.ts`: the spec plus its recorder, checks and announcement recorder) and runs inside the BigBlueButton Playwright suite, because it uses that suite's helpers (`core/page`, `user/multiusers`, `core/elements`, polling and screenshare utils). It targets the 4.1 client (`v4.1.x-develop`) and only imports helpers that exist there.

1. Find the suite: `bigbluebutton-tests/playwright/` at the repo root (it has `playwright.config.ts` and `core/`). If it does not exist, the runtime layer cannot run; record why.
2. Compare `$SKILL/runtime/*.ts` with `bigbluebutton-tests/playwright/accessibility/` (`cmp`). If they are missing or differ, copy the skill's files there (the skill's copy is the source of truth). They are not part of BigBlueButton: list them in `.git/info/exclude` (`bigbluebutton-tests/playwright/accessibility/wcagAudit*.ts`) so they never show as changes.
3. If `node_modules` is missing, run `npm ci` in that folder. If `node_modules/@axe-core/playwright` is missing, run `npm install --no-save --no-audit --no-fund @axe-core/playwright@4.14.0`: `--no-save` keeps `package.json` and `package-lock.json` untouched (a later `npm ci` removes the package, and this step puts it back). If npm reports that install scripts were blocked (a local `ignore-scripts` policy), that is fine: the runtime layer does not need them. If no Chromium is installed for Playwright, run `npx playwright install chromium` (on Linux distributions Playwright does not recognize, prefix it with `PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64`).
4. Report in the final message what you installed or updated.

## Running the runtime layer

Needs a BigBlueButton server. In `bigbluebutton-tests/playwright/`:

- `.env` with `BBB_URL` and `BBB_SECRET` (template: `.env.template`; get them with `bbb-conf --secret` on the server)
- `npm ci` and `npx playwright install chromium` once

```bash
cd bigbluebutton-tests/playwright
A11Y_AUDIT_DIR=<abs run dir>/raw/runtime npx playwright test accessibility/wcagAudit.spec.ts --project=Chromium --workers=1
```

With `A11Y_GUIDELINES` set (a guideline, several, a principle or a criterion), axe runs only the rules tagged with the topic's criteria, and checks and scenarios that cannot inform the topic are recorded as skipped:

| Topic | Custom checks that run | Scenarios skipped |
| --- | --- | --- |
| 1.1 | none | breakout, connection, locale-pt-br, dark-theme |
| 1.2 | none | breakout, connection, locale-pt-br, dark-theme, mobile |
| 1.3 | stateChanges, deviceSelection | locale-pt-br, dark-theme |
| 1.4 | reflow, textSpacing, nonTextContrast, hoverFocus | none |
| 2.1 | keyboard walks, focusReturn | connection, locale-pt-br, dark-theme, mobile |
| 2.2 | none | locale-pt-br, dark-theme, mobile |
| 2.3 | none | breakout, connection, locale-pt-br, dark-theme, mobile |
| 2.4 | keyboard walks, focusReturn | connection, locale-pt-br, dark-theme, mobile |
| 2.5 | none | breakout, connection, dark-theme |
| 3.1 | none | breakout, connection, dark-theme, mobile |
| 3.2 | focusReturn | connection, locale-pt-br, dark-theme, mobile |
| 3.3 | none | breakout, locale-pt-br, dark-theme, mobile |
| 4.1 | stateChanges, deviceSelection | locale-pt-br, dark-theme |

A principle runs the union of its guidelines (principle 4 is guideline 4.1). Announcements are recorded in every topic. The table follows the topic tags in `wcagAudit.spec.ts` (`rec.check(..., topics)` and `skipUnlessTopic(...)`): change both together.

The moderator, interactions, guest and pre-flight scenarios always run: every topic needs those screens.

The spec does not fail on violations. Each scenario is its own test, so one scenario breaking does not lose the others; a scenario that stops early records `checks.scenarioError`.

| Scenario (`id`) | What it does |
| --- | --- |
| `moderator` | Joins as moderator in a meeting created with `record=true` (and the chat emoji picker turned on), connects audio and opens every panel, menu and modal it can (about 55 states: chat message actions, every settings tab, notes options, apps gallery, layout, recording confirmation, presentation menus, external video, webcam menus, and finally ends the meeting to audit the meeting-ended screen). Runs keyboard walks on the main screen (`keyboard`), with the user list open (`keyboard-user-list`), with the chat open (`keyboard-public-chat`) and inside the settings modal (`keyboard-settings-modal`, focus must stay in the dialog); `focusReturn` (open each menu or modal from its trigger with Enter, close with Escape, report where focus lands); `stateChanges` (activate toggles such as mute and raise hand, and menu triggers, and report which ARIA attributes changed: a toggle whose state changes only visually fails 4.1.2); `deviceSelection` (pick another microphone and speaker in the audio menu and report how the current choice is exposed before and after); `hoverFocus` (for buttons with tooltips: appears on hover and on focus, Escape dismisses it without moving the pointer, it stays while the pointer moves onto it; tooltips already on screen are ignored); reflow, text spacing and non-text contrast on the main state. |
| `breakout` | Moderator creates a breakout room with an attendee. Audits the invitation, the room client and the moderator's panel, then stays idle for 30 s and records every announcement (a countdown read every second shows up here). |
| `interactions` | Moderator + attendee, in a meeting created with `allowModsToRequestCameraShare=true`. Audits the attendee's screens; the attendee sends chat messages (moderator's chat open, then closed), raises a hand, answers a poll and gets a private message. The moderator opens the attendee's menu, asks them to share the camera, gets a presenter request (policy set to require approval) and finally removes them: the confirmation and the removed attendee's screen are audited. Records the announcements each side receives. |
| `guest` | Meeting with `guestPolicy=ASK_MODERATOR`. Guest lobby, moderator's waiting list, a lobby message, approval. Keyboard and reflow checks on the lobby. |
| `pre-flight` | The 4.1 setup screen before joining (turned on per user with a client settings override): the screen itself with keyboard, reflow, text spacing and contrast checks, its settings, the camera turned on, the screen shown when the browser refuses the microphone, and, with the guest policy set to ask the moderator, the waiting and denied screens with their announcements. |
| `connection` | The graphql connection is dropped from inside the browser: audits the reconnecting notice and records what is announced when the connection drops and comes back. |
| `locale-pt-br` | Client in pt-BR: `lang`, longer strings, text spacing, reflow. |
| `dark-theme` | Dark mode turned on in settings: contrast. |
| `mobile` | Pixel 7 emulation, portrait and landscape. |

Every audited state also writes `aria/<scenario>--<state>.yml`: the accessibility tree as Chromium computes it (roles, accessible names and states such as `[pressed]`, `[expanded]`, `[checked]`, `[selected]`, `[disabled]`), only for topics where names and roles matter (1.1, 1.3, 2.4, 2.5, 3.3, 4.1). Use it to decide names, roles and states without guessing from the source, e.g. `grep -nE '^\s*- (button|link|checkbox|radio|switch|slider|spinbutton|combobox|textbox|searchbox|menuitem|menuitemcheckbox|menuitemradio|tab|option)( \[[^]]*\])*:?$' aria/*.yml` lists every control with no name (a named one reads `- button "Mute"`), comboboxes and fields included, not only buttons. It also catches a `<label htmlFor>` whose `id` never reaches the control, which axe can miss.

Output: `<scenario>.json` with `states[]` (each: `id`, `name`, `actor`, `ok`/`error`, `shot`, `viewport`, `lang`, axe `violations` and `incomplete` with `nodes[].target/html/summary/box`, and `elements`: the on-screen box of every visible `data-test`/`data-testid`), `checks` (`keyboard.stops[]` with boxes and `possibleTrap`, `reflow`, `textSpacing.newlyClipped[]`, `nonTextContrast`, plus notes), and `announcements[]` (`actor` = moment label, `politeness`, `text`, `regionCreatedWithMessage`; an entry with `none: true` means nothing at all was announced in that moment; `unavailable: true` means the recorder could not read that page, which is not silence: never conclude anything from it; nested regions are recorded once, at the outermost region; `regionCreatedWithMessage` is never set for `role=alert`, which is announced on insertion). Screenshots are in `shots/`. Refer to a state as `<scenario>/<state id>` in a finding's `shots`.

Environment artifacts, not findings: a presentation upload error toast ("Failed to determine the number of pages") means the test server cannot convert presentations, which also leaves the whiteboard states unaudited; fix the server, not the client. Toasts such as "Error acquiring wake lock" or camera/microphone permission messages come from the headless, emulated test browser with fake devices. Ignore them unless the same thing would happen to a real user.

To trace a runtime node to source: search the `data-test` / `data-testid` value, the `id`, or the i18n text (`public/locales/en.json` key → `intlMessages` in the component).
