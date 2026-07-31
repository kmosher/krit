### Fixed

- A file containing a very long line no longer displaces or blanks the whole
  diff surface. Such files are withheld from the surface and named in a strip
  above it, rather than taking every other file down with them.
- A renderer that throws is now contained to its own preview pane, instead of
  unmounting the entire review.
- Deeply nested SVG is truncated at a fixed depth and says so, rather than
  exhausting the stack while it is being sanitized.
