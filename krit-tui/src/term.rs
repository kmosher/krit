//! Owning the terminal, and giving it back.
//!
//! Raw mode and the alternate screen are *global* state: they outlive the
//! process that set them. Every exit path — a clean quit, a panic, a
//! `kill -TSTP`, a Ctrl+Z — has to pass back through here, because the one
//! that doesn't leaves the user in a shell that no longer echoes what they
//! type, with no clue what did it.

use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;
use ratatui::crossterm::event::{
    DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
    KeyboardEnhancementFlags, PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
};
use ratatui::crossterm::execute;
use ratatui::crossterm::terminal::{
    Clear, ClearType, EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode,
    enable_raw_mode, supports_keyboard_enhancement,
};
use std::io::{self, Stdout, stdout};
use std::sync::Arc;
use std::sync::Once;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

pub type Tui = Terminal<CrosstermBackend<Stdout>>;

/// Take the terminal, or leave it exactly as it was found.
///
/// Each step is fallible and the first one is the one with teeth, so a failure
/// in a later step has to undo it: raw mode set and then abandoned is the
/// shell-stops-echoing outcome this whole module exists to prevent, and it is
/// reachable — `enable_raw_mode` works through `/dev/tty` while the escape
/// sequences go to stdout, so `krit-tui | head` succeeds at the first and gets
/// EPIPE on the second.
fn enter_screen(mouse: bool, enhanced: bool) -> io::Result<()> {
    enable_raw_mode()?;
    if let Err(err) = execute!(stdout(), EnterAlternateScreen) {
        let _ = disable_raw_mode();
        return Err(err);
    }
    // Bracketed paste is not optional for the composer: without it, pasting a
    // three-line comment is three `Enter`s, and every terminal form that has
    // ever shipped without it submits after the first line. Not part of the
    // unwind below — a terminal that refuses it is one where paste is
    // character-by-character, which is worse than it was, not broken.
    let _ = execute!(stdout(), EnableBracketedPaste);
    if enhanced {
        // Only what the composer actually reads: disambiguation is what makes
        // `Ctrl+Enter` distinguishable from `Enter`. Reporting *all* keys as
        // escape codes would also report releases, which `action_for` already
        // has to filter and which nothing here wants.
        let _ = execute!(
            stdout(),
            PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES)
        );
    }
    if mouse && let Err(err) = execute!(stdout(), EnableMouseCapture) {
        let _ = leave_screen();
        return Err(err);
    }
    Ok(())
}

fn leave_screen() -> io::Result<()> {
    // Unconditionally released, whatever we think the state is: this runs from
    // a panic hook too, and a terminal left reporting mouse events writes
    // escape sequences into the user's next shell prompt every time they move
    // the pointer. Releasing one that was never taken costs nothing — and a
    // terminal left with the keyboard flags pushed reports keys nobody can
    // read, which is the same class of mess.
    let _ = execute!(stdout(), PopKeyboardEnhancementFlags);
    let _ = execute!(stdout(), DisableBracketedPaste);
    let _ = execute!(stdout(), DisableMouseCapture);
    // Raw mode next: it has the wider blast radius, so if only one of the
    // remaining two succeeds it should be this one.
    disable_raw_mode()?;
    execute!(stdout(), LeaveAlternateScreen)
}

/// Restore before panicking, so the backtrace is readable and the shell
/// survives. Installed once — re-entering the screen after a suspend must not
/// chain a second copy of this onto the hook the first one wrapped.
fn install_panic_hook() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let _ = leave_screen();
            previous(info);
        }));
    });
}

/// The terminal, held for as long as the viewer is on screen.
///
/// `Drop` is the backstop rather than the mechanism: `finish` is called on the
/// ordinary path so a failure to restore can be reported, and Drop covers the
/// paths that don't get there — `?` propagating out of the draw loop, or a
/// panic that the hook above has already handled (restoring twice is
/// harmless).
pub struct Session {
    restored: bool,
    /// Whether we are currently holding the mouse — remembered so that
    /// re-entering the screen after a suspend restores the same state rather
    /// than silently taking it back from a reviewer who gave it away.
    mouse: bool,
    /// Whether this terminal speaks the Kitty keyboard protocol. Asked once:
    /// the query is a round-trip with a timeout, and doing it again on every
    /// resume would put a blocking read on the path back from Ctrl+Z.
    enhanced: bool,
}

impl Session {
    pub fn start(mouse: bool) -> io::Result<(Self, Tui)> {
        install_panic_hook();
        // A DA1-style query with a timeout, so it costs something — but only
        // once, and the answer decides whether the footer may promise a
        // binding. `unwrap_or(false)` because a terminal that will not say is
        // one to assume the least of.
        let enhanced = supports_keyboard_enhancement().unwrap_or(false);
        enter_screen(mouse, enhanced)?;
        let terminal = Terminal::new(CrosstermBackend::new(stdout()))?;
        Ok((
            Session {
                restored: false,
                mouse,
                enhanced,
            },
            terminal,
        ))
    }

    /// Whether `Ctrl+Enter` is distinguishable from `Enter` here. The composer
    /// works either way; the footer has to say which.
    pub fn keyboard_enhanced(&self) -> bool {
        self.enhanced
    }

    /// Take or release the mouse mid-session.
    ///
    /// Releasing it is a real feature, not a debug affordance: capture takes
    /// over the terminal's own selection, so with it on there is no way to
    /// drag-select a line and copy it — which is a thing people do to a diff
    /// constantly.
    pub fn set_mouse(&mut self, on: bool) -> io::Result<()> {
        if self.mouse == on {
            return Ok(());
        }
        self.mouse = on;
        if on {
            execute!(stdout(), EnableMouseCapture)
        } else {
            execute!(stdout(), DisableMouseCapture)
        }
    }

    /// Hand the terminal back and stop the process the way the shell expects.
    /// Returns once something has continued us, with the screen re-entered.
    ///
    /// The re-raise has to use the *default* disposition: raising SIGTSTP
    /// while our own handler is installed would just set the flag again and
    /// never stop, which reads as Ctrl+Z doing nothing.
    pub fn suspend(&mut self, terminal: &mut Tui) -> io::Result<()> {
        leave_screen()?;
        self.restored = true;
        let _ = signal_hook::low_level::emulate_default_handler(signal_hook::consts::SIGTSTP);
        // `restored` stays true across the re-entry and is cleared only once
        // it succeeds. That is the truth in both outcomes, because
        // `enter_screen` unwinds its own partial failure: if this returns Err,
        // the terminal really is still the shell's, and `finish` is right to
        // do nothing.
        enter_screen(self.mouse, self.enhanced)?;
        self.restored = false;

        // Whoever had the terminal while we were stopped drew on it, and
        // ratatui's back buffer still describes our own last frame — so a
        // diff-based redraw would paint almost nothing over whatever is
        // there. Wipe the screen and start from a terminal with no history.
        //
        // Not `Terminal::clear()`: that snapshots the cursor first, and
        // reading the cursor is a DSR round-trip — we write `ESC[6n` and
        // block until the terminal answers. It times out under anything that
        // doesn't answer promptly, and it is asking for a position we are
        // about to overwrite anyway. Losing `fg` to a two-second timeout is
        // a bad trade for a cursor we do not want.
        execute!(stdout(), Clear(ClearType::All))?;
        *terminal = Terminal::new(CrosstermBackend::new(stdout()))?;
        Ok(())
    }

    pub fn finish(&mut self) -> io::Result<()> {
        if self.restored {
            return Ok(());
        }
        self.restored = true;
        leave_screen()
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.finish();
    }
}

/// How a wait for input ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Input {
    /// There is something for crossterm to read.
    Ready,
    /// The wait elapsed with nothing to read.
    Idle,
    /// The terminal is gone: the far end of the pty closed. Nothing will ever
    /// arrive again, and every write from here on is into a void.
    Gone,
}

/// The terminal we read from, held open so the loop can ask whether it is
/// still there.
///
/// **This exists because `event::poll` does not return once the terminal
/// dies.** crossterm waits by reading, and a pty slave whose master has closed
/// is readable forever, yielding zero bytes — so `poll_internal` spins inside
/// its own deadline loop and the draw loop never gets another iteration. The
/// cost is not merely a wasted core: the loop is where *every* signal is
/// answered, so a wedged poll makes `SIGTERM`, `SIGHUP` and `SIGINT` all
/// unanswerable and the process needs `SIGKILL`. That was a `krit-tui`
/// orphaned by a closed tmux session, pegging a core for two days.
///
/// So the loop waits *here* instead, on the same `/dev/tty` crossterm reads
/// (the file `enable_raw_mode` works through), and only hands off once there is
/// something to parse. `EV_EOF` is the answer `read` cannot give: EOF and "no
/// input yet" are the same zero bytes, and only the event filter separates them.
///
/// **`select(2)`, because this is macOS and a terminal is a device.** The two
/// obvious mechanisms are both unavailable here, each failing in a way that
/// reads as a different bug:
/// - `poll` does not work on device files on Darwin. On a `/dev/tty` it returns
///   `POLLNVAL` (`0x20`) immediately and forever; read as "the terminal is
///   gone" that is worse than the wedge it replaces, because the viewer then
///   quits the instant it starts — cleanly, empty screen, exit status 0.
/// - `kqueue` refuses a tty outright: registering `EVFILT_READ` on one returns
///   `EINVAL`. This is the same Darwin limitation libuv carries a dedicated
///   `select`-on-a-thread workaround for. A failed registration is silent, so
///   the fallback path just quietly restores the original wedge.
///
/// `select` works on ttys, but answers a narrower question — readable or not —
/// and at EOF a pty slave is readable forever. So readability alone cannot say
/// the terminal died, and `is_gone` answers that separately.
pub struct Tty {
    fd: std::os::fd::OwnedFd,
}

impl Tty {
    /// Opens the controlling terminal and registers it for read events.
    ///
    /// `None` for any failure, including having no controlling terminal at all
    /// (`/dev/tty` is `ENXIO` then). That is not worth reporting: a viewer with
    /// no terminal has nothing to watch for, and the loop falls back to
    /// crossterm's own wait rather than refusing to start over a watchdog.
    pub fn open() -> Option<Self> {
        use std::os::fd::{AsRawFd, OwnedFd};
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open("/dev/tty")
            .ok()?;
        let fd: OwnedFd = file.into();
        // `select` cannot express a descriptor at or past `FD_SETSIZE`, and
        // setting one anyway is a buffer overrun rather than an error. A tty
        // opened this early is always a low number; bailing here means the
        // fallback path, not a corrupted stack.
        if fd.as_raw_fd() < 0 || fd.as_raw_fd() as usize >= libc::FD_SETSIZE {
            return None;
        }
        Some(Tty { fd })
    }

    /// Readable, but with how many bytes? `None` if the question failed.
    ///
    /// **Readable-with-nothing-to-read is the only evidence a dead terminal
    /// ever gives.** Every other thing that looks like it should notice keeps
    /// reporting rude health once the far end of the pty closes: `/dev/tty`
    /// still opens, `isatty` is still 1, `tcgetattr` and `tcgetpgrp` both still
    /// succeed. The single value that changes anywhere is a `read` returning 0
    /// — an EOF indistinguishable, to anything that does not already know the
    /// fd was readable, from "no input yet".
    ///
    /// So the test is `FIONREAD` rather than a `read`: it asks exactly what a
    /// read would find and consumes nothing. Reading here would race crossterm
    /// for the same input queue and could swallow a byte out of the middle of
    /// an escape sequence — a keystroke lost, or worse, silently reinterpreted.
    fn readable_bytes(&self) -> Option<usize> {
        use std::os::fd::AsRawFd;
        let mut n: libc::c_int = 0;
        // Safety: FIONREAD writes one int through the pointer.
        let rc = unsafe { libc::ioctl(self.fd.as_raw_fd(), libc::FIONREAD, &mut n) };
        if rc < 0 || n < 0 {
            return None;
        }
        Some(n as usize)
    }

    /// Wait up to `timeout` for input, or for the terminal to disappear.
    pub fn wait(&self, timeout: Duration) -> Input {
        use std::os::fd::AsRawFd;
        // Anything crossterm has already parsed and buffered is invisible to
        // the kernel — it lives in crossterm's own queue, not in the fd.
        // Asking it first (with no timeout, so this cannot block) keeps a
        // buffered keystroke from waiting out a whole tick.
        if matches!(ratatui::crossterm::event::poll(Duration::ZERO), Ok(true)) {
            return Input::Ready;
        }
        let raw = self.fd.as_raw_fd();
        let mut set = std::mem::MaybeUninit::<libc::fd_set>::uninit();
        // Safety: `FD_ZERO` initialises the whole set, which is what makes the
        // `assume_init` below sound; `raw` was bounds-checked in `open`.
        let mut set = unsafe {
            libc::FD_ZERO(set.as_mut_ptr());
            let mut set = set.assume_init();
            libc::FD_SET(raw, &mut set);
            set
        };
        let mut tv = libc::timeval {
            tv_sec: timeout.as_secs() as libc::time_t,
            tv_usec: timeout.subsec_micros() as libc::suseconds_t,
        };
        // Safety: one initialised set holding one in-range descriptor.
        let n = unsafe {
            libc::select(
                raw + 1,
                &mut set,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut tv,
            )
        };
        // A negative return is EINTR in practice — a signal arriving, which is
        // precisely what the loop is being freed up to answer. Report an
        // ordinary idle tick and let the flag check upstairs do its job.
        if n <= 0 {
            return Input::Idle;
        }
        // Readable, which is *not* the same as "the terminal is alive": a pty
        // slave whose master closed is readable forever and yields nothing,
        // which is the whole failure this type exists for.
        //
        // Zero bytes waiting on a readable descriptor means EOF here, and it
        // cannot be confused with a half-arrived escape sequence: the crossterm
        // poll above already drained anything pending into its own parser, so a
        // partial sequence leaves the descriptor *not* readable and never
        // reaches this line. `None` is a question we could not ask, which is no
        // evidence of death — carry on and let the loop keep running.
        match self.readable_bytes() {
            Some(0) => Input::Gone,
            _ => Input::Ready,
        }
    }
}

/// The signals that must not be allowed to kill us where they land.
///
/// Every one of these has a default disposition that ends the process without
/// unwinding — no panic hook, no `Drop`, so no `leave_screen` — and the
/// terminal is left in raw mode with the alternate screen up and the mouse
/// captured. Handling them turns each into an ordinary request the loop
/// answers on its own terms.
///
/// Note which signals do *not* arrive here. Ctrl+Z and Ctrl+C are keys, not
/// signals: raw mode turns off ISIG, so the terminal never generates SIGTSTP
/// or SIGINT from them and `app::action_for` maps both directly. That makes
/// these the *external* paths — `kill`, a supervisor, a closed terminal — and
/// they are exactly the ones a reviewer reaches for when the viewer looks
/// stuck. Forgetting either half is a suspend or a quit that strands the
/// shell.
pub struct Signals {
    suspend: Arc<AtomicBool>,
    quit: Arc<AtomicBool>,
}

impl Signals {
    pub fn register() -> io::Result<Self> {
        let suspend = Arc::new(AtomicBool::new(false));
        let quit = Arc::new(AtomicBool::new(false));
        // Flags rather than a handler thread: setting an atomic is one of the
        // few things that is safe to do inside a signal handler.
        signal_hook::flag::register(signal_hook::consts::SIGTSTP, Arc::clone(&suspend))?;
        for signal in [
            signal_hook::consts::SIGTERM,
            signal_hook::consts::SIGINT,
            signal_hook::consts::SIGHUP,
        ] {
            signal_hook::flag::register(signal, Arc::clone(&quit))?;
        }
        Ok(Self { suspend, quit })
    }

    /// True once per signal received.
    pub fn suspend_requested(&self) -> bool {
        self.suspend.swap(false, Ordering::Relaxed)
    }

    pub fn quit_requested(&self) -> bool {
        self.quit.swap(false, Ordering::Relaxed)
    }
}
