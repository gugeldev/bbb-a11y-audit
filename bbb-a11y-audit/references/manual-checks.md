# Screen reader scripts

Automated checks confirm that names, roles and live regions exist. They do not confirm what a person hears, in which order, or whether announcements flood. These scripts are for a person to run.

## When to generate them

- Always for the core flows that are in scope: join audio, mute/unmute, chat, leave meeting.
- For every finding about 4.1.2 (state changes), 4.1.3 (status messages), 2.4.3 (focus after modal) or 1.3.1 in a core flow, add or extend a script so a person can confirm the fix.
- Keep it to 3–6 scripts per run. Each one takes a few minutes.

## Format (`manualChecks` in findings.input.json)

```json
{
  "flow": "Mutar e desmutar",
  "tool": "NVDA + Chrome",
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
