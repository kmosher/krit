### Fixed

- Both clients now tell ureq to ignore proxy environment variables. ureq 3
  reads `ALL_PROXY`/`HTTPS_PROXY`/`HTTP_PROXY` by default and has no loopback
  bypass, so on a machine with a proxy exported every request to krit's own
  127.0.0.1 server was being sent through it — reported as "cannot reach krit"
  against a server that was running perfectly.
- `krit-tui` no longer reports a failure when it cannot hand back a terminal
  that has gone away. Closing a terminal window left it exiting `1` with
  "could not restore the terminal", which recorded every closed window as an
  error for anything watching the exit status.
- A `select` failure that is not a signal ends the viewer instead of being
  treated as an idle tick — the previous handling would have spun a core on a
  descriptor that could no longer be waited on, which is the failure the wait
  exists to prevent.
- `krit`'s CLI prints the status code alone for a status it does not recognise,
  rather than leaving a gap where the reason phrase would go.
- `krit wait-for-submit` goes through the configured client, so a refused
  subscription is reported instead of being treated as an open stream that
  never says anything.

### Changed

- Response body limits moved to `krit-core` and error bodies now read under a
  much smaller cap: an error only has to carry the server's message, and the
  diff-sized limit let anything answering on that port spend half a gigabyte on
  one line of output.
- An https base URL in the state file is now diagnosed as such. krit is built
  without TLS, so those requests fail as ordinary transport errors that read
  exactly like a dead server.
