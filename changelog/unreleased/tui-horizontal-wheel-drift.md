### Fixed

- Scrolling a diff with a trackpad no longer slides the code out of
  `krit-tui`'s pane. A two-finger swipe reports a sideways component the whole
  way down, and acting on each notch left a screen of line numbers and `+`/`-`
  markers with no code beside them. Sideways scrolling by wheel now needs a run
  of horizontal notches, and the footer names the column whenever the pane is
  scrolled off zero.
