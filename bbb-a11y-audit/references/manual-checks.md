# Screen reader scripts

Automated checks confirm that names, roles and live regions exist. They do not confirm what a person hears, in which order, or whether announcements flood. These scripts are for a person to run.

## When to generate them

Only for what automation cannot decide. The runtime records announcements, state changes, device selection, countdowns and the accessibility tree; decide from that data. Scripts are for `human` criteria (judging media content) and, marked `"optional": true`, for confirming with a real screen reader something already decided.

- Required: one script per `human` criterion.
- Optional (`"optional": true`): at most 2–3 real screen-reader confirmations for the core flows in scope, useful after fixes. They never decide a criterion.

## Format (`manualChecks` in findings.input.json)

```json
{
  "flow": "Mutar e desmutar",
  "tool": "NVDA + Chrome",
  "optional": true,
  "steps": [
    "Entrar na sala com o NVDA ligado e escolher Microfone no modal de áudio usando só o teclado.",
    "Ir até o botão de microfone com Tab e apertar Espaço."
  ],
  "expect": "O botão é anunciado com nome e estado (\"Mutar, botão, pressionado\"). Ao apertar Espaço, o novo estado é anunciado."
}
```

Steps are concrete actions with the keyboard. `expect` names what should be heard, so the person can mark pass or fail without knowing WCAG.

## Which reader and browser

| Pair | Why |
| --- | --- |
| NVDA + Chrome or Firefox (Windows) | Most used combination; free. |
| VoiceOver + Safari (macOS, iOS) | Behaves differently with live regions and dialogs. |
| TalkBack + Chrome (Android) | Mobile users of the client. |

Prefer NVDA + Chrome by default, and add one VoiceOver script for the flow most likely to differ (dialogs or live regions).
