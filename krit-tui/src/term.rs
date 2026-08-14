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
    /// Hand off to crossterm: either it has a buffered event already, or the
    /// descriptor has bytes — or the liveness question could not be asked,
    /// which is not evidence of death. Deliberately *not* a promise that a
    /// blocking read would return: readability, parseability and liveness are
    /// three different questions, which is the whole reason this type exists.
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
/// something to parse.
///
/// **The wait is `select(2)` on every unix.** Nothing here is conditionally
/// compiled: `select` works on ttys everywhere, and it is the mechanism because
/// the two more obvious ones are unavailable on Darwin, each failing in a way
/// that reads as a different bug:
/// - `poll` does not work on device files there. On a `/dev/tty` it returns
///   `POLLNVAL` (`0x20`) immediately and forever; read as "the terminal is
///   gone" that is worse than the wedge it replaces, because the viewer then
///   quits the instant it starts — cleanly, empty screen, exit status 0.
/// - `kqueue` refuses a tty outright: registering `EVFILT_READ` on one returns
///   `EINVAL`. This is the same Darwin limitation libuv carries a dedicated
///   `select`-on-a-thread workaround for. A failed registration is silent, so
///   the fallback path just quietly restores the original wedge.
///
/// `select` answers a narrower question than we need — readable or not — and at
/// EOF a pty slave is readable forever. So readability alone cannot say the
/// terminal died; `readable_bytes` is what separates the two.
pub struct Tty {
    fd: std::os::fd::OwnedFd,
}

/// Can `select` name this descriptor at all?
///
/// A soundness check, not a courtesy: `select` has no way to express a
/// descriptor at or past `FD_SETSIZE`, and `FD_SET` on one writes outside the
/// set rather than returning an error. Its own function so the bound can be
/// tested without conjuring an `OwnedFd` for a descriptor the test does not own
/// — dropping one of those closes a stranger's file, and aborts the process if
/// the close fails.
fn fd_is_selectable(raw: libc::c_int) -> bool {
    raw >= 0 && (raw as usize) < libc::FD_SETSIZE
}

impl Tty {
    /// Opens the controlling terminal and holds it for the life of the viewer.
    ///
    /// `None` for any failure, including having no controlling terminal at all
    /// (`/dev/tty` is `ENXIO` then). That is not worth reporting: a viewer with
    /// no terminal has nothing to watch for, and the loop falls back to
    /// crossterm's own wait rather than refusing to start over a watchdog.
    pub fn open() -> Option<Self> {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open("/dev/tty")
            .ok()?;
        Self::from_fd(file.into())
    }

    /// Wrap an already-open descriptor, refusing one `select` cannot name (see
    /// `fd_is_selectable`). A tty opened as early as we do is always a low
    /// number, so refusing means the caller falls back to crossterm's own wait
    /// rather than corrupting the stack.
    fn from_fd(fd: std::os::fd::OwnedFd) -> Option<Self> {
        use std::os::fd::AsRawFd;
        if !fd_is_selectable(fd.as_raw_fd()) {
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
        // Anything crossterm has already parsed and buffered is invisible to
        // the kernel — it lives in crossterm's own queue, not in the fd.
        // Asking it first (with no timeout, so this cannot block) keeps a
        // buffered keystroke from waiting out a whole tick, and is what makes
        // the zero-bytes rule below unambiguous.
        if matches!(ratatui::crossterm::event::poll(Duration::ZERO), Ok(true)) {
            return Input::Ready;
        }
        self.wait_on_fd(timeout)
    }

    /// The half of `wait` that is only about the descriptor.
    ///
    /// Split out because it is the testable half: it consults nothing but the
    /// fd, so a test can drive it against a pair it controls, where `wait`
    /// itself would consult the *test runner's* terminal through crossterm.
    fn wait_on_fd(&self, timeout: Duration) -> Input {
        use std::os::fd::AsRawFd;
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
        if n == 0 {
            return Input::Idle;
        }
        if n < 0 {
            let err = io::Error::last_os_error();
            return match err.raw_os_error() {
                // A signal arrived, which is precisely what the loop is being
                // freed up to answer. An ordinary idle tick; the flag check
                // upstairs does the rest.
                Some(libc::EINTR) | Some(libc::EAGAIN) => Input::Idle,
                // Anything else is a descriptor we can no longer wait on, and
                // waiting is the only thing keeping this loop from spinning:
                // `select` failing for a structural reason (EBADF, EINVAL)
                // fails *immediately*, so treating it as idle would peg a core
                // exactly as the wedge this type replaces did. A terminal we
                // cannot wait on is one we cannot read either, so say so and
                // let the viewer exit through its normal path with the screen
                // restored.
                _ => Input::Gone,
            };
        }
        // Readable, which is *not* the same as "the terminal is alive": a pty
        // slave whose master closed is readable forever and yields nothing,
        // which is the whole failure this type exists for.
        //
        // Zero bytes waiting on a readable descriptor means EOF here, and it
        // cannot be confused with a half-arrived escape sequence: the crossterm
        // poll above already drained anything pending into its own parser, so a
        // partial sequence leaves the descriptor *not* readable and never
        // reaches this line.
        match self.readable_bytes() {
            Some(0) => Input::Gone,
            Some(_) => Input::Ready,
            // A question we could not ask is no evidence of death — but it is
            // also no evidence of life, and the caller's `Ready` arm does not
            // block: at EOF it would find no event, come straight back, and
            // `select` would report readable again instantly. That is a spin,
            // so this branch has to supply the wait `select` just failed to.
            // Sleeping the tick keeps the loop bounded without claiming the
            // terminal is dead, and costs at most one tick of input latency in
            // a case that should never happen — crossterm's own poll at the
            // top of the next call still picks up anything real.
            None => {
                std::thread::sleep(timeout);
                Input::Idle
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::{FromRawFd, OwnedFd};

    /// A connected pair of descriptors, standing in for a pty.
    ///
    /// A `socketpair` rather than an `openpty`, deliberately. What is under
    /// test is the classification — readable-with-bytes against
    /// readable-with-none against nothing-to-read — and that is fd-generic:
    /// both kinds go readable on write and readable-forever-yielding-nothing
    /// when the far end closes, which is the whole shape `wait_on_fd` decodes.
    /// The tty-specific facts (`poll` returning `POLLNVAL`, `kqueue` refusing
    /// to register) are why `select` was chosen, not what the classification
    /// does with it. A pty would also make the test unrunnable in a sandbox,
    /// where `openpty` is denied outright — a test that silently stops running
    /// is worse than one that stands in.
    fn pair() -> (OwnedFd, OwnedFd) {
        let mut fds = [0 as libc::c_int; 2];
        // Safety: writes two descriptors into a two-element array.
        let rc = unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) };
        assert_eq!(rc, 0, "socketpair: {}", io::Error::last_os_error());
        // Safety: socketpair just handed us both, and neither is owned elsewhere.
        unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) }
    }

    fn write_byte(fd: &OwnedFd) {
        use std::os::fd::AsRawFd;
        let byte = b"x";
        // Safety: one byte from a valid pointer.
        let n = unsafe { libc::write(fd.as_raw_fd(), byte.as_ptr() as *const libc::c_void, 1) };
        assert_eq!(n, 1, "write: {}", io::Error::last_os_error());
    }

    const TICK: Duration = Duration::from_millis(50);

    #[test]
    fn a_quiet_terminal_is_idle() {
        let (ours, _theirs) = pair();
        let tty = Tty::from_fd(ours).expect("a fresh fd is inside FD_SETSIZE");
        assert_eq!(tty.wait_on_fd(TICK), Input::Idle);
    }

    #[test]
    fn bytes_waiting_are_ready() {
        let (ours, theirs) = pair();
        write_byte(&theirs);
        let tty = Tty::from_fd(ours).expect("a fresh fd is inside FD_SETSIZE");
        assert_eq!(tty.wait_on_fd(TICK), Input::Ready);
    }

    /// The bug this whole type exists for: the far end goes away, and the
    /// descriptor answers *readable* forever while yielding nothing. Anything
    /// that treats readability as liveness spins here, and a spinning draw loop
    /// answers no signals — which is what made the original orphan need
    /// SIGKILL.
    #[test]
    fn a_closed_far_end_is_gone_rather_than_endlessly_ready() {
        let (ours, theirs) = pair();
        drop(theirs);
        let tty = Tty::from_fd(ours).expect("a fresh fd is inside FD_SETSIZE");
        assert_eq!(tty.wait_on_fd(TICK), Input::Gone);
        // Twice, because the answer has to be stable: the loop calls this every
        // tick, and a `Gone` that decayed into `Ready` on the next pass would
        // be the spin with an extra step.
        assert_eq!(tty.wait_on_fd(TICK), Input::Gone);
    }

    /// Unread bytes outrank the far end's departure. A terminal can deliver a
    /// last burst and then close, and dropping it would lose the reviewer's
    /// final keystroke to a race they cannot see.
    #[test]
    fn a_last_burst_is_read_before_the_close_is_reported() {
        let (ours, theirs) = pair();
        write_byte(&theirs);
        drop(theirs);
        let tty = Tty::from_fd(ours).expect("a fresh fd is inside FD_SETSIZE");
        assert_eq!(tty.wait_on_fd(TICK), Input::Ready);
    }

    /// The bound is checked by number rather than by opening 1024 descriptors:
    /// same branch, no fixture. It is tested at all because exceeding it is not
    /// an error anyone reports — `FD_SET` just writes past the end of the set.
    #[test]
    fn a_descriptor_select_cannot_name_is_refused() {
        assert!(fd_is_selectable(0));
        assert!(fd_is_selectable(libc::FD_SETSIZE as libc::c_int - 1));
        assert!(!fd_is_selectable(libc::FD_SETSIZE as libc::c_int));
        assert!(!fd_is_selectable(-1));
    }
}
