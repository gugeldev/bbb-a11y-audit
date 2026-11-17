# Classification rubric and findings format

## Impact

Judge impact by **who is blocked from what**, not by how many rules fire.

| Impact | Meaning | Examples |
| --- | --- | --- |
| `blocker` | A group of users cannot complete a core task at all. | Mute button with no accessible name; keyboard trap in the audio modal; leaving the meeting impossible without a mouse. |
| `high` | A core task is possible but very hard for a group of users (typically a Level A failure in a core flow). | Focus not visible in the user list; chat messages never announced; reflow forces two-way scrolling in the chat. |
| `medium` | A Level AA failure, or a Level A failure in a secondary flow. | Reaction buttons under 24×24 px; error shown only in red in the poll form. |
| `low` | Edge case, cosmetic, or a workaround is easy. | Missing `autocomplete` on a rarely used field. |

Judge by the effect on people first, the level second. A Level A failure in a core flow that costs a user little (a redundant or slightly mismatched label, a decorative glitch) is `medium` or `low`; say why in `affects`.

**Core flows** (see `bbb-map.md`): join, audio (join, mute, leave), chat, user list, presentation viewing, leaving the meeting. Everything else is secondary.

Raise impact one level when the problem sits in a **shared component** (one fix covers many screens) and set `"shared": true`. Do not raise it twice, and never raise into `blocker` this way: `blocker` is only for someone actually being blocked.

## Effort

| Effort | Meaning |
| --- | --- |
| `S` | Attribute, CSS or text change, in one place. |
| `M` | Component behavior: focus management, keyboard handling, live regions, state announcements. |
| `L` | New feature or architectural change: new design tokens, whiteboard keyboard model, captions pipeline. Marks the finding as an epic. |

Set `"external": true` when the fix probably belongs in a dependency (`@bigbluebutton/bbb-ui-components-react`, tldraw, BlockNote, a video player). Keep the effort as it would be in that dependency and say where the fix goes in `fix`.

## Priority

`build-report.mjs` computes it; do not set it yourself.

| | S | M | L |
| --- | --- | --- | --- |
| blocker | P1 | P1 | P2 |
| high | P1 | P2 | P3 |
| medium | P2 | P3 | P3 |
| low | P3 | P4 | P4 |

P1 = do now, P2 = next cycle, P3 = plan, P4 = backlog.

## Confidence

- `confirmed`: seen at runtime (axe, a custom check) or unambiguous in code.
- `likely`: inferred from reading code; a person or a runtime run should confirm. Say what to confirm in `verify`.

Never report something you only suspect without evidence. Put it in `manualChecks` instead.

## Grouping

One finding = one fix. Group occurrences that share a root cause into one finding with `occurrences: N` and point `location` at the place to fix (the shared style, the base component). Split when the fixes are different, even if the criterion is the same.

## Stable IDs

`build-report.mjs` derives `id` from `criterion | location.file | key`. Choose `key` so it stays the same between runs while the problem is unfixed, and changes when it is a different problem:

- static pattern: `static:<pattern-id>` plus the CSS rule or component name if one file has several (`static:outline-none:ListItem`)
- eslint: `eslint:<rule-id>:<element or component>`
- axe: `axe:<rule-id>:<state>` (or a stable selector such as a data-test value)
- custom runtime check: `runtime:<check>:<component>`
- review: `review:<short-slug>` (`review:chat-new-messages-not-announced`)

Do not use line numbers in keys: they move with unrelated edits.

If the same problem from the previous run is now better located in another file, keep continuity by setting `"id"` to the previous finding's id explicitly (it overrides the derived one) and put the new place in `location`.

## Several places, one fix

`location` is where the fix mainly goes. When the same fix also touches other places (a component and the table that lists its shortcuts), add them as `"relatedLocations": [{ "file": "…", "line": 0 }]`. Different fixes are different findings.

## Text style

Write `title`, `affects`, `fix` and `verify` in the language of the person running the audit (the report UI is in Portuguese). Plain, short sentences. `affects` says who is hurt and how, in user terms. `fix` says what to change and where. `verify` is a concrete check someone can repeat.

## `raw/findings.input.json`

```json
{
  "meta": {
    "summary": "Uma ou duas frases: o que foi auditado, o resultado e as principais lacunas.",
    "reviewedFlows": [{ "name": "Chat", "description": "chat-graphql: lista, envio, anúncios" }],
    "notCovered": [{ "name": "Gravações", "reason": "Player bbb-playback fica fora deste cliente" }],
    "project": "BigBlueButton",
    "scope": "bigbluebutton-html5/imports/ui",
    "scopePaths": ["bigbluebutton-html5/imports/ui", "bigbluebutton-html5/client"],
    "mode": "full",
    "criteria": null,
    "layers": [
      { "id": "static", "name": "Estática", "ran": true },
      { "id": "runtime", "name": "Runtime", "ran": false, "reason": "sem BBB_URL no .env" },
      { "id": "review", "name": "Revisão guiada", "ran": true }
    ]
  },
  "findings": [
    {
      "title": "Zoom por pinça bloqueado na meta viewport",
      "criterion": "1.4.4",
      "impact": "high",
      "effort": "S",
      "source": "static",
      "key": "static:viewport-zoom-blocked",
      "confidence": "confirmed",
      "location": { "file": "bigbluebutton-html5/client/main.html", "line": 21, "selector": "", "state": "" },
      "occurrences": 1,
      "shared": true,
      "external": false,
      "evidence": "<meta name=\"viewport\" content=\"... maximum-scale=1, user-scalable=no ...\">",
      "affects": "Quem tem baixa visão não consegue ampliar a tela no celular.",
      "fix": "Remover maximum-scale=1 e user-scalable=no da meta viewport.",
      "verify": "No celular, ampliar com pinça deve funcionar; axe meta-viewport sem violações.",
      "shots": []
    }
  ],
  "coverage": { "1.1.1": "pass", "1.2.1": "na", "2.1.1": "manual" },
  "discarded": [
    { "source": "static:outline-none", "file": "…/styles.ts", "line": 47, "reason": "&:focus-visible adds a box-shadow ring in the same rule" }
  ],
  "manualChecks": [
    { "flow": "Entrar no áudio", "tool": "NVDA + Chrome", "steps": ["…"], "expect": "…" }
  ]
}
```

Field rules:

- `criterion`: WCAG 2.2 A/AA number. For EN 301 549 clauses outside WCAG (9.6, 9.7) set `"standard": "EN"`, `"criterionName": "Preferências do usuário"`.
- `source`: `static`, `runtime` or `review` (the layer that found it).
- `location.file`: repo-relative path of the place to fix. For runtime findings, trace the selector back to the source file; if you cannot, use the closest component directory and say so in `evidence`.
- `coverage`: one entry per criterion that is **not** failing: `pass`, `manual`, `na` or `skip` (not evaluated in this mode). Failing criteria are derived from findings. Rules for choosing are in `criteria.md`.
- `discarded`: every candidate you rejected (fields: `source`, `file` and `line` when it has them, `state` for runtime candidates, `reason`): static pattern, eslint message, axe `incomplete`, custom runtime check), with the reason. Use `source` values like `static:outline-none`, `eslint:control-has-associated-label`, `axe:aria-valid-attr-value`, `runtime:keyboard.obscured`. This keeps triage honest and lets the next run skip known false positives.
- `shots` (per finding, runtime findings especially): where the problem shows on screen. Each entry is `{ "state": "<scenario>/<state>", "rule": "<axe rule id>" }` (marks every node of that rule in that state; add `"target": "<substring of the axe target>"` to narrow it), or `{ "state": "…", "dataTest": "<data-test value>" }` (marks that element; also accepts a list), or explicit `"boxes": [{ "x", "y", "w", "h" }]` in CSS pixels of that state's viewport, plus an optional `"caption"`. `build-report.mjs` turns them into numbered markers on the screenshot. Add at least one shot to every runtime finding and to static or review findings whose element is visible in some state (find it in that state's `elements` map in `raw/runtime/<scenario>.json`). Leave `shots` empty when the problem has no box on screen (a `<meta>` tag, the `lang` attribute, an announcement that never happens). Example: `{ "state": "moderator/meeting", "rule": "nested-interactive", "caption": "Botões aninhados na barra de ações" }`.
- `meta.summary`, `meta.reviewedFlows` and `meta.notCovered` fill the "O que foi testado" tab. List every flow you read in the guided review, and every flow, state or criterion area that nothing covered, with the reason (state failed to open, needs a device, out of scope).
- `meta.layers[].detail` (optional) is shown under each layer, e.g. "6 cenários, 60 telas".
- `meta.layers[].id` must be `static`, `runtime` or `review`: `build-report.mjs` only marks an old finding as fixed when the layer that found it ran again.
