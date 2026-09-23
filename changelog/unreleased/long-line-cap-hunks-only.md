### Changed

- A file is withheld from the review surface for an overlong line only when
  that line is in a hunk. A long line in collapsed context — a Pulumi stack
  config's `secure:` ciphertext, say — no longer hides the file. The cap is
  raised from 2,000 to 4,000 characters.
