//! The event core: one broadcast bus that every subscriber — SSE (browser,
//! CLI), ws (agent), and the lifecycle logic itself — hangs off. Presence
//! counting and principal-based idle shutdown are bus-level concerns here,
//! not transport handlers' — v1's hardest bugs lived in that gap.

use crate::types::{EndReason, Event};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{Notify, broadcast};

/// Broadcast depth. Receivers treat Lagged as "skip the missed frames", so an
/// overrun silently drops events (worst case a missed `submitted`). Sized so
/// a mass-checkout burst — one file-changed per touched file plus one
/// comment-updated per re-anchored comment in a single debounce tick —
/// doesn't overrun a momentarily slow subscriber.
const BUS_CAPACITY: usize = 2048;

/// Default grace period after the last browser tab disconnects before the
/// server shuts itself down. Keyed on browser (role ui) presence only: a CLI
/// or agent subscriber must never hold the server alive on its own.
///
/// Short on purpose. The grace period only has to cover a page refresh —
/// EventSource reconnects in well under a second — and every millisecond
/// beyond that is a dead server holding a port. Override with `--idle-timeout`
/// or `KRIT_IDLE_TIMEOUT_MS` when something slower is in the loop (a browser
/// launching cold, a tunnel reconnecting).
pub const DEFAULT_IDLE_SHUTDOWN_MS: u64 = 5_000;

/// If no browser EVER connects within this window of start, nobody's
/// reviewing — shut down instead of running forever.
const NO_BROWSER_TIMEOUT_MS: u64 = 180_000;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Role {
    Ui,
    Cli,
    Agent,
}

pub struct Hub {
    tx: broadcast::Sender<Event>,
    ui: AtomicUsize,
    cli: AtomicUsize,
    agent: AtomicUsize,
    ever_had_browser: AtomicBool,
    // Bumped on every subscriber connect/disconnect, any role (check_idle
    // runs on each); an armed idle timer only fires if the generation it
    // captured is still current — so CLI/agent churn also re-arms the 60s
    // window, not just browser transitions. Still needed alongside the
    // handle below: abort() can't stop a task that has already woken from
    // its sleep and is inside the check.
    idle_gen: AtomicU64,
    // At most one armed timer at a time. Generation invalidation alone made
    // superseded timers no-ops but left them alive, so a CLI or agent
    // reconnect loop with no browser attached accumulated one live task per
    // event for a full minute.
    idle_timer: Mutex<Option<tokio::task::JoinHandle<()>>>,
    idle_shutdown_ms: AtomicU64,
    // Set once Done reviewing has been clicked. After that the grace period
    // has nothing left to protect — there is no next thing the reviewer does
    // here — so the last browser leaving ends the server immediately.
    submitted: AtomicBool,
    shutting_down: AtomicBool,
    /// Signalled once the review-ended broadcast is out; axum's graceful
    /// shutdown waits on this.
    pub shutdown: Notify,
    /// Run by the hard-exit fallback in initiate_shutdown (state-file
    /// removal). The graceful path cleans up in serve() after axum drains;
    /// the 2s belt-and-suspenders exit would otherwise leave a stale state
    /// file pointing at a dead pid.
    exit_cleanup: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

/// RAII subscription: dropping it (stream torn down, socket closed, task
/// died — any path) runs the disconnect accounting. Disconnect bookkeeping
/// that can't be forgotten is the design answer to v1's lifecycle bugs.
pub struct SubGuard {
    hub: Arc<Hub>,
    role: Role,
}

impl Drop for SubGuard {
    fn drop(&mut self) {
        self.hub.counter(self.role).fetch_sub(1, Ordering::SeqCst);
        self.hub.check_idle();
        self.hub.broadcast_state();
    }
}

impl Hub {
    pub fn new() -> Arc<Self> {
        let (tx, _) = broadcast::channel(BUS_CAPACITY);
        Arc::new(Self {
            tx,
            ui: AtomicUsize::new(0),
            cli: AtomicUsize::new(0),
            agent: AtomicUsize::new(0),
            ever_had_browser: AtomicBool::new(false),
            idle_gen: AtomicU64::new(0),
            idle_timer: Mutex::new(None),
            idle_shutdown_ms: AtomicU64::new(DEFAULT_IDLE_SHUTDOWN_MS),
            submitted: AtomicBool::new(false),
            shutting_down: AtomicBool::new(false),
            shutdown: Notify::new(),
            exit_cleanup: Mutex::new(None),
        })
    }

    /// Set the post-disconnect grace period. Called once at startup from the
    /// flag/env; a value of 0 means "shut down as soon as the last browser
    /// goes", which is what `--idle-timeout 0` is for.
    pub fn set_idle_shutdown_ms(&self, ms: u64) {
        self.idle_shutdown_ms.store(ms, Ordering::SeqCst);
    }

    pub fn idle_shutdown_ms(&self) -> u64 {
        self.idle_shutdown_ms.load(Ordering::SeqCst)
    }

    /// Record that the review was submitted, and end the server now if no
    /// browser is left to see it. Clicking Done reviewing in the last open tab
    /// is a statement that the review is over: the tab closes itself, its SSE
    /// stream drops, and there is nothing to wait out.
    pub fn mark_submitted(self: &Arc<Self>) {
        self.submitted.store(true, Ordering::SeqCst);
        self.check_idle();
    }

    pub fn set_exit_cleanup(&self, f: impl FnOnce() + Send + 'static) {
        *self.exit_cleanup.lock().unwrap_or_else(|e| e.into_inner()) = Some(Box::new(f));
    }

    fn counter(&self, role: Role) -> &AtomicUsize {
        match role {
            Role::Ui => &self.ui,
            Role::Cli => &self.cli,
            Role::Agent => &self.agent,
        }
    }

    /// Order is (cli, ui, agent). On the wire cli surfaces as
    /// `watcherCount` — the v1 name, from when SSE role=cli was
    /// `diffx watch`.
    pub fn counts(&self) -> (usize, usize, usize) {
        (
            self.cli.load(Ordering::SeqCst),
            self.ui.load(Ordering::SeqCst),
            self.agent.load(Ordering::SeqCst),
        )
    }

    /// Whether any UI client has ever connected — the launch-verification
    /// signal (a current count would miss connect-then-disconnect).
    pub fn had_browser(&self) -> bool {
        self.ever_had_browser.load(Ordering::SeqCst)
    }

    pub fn state_event(&self) -> Event {
        let (watcher_count, ui_count, agent_count) = self.counts();
        Event::State {
            watcher_count,
            ui_count,
            agent_count,
        }
    }

    pub fn broadcast(&self, event: Event) {
        let _ = self.tx.send(event); // no receivers is fine
    }

    pub fn broadcast_state(&self) {
        self.broadcast(self.state_event());
    }

    pub fn subscribe(self: &Arc<Self>, role: Role) -> (broadcast::Receiver<Event>, SubGuard) {
        let rx = self.tx.subscribe();
        self.counter(role).fetch_add(1, Ordering::SeqCst);
        self.check_idle();
        self.broadcast_state();
        (
            rx,
            SubGuard {
                hub: Arc::clone(self),
                role,
            },
        )
    }

    fn check_idle(self: &Arc<Self>) {
        if self.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        let ui = self.ui.load(Ordering::SeqCst);
        if ui > 0 {
            self.ever_had_browser.store(true, Ordering::SeqCst);
            self.idle_gen.fetch_add(1, Ordering::SeqCst);
            self.disarm_idle_timer();
            return;
        }
        if !self.ever_had_browser.load(Ordering::SeqCst) {
            return; // the no-browser timer owns this phase
        }
        // Submitted and the last tab gone: no grace period, no timer to race.
        if self.submitted.load(Ordering::SeqCst) {
            self.idle_gen.fetch_add(1, Ordering::SeqCst);
            self.disarm_idle_timer();
            println!("Review submitted and the last browser closed — shutting down.");
            self.initiate_shutdown(EndReason::Submitted);
            return;
        }
        let generation = self.idle_gen.fetch_add(1, Ordering::SeqCst) + 1;
        self.disarm_idle_timer();
        let hub = Arc::clone(self);
        let idle_ms = self.idle_shutdown_ms.load(Ordering::SeqCst);
        let handle = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(idle_ms)).await;
            if hub.idle_gen.load(Ordering::SeqCst) == generation
                && hub.ui.load(Ordering::SeqCst) == 0
            {
                println!("Idle shutdown: no browser connected.");
                hub.initiate_shutdown(EndReason::Idle);
            }
        });
        *self.idle_timer.lock().unwrap_or_else(|e| e.into_inner()) = Some(handle);
    }

    fn disarm_idle_timer(&self) {
        if let Some(handle) = self
            .idle_timer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            handle.abort();
        }
    }

    pub fn start_no_browser_timer(self: &Arc<Self>) {
        let hub = Arc::clone(self);
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(NO_BROWSER_TIMEOUT_MS)).await;
            if !hub.ever_had_browser.load(Ordering::SeqCst) {
                println!("No browser ever connected — shutting down.");
                hub.initiate_shutdown(EndReason::NoBrowser);
            }
        });
    }

    /// Terminal sequence: broadcast review-ended so every subscriber sees it
    /// land, give the forwarding tasks a beat to flush (they close their own
    /// streams on seeing the event, which is what lets graceful shutdown
    /// complete — v1's close-deadlock made unrepresentable), then signal
    /// shutdown, with a hard exit as belt-and-suspenders.
    pub fn initiate_shutdown(self: &Arc<Self>, reason: EndReason) {
        if self.shutting_down.swap(true, Ordering::SeqCst) {
            return;
        }
        self.broadcast(Event::ReviewEnded { reason });
        let hub = Arc::clone(self);
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            hub.shutdown.notify_waiters();
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            // Graceful drain stalled (e.g. a client not reading its socket);
            // run the cleanup the normal exit path would have.
            let cleanup = hub
                .exit_cleanup
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take();
            if let Some(f) = cleanup {
                f();
            }
            std::process::exit(0);
        });
    }
}

/// `tokio`'s `test-util` feature is off, so `start_paused` / `advance` are
/// unavailable and no test here may wait for a timer to *fire* — sleeping
/// out a real grace period is not a test anyone keeps. Everything below
/// asserts the
/// observable state the timers hang off instead: whether a timer is armed,
/// which generation it captured, and how many tasks are alive.
///
/// Nothing may let `initiate_shutdown`'s spawned task run to completion:
/// it ends in `process::exit(0)`, which would take the whole test binary
/// with it. It sleeps 300ms first, and dropping the runtime at test end
/// drops the task, so tests that touch shutdown must simply not linger.
#[cfg(test)]
mod tests {
    use super::*;

    fn armed(hub: &Arc<Hub>) -> bool {
        hub.idle_timer.lock().unwrap().is_some()
    }

    fn generation(hub: &Arc<Hub>) -> u64 {
        hub.idle_gen.load(Ordering::SeqCst)
    }

    /// Aborting is asynchronous: the task is only reaped once the runtime
    /// gets a chance to poll its cancellation, so `num_alive_tasks` lies
    /// until we yield.
    async fn alive_tasks() -> usize {
        for _ in 0..16 {
            tokio::task::yield_now().await;
        }
        tokio::runtime::Handle::current()
            .metrics()
            .num_alive_tasks()
    }

    #[tokio::test]
    async fn each_role_increments_only_its_own_counter() {
        let hub = Hub::new();
        let (_rx, _ui) = hub.subscribe(Role::Ui);
        assert_eq!(hub.counts(), (0, 1, 0));
        let (_rx, _cli) = hub.subscribe(Role::Cli);
        assert_eq!(hub.counts(), (1, 1, 0));
        let (_rx, _agent) = hub.subscribe(Role::Agent);
        assert_eq!(hub.counts(), (1, 1, 1));
    }

    #[tokio::test]
    async fn dropping_a_subscription_decrements_the_role_it_was_taken_for() {
        let hub = Hub::new();
        let (_rx, ui) = hub.subscribe(Role::Ui);
        let (_rx, cli) = hub.subscribe(Role::Cli);
        drop(cli);
        assert_eq!(hub.counts(), (0, 1, 0));
        drop(ui);
        assert_eq!(hub.counts(), (0, 0, 0));
    }

    #[tokio::test]
    async fn a_ui_subscriber_sets_had_browser_and_it_survives_the_disconnect() {
        let hub = Hub::new();
        assert!(!hub.had_browser());
        let (_rx, ui) = hub.subscribe(Role::Ui);
        assert!(hub.had_browser());
        drop(ui);
        assert!(hub.had_browser());
    }

    #[tokio::test]
    async fn cli_and_agent_subscribers_never_set_had_browser() {
        let hub = Hub::new();
        let (_rx, _cli) = hub.subscribe(Role::Cli);
        let (_rx, _agent) = hub.subscribe(Role::Agent);
        assert!(!hub.had_browser());
    }

    #[tokio::test]
    async fn no_idle_timer_arms_before_a_browser_has_ever_connected() {
        let hub = Hub::new();
        let (_rx, cli) = hub.subscribe(Role::Cli);
        drop(cli);
        assert!(
            !armed(&hub),
            "the no-browser timer owns the pre-browser phase"
        );
    }

    #[tokio::test]
    async fn losing_the_last_browser_arms_the_idle_timer() {
        let hub = Hub::new();
        let (_rx, ui) = hub.subscribe(Role::Ui);
        assert!(!armed(&hub));
        drop(ui);
        assert!(armed(&hub));
    }

    #[tokio::test]
    async fn a_cli_subscriber_alone_does_not_hold_the_server_alive() {
        let hub = Hub::new();
        let (_rx, ui) = hub.subscribe(Role::Ui);
        drop(ui);
        let (_rx, _cli) = hub.subscribe(Role::Cli);
        assert!(
            armed(&hub),
            "shutdown is keyed on browser presence; a cli subscriber must not cancel it"
        );
        let (_rx, _agent) = hub.subscribe(Role::Agent);
        assert!(armed(&hub));
    }

    #[tokio::test]
    async fn a_returning_browser_disarms_the_idle_timer() {
        let hub = Hub::new();
        let (_rx, ui) = hub.subscribe(Role::Ui);
        drop(ui);
        assert!(armed(&hub));
        let (_rx, _ui2) = hub.subscribe(Role::Ui);
        assert!(!armed(&hub));
    }

    #[tokio::test]
    async fn every_subscriber_event_invalidates_the_generation_an_armed_timer_captured() {
        let hub = Hub::new();
        let (_rx, ui) = hub.subscribe(Role::Ui);
        drop(ui);
        let armed_at = generation(&hub);
        // The handle can be aborted, but a timer already past its sleep can
        // only be stopped by the generation check — so cli/agent churn has to
        // move the generation too, not just browser transitions.
        let (_rx, cli) = hub.subscribe(Role::Cli);
        assert!(generation(&hub) > armed_at);
        let bumped = generation(&hub);
        drop(cli);
        assert!(generation(&hub) > bumped);
    }

    #[tokio::test]
    async fn a_reconnect_loop_with_no_browser_leaves_at_most_one_live_timer() {
        let hub = Hub::new();
        let (_rx, ui) = hub.subscribe(Role::Ui);
        drop(ui);
        for _ in 0..100 {
            let (_rx, cli) = hub.subscribe(Role::Cli);
            drop(cli);
        }
        assert!(
            alive_tasks().await <= 1,
            "superseded idle timers must be aborted, not merely made no-ops"
        );
    }

    #[tokio::test]
    async fn the_idle_grace_period_is_configurable_and_defaults_short() {
        let hub = Hub::new();
        assert_eq!(hub.idle_shutdown_ms(), DEFAULT_IDLE_SHUTDOWN_MS);
        const {
            assert!(
                DEFAULT_IDLE_SHUTDOWN_MS <= 10_000,
                "the default grace period only has to cover a page refresh"
            )
        };
        hub.set_idle_shutdown_ms(90_000);
        assert_eq!(hub.idle_shutdown_ms(), 90_000);
    }

    #[tokio::test]
    async fn submitting_with_a_browser_still_attached_changes_nothing_yet() {
        // Another tab is still open: Done reviewing in one of them must not
        // pull the server out from under the others.
        let hub = Hub::new();
        let (_rx, _ui) = hub.subscribe(Role::Ui);
        hub.mark_submitted();
        assert!(!hub.shutting_down.load(Ordering::SeqCst));
        assert!(!armed(&hub));
    }

    #[tokio::test]
    async fn the_last_browser_leaving_after_submit_shuts_down_without_waiting() {
        let hub = Hub::new();
        let (_rx, ui) = hub.subscribe(Role::Ui);
        hub.mark_submitted();
        drop(ui);
        assert!(
            hub.shutting_down.load(Ordering::SeqCst),
            "a submitted review has nothing left to grant a grace period to"
        );
        assert!(!armed(&hub), "shutdown is immediate, not a timer");
    }

    #[tokio::test]
    async fn submitting_after_the_last_browser_has_already_gone_shuts_down_too() {
        // The tab can drop its stream before the POST response lands. That
        // ordering must not leave the server waiting out the grace period.
        let hub = Hub::new();
        let (_rx, ui) = hub.subscribe(Role::Ui);
        drop(ui);
        assert!(armed(&hub));
        hub.mark_submitted();
        assert!(hub.shutting_down.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn a_cli_watcher_cannot_hold_a_submitted_review_open() {
        // Same rule as the ordinary idle path: only role=ui counts as a
        // browser, so `krit wait-for-submit` must not keep the port alive.
        let hub = Hub::new();
        let (_rx, ui) = hub.subscribe(Role::Ui);
        let (_rx, _cli) = hub.subscribe(Role::Cli);
        hub.mark_submitted();
        drop(ui);
        assert!(hub.shutting_down.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn shutting_down_stops_arming_new_idle_timers() {
        let hub = Hub::new();
        hub.initiate_shutdown(EndReason::Idle);
        let (_rx, ui) = hub.subscribe(Role::Ui);
        drop(ui);
        assert!(!armed(&hub));
    }

    #[tokio::test]
    async fn initiate_shutdown_broadcasts_review_ended_exactly_once() {
        let hub = Hub::new();
        let (mut rx, _guard) = hub.subscribe(Role::Ui);
        hub.initiate_shutdown(EndReason::Submitted);
        hub.initiate_shutdown(EndReason::Signal);
        loop {
            match rx.try_recv().expect("review-ended never landed") {
                Event::ReviewEnded { reason } => {
                    assert_eq!(reason, EndReason::Submitted);
                    break;
                }
                _ => continue,
            }
        }
        assert!(matches!(
            rx.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
    }

    #[tokio::test]
    async fn subscriber_changes_broadcast_the_current_counts() {
        let hub = Hub::new();
        let (mut rx, _ui) = hub.subscribe(Role::Ui);
        let (_rx2, cli) = hub.subscribe(Role::Cli);
        drop(cli);
        let mut last = None;
        while let Ok(ev) = rx.try_recv() {
            if let Event::State { .. } = ev {
                last = Some(ev);
            }
        }
        assert!(matches!(
            last,
            Some(Event::State {
                watcher_count: 0,
                ui_count: 1,
                agent_count: 0
            })
        ));
    }
}
