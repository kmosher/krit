### Changed

- `CLAUDE.md`: the shadow-root readback trap is scoped correctly — every
  `render*` callback's output is slotted light DOM, not just annotations, so a
  file header read back through `shadowRoot.textContent` omits krit's additions
  to it entirely.
