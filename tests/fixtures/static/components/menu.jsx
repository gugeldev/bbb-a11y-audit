// Fixture for static-scan tests: each block below is one known candidate.
export function Menu({ open, onKey, msg }) {
  return (
    <div>
      <div onClick={open} className="trigger">
        Menu
      </div>
      <button tabIndex={2}>Next</button>
      {msg && <div role="status">{msg}</div>}
      <input placeholder="Search" />
      <input placeholder="Labelled" aria-label="Search users" />
      <div role="button" onClick={open}>Has a role</div>
    </div>
  );
}

export function handleKey(event) {
  if (event.key === 'm') toggleMute();
}
