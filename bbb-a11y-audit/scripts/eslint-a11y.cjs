// Standalone eslint config used by eslint-a11y.sh. Only accessibility rules; no style rules.
const cache = process.env.A11Y_ESLINT_CACHE;

module.exports = {
  root: true,
  parser: require.resolve('@typescript-eslint/parser', { paths: [cache] }),
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['jsx-a11y'],
  extends: ['plugin:jsx-a11y/recommended'],
  settings: {
    // Map the project's design-system components to the HTML element they render, so jsx-a11y
    // can check them. Extend this list when triage shows a wrapper that hides a native element.
    'jsx-a11y': {
      components: {
        Button: 'button',
        ButtonEmoji: 'button',
        Input: 'input',
        TextInput: 'input',
        Checkbox: 'input',
        Link: 'a',
      },
    },
  },
  rules: {
    // BBB uses accesskey with modifier combinations on purpose (Alt+Shift+key); not a 2.1.4 issue.
    'jsx-a11y/no-access-key': 'off',
    // Stricter than recommended, both map to WCAG criteria.
    // BBB wrappers (Button, ButtonEmoji...) take their accessible name from a `label` prop.
    'jsx-a11y/control-has-associated-label': [
      'warn',
      {
        labelAttributes: ['label', 'aria-label', 'aria-labelledby', 'title'],
        ignoreElements: ['audio', 'canvas', 'embed', 'input', 'textarea', 'tr', 'video'],
      },
    ],
    'jsx-a11y/autocomplete-valid': 'warn',
    'jsx-a11y/no-autofocus': ['warn', { ignoreNonDOM: true }],
  },
};
