### Added

- `krit wait`: a silent, one-shot listener for an agent whose Monitor has expired. It blocks until the reviewer comments, replies, edits, submits or the review ends, prints that as JSON and exits; the skill now switches to it when the review goes quiet instead of re-arming a stream every 30 minutes. On start it first reports any open comment the agent has not replied to (`unanswered`), so nothing landing between two waits is lost.
- `/api/events?view=agent` applies the agent websocket's human-only filter to the SSE stream.
