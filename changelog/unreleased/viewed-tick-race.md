### Fixed

- Marking a file viewed while the viewed-list request was still in flight no
  longer un-ticks itself. The optimistic write went into react-query's cache
  and the outstanding load then installed its own, older list over it — with a
  `PUT` that had succeeded and nothing on screen to say the tick was gone. The
  window is every page still loading its first list, which is exactly when a
  reviewer starts marking files off.
