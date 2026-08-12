### Changed

- The HTTP client both Rust clients use is now ureq 3, built without its
  default features — krit talks plaintext to a loopback server, so the rustls
  and gzip stacks were dependencies nothing here used.
- Response bodies are read with an explicit size limit. ureq 3 caps a body at
  10 MiB by default, which `/api/diff` clears on its own once a review holds a
  few large files: it bundles both sides of every file's contents.
