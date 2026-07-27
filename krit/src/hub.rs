//! The event core: one broadcast bus that every subscriber — SSE (browser,
//! CLI), ws (agent), and the lifecycle logic itself — hangs off. Presence
//! counting and principal-based idle shutdown are bus-level concerns here,
//! not transport handlers' — v1's hardest bugs lived in that gap.

use crate::types::Event;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{Notify, broadcast};

/// Broadcast depth. Receivers treat Lagged as "skip the missed frames", so an
/// overrun silently drops events (worst case a missed `submitted`). Sized so
/// a mass-checkout burst — one file-changed per touched file plus one
/// comment-updated per re-anchored comment in a single debounce tick —
/// doesn't overrun a momentarily slow subscriber.
const BUS_CAPACITY: usize = 2048;

/// Grace period after the last browser tab disconnects before the server
/// shuts itself down — long enough to survive a page refresh. Keyed on
/// browser (role ui) presence only: a CLI or agent subscriber must never
/// hold the server alive on its own.
const IDLE_SHUTDOWN_MS: u64 = 60_000;

/// If no browser EVER connects within this window of start, nobody's
/// reviewing — shut down instead of running forever.
const NO_BROWSER_TIMEOUT_MS: u64 = 180_000;

#[derive(Clone, Copy, PartialEq)]
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
            shutting_down: AtomicBool::new(false),
            shutdown: Notify::new(),
            exit_cleanup: Mutex::new(None),
        })
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
        let generation = self.idle_gen.fetch_add(1, Ordering::SeqCst) + 1;
        self.disarm_idle_timer();
        let hub = Arc::clone(self);
        let handle = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(IDLE_SHUTDOWN_MS)).await;
            if hub.idle_gen.load(Ordering::SeqCst) == generation
                && hub.ui.load(Ordering::SeqCst) == 0
            {
                println!("Idle shutdown: no browser connected.");
                hub.initiate_shutdown("idle");
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
                hub.initiate_shutdown("no-browser");
            }
        });
    }

    /// Terminal sequence: broadcast review-ended so every subscriber sees it
    /// land, give the forwarding tasks a beat to flush (they close their own
    /// streams on seeing the event, which is what lets graceful shutdown
    /// complete — v1's close-deadlock made unrepresentable), then signal
    /// shutdown, with a hard exit as belt-and-suspenders.
    pub fn initiate_shutdown(self: &Arc<Self>, reason: &str) {
        if self.shutting_down.swap(true, Ordering::SeqCst) {
            return;
        }
        self.broadcast(Event::ReviewEnded {
            reason: reason.to_string(),
        });
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
