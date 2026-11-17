# Static layer: tools, triage and mappings

The static layer produces **candidates**. Every candidate is read in context and either becomes a finding (grouped with others that share the fix) or goes to `discarded` with a one-line reason.

## Tools

```bash
SKILL=<folder that contains SKILL.md>
node $SKILL/scripts/static-scan.mjs <paths…> > <run>/raw/static.json
$SKILL/scripts/eslint-a11y.sh <run>/raw/eslint.json <paths…>
```

`eslint-a11y.sh` installs eslint 8 + jsx-a11y + the TypeScript parser once into `~/.cache/a11y-audit-eslint` (needs network the first time) and ignores the project eslint config and all inline `eslint-disable` comments.

**Known limit:** the client renders most controls through styled-components (`<Styled.Button>`, `<Styled.Item>`) and wrappers from `@bigbluebutton/bbb-ui-components-react`. jsx-a11y cannot see the native element behind them, so it reports little. The runtime layer and guided review carry most of the weight; do not read a low eslint count as a good result.

## static-scan patterns

| Pattern | SC | How to triage |
| --- | --- | --- |
| `outline-none` | 2.4.7 | Open the rule. Discard if the same selector, or a `:focus-visible` rule for the same element, adds a visible indicator (outline elsewhere, `box-shadow`, border change, background change with enough contrast). Discard if the element is not focusable. Many hits in one shared style (e.g. a base Button) = one finding with `occurrences`. If it is `outline: none` on `:focus` with a `:focus-visible` ring, it is fine. |
| `positive-tabindex` | 2.4.3 | Confirm the value can be > 0 at runtime (not a variable that is usually 0 or -1). |
| `paste-blocked` | 3.3.8 | Confirm `preventDefault` runs on paste in an authentication or code field. Elsewhere it may still hurt but is not 3.3.8. |
| `conditional-live-region` | 4.1.3 | The region is created in the same render as its message. Confirm the message is a status message (not a visible-only hint). Fix: render the region always, change only its content. If a global announcer (`screenreader-alert`) is also called for the same message, discard. |
| `static-element-click` | 4.1.2, 2.1.1 | Read the full tag (the regex stops at `=>`). Discard if it has `role` and keyboard handling, or if it is hidden and duplicates a real control (e.g. `display:none` span used only to bind an accesskey). |
| `aria-label-literal-with-text` | 2.5.3 | The accessible name must contain the visible words. With i18n, compare the message ids used for `label` and `aria-label`. |
| `placeholder-as-label` | 3.3.2 | Check for a `<label htmlFor>` elsewhere or a label prop on the wrapper component. |
| `autoplay-media` | 1.4.2 | Only a problem if sound plays over 3 s without controls. |
| `viewport-zoom-blocked` | 1.4.4 | Real failure when `user-scalable=no` or `maximum-scale=1` is present. One finding, shared. |
| `forced-colors-none` | EN 9.7 | Report with `"standard": "EN"` unless the element truly needs exact colors (color picker swatches). |
| `html-font-size-px` | EN 9.7 | Low impact. Note it, do not inflate it. |

## eslint jsx-a11y rule → criterion

| Rule | SC |
| --- | --- |
| `alt-text`, `img-redundant-alt` | 1.1.1 |
| `anchor-has-content`, `anchor-is-valid` | 2.4.4, 4.1.2 |
| `aria-props`, `aria-proptypes`, `aria-role`, `aria-unsupported-elements`, `role-has-required-aria-props`, `role-supports-aria-props`, `no-redundant-roles` | 4.1.2 |
| `click-events-have-key-events`, `mouse-events-have-key-events`, `interactive-supports-focus` | 2.1.1 |
| `no-static-element-interactions`, `no-noninteractive-element-interactions`, `no-interactive-element-to-noninteractive-role`, `no-noninteractive-element-to-interactive-role` | 4.1.2 (and 2.1.1 when there is no key handler) |
| `control-has-associated-label` | 4.1.2 (buttons), 3.3.2 (fields) |
| `label-has-associated-control` | 1.3.1, 3.3.2 |
| `heading-has-content` | 1.3.1, 2.4.6 |
| `iframe-has-title` | 4.1.2 |
| `media-has-caption` | 1.2.2 (only for prerecorded media with audio) |
| `no-autofocus` | 2.4.3 when it moves focus unexpectedly; often discard |
| `no-distracting-elements` | 2.2.2 |
| `tabindex-no-positive`, `no-noninteractive-tabindex` | 2.4.3 |
| `autocomplete-valid` | 1.3.5 |
| `html-has-lang`, `lang` | 3.1.1 |
| `scope` | 1.3.1 |

`no-redundant-roles` is usually harmless; report it only when it changes semantics.

## axe-core rule → criterion

axe tags carry the criterion: `wcag111` → 1.1.1, `wcag143` → 1.4.3, `wcag1410` → 1.4.10, `wcag258` → 2.5.8 (principle, guideline, then the rest of the digits). Use the tag, not the rule name. `incomplete` results are "needs review": check them like static candidates (most `color-contrast` incompletes are text over images or gradients).
