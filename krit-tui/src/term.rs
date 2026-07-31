//! Owning the terminal, and giving it back.
//!
//! Raw mode and the alternate screen are *global* state: they outlive the
//! process that set them. Every exit path — a clean quit, a panic, a
//! `kill -TSTP`, a Ctrl+Z — has to pass back through here, because the one
//! that doesn't leaves the user in a shell that no longer echoes what they
//! type, with no clue what did it.

use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;
use ratatui::crossterm::event::{DisableMouseCapture, EnableMouseCapture};
use ratatui::crossterm::execute;
use ratatui::crossterm::terminal::{
    Clear, ClearType, EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use std::io::{self, Stdout, stdout};
use std::sync::Arc;
use std::sync::Once;
use std::sync::atomic::{AtomicBool, Ordering};

pub type Tui = Terminal<CrosstermBackend<Stdout>>;

fn enter_screen(mouse: bool) -> io::Result<()> {
    enable_raw_mode()?;
    execute!(stdout(), EnterAlternateScreen)?;
    if mouse {
        execute!(stdout(), EnableMouseCapture)?;
    }
    Ok(())
}

fn leave_screen() -> io::Result<()> {
    // Unconditionally released, whatever we think the state is: this runs from
    // a panic hook too, and a terminal left reporting mouse events writes
    // escape sequences into the user's next shell prompt every time they move
    // the pointer. Releasing one that was never taken costs nothing.
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
}

impl Session {
    pub fn start(mouse: bool) -> io::Result<(Self, Tui)> {
        install_panic_hook();
        enter_screen(mouse)?;
        let terminal = Terminal::new(CrosstermBackend::new(stdout()))?;
        Ok((
            Session {
                restored: false,
                mouse,
            },
            terminal,
        ))
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
        enter_screen(self.mouse)?;
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

/// A `kill -TSTP` from outside the terminal.
///
/// Ctrl+Z does *not* arrive here: raw mode turns off ISIG, so the key never
/// becomes a signal and reaches the app as an ordinary Ctrl+Z key event. Both
/// paths have to end up calling `Session::suspend`, and forgetting either one
/// is a suspend that leaves the screen in raw mode.
pub struct SuspendSignal {
    flag: Arc<AtomicBool>,
}

impl SuspendSignal {
    pub fn register() -> io::Result<Self> {
        let flag = Arc::new(AtomicBool::new(false));
        // A flag rather than a handler thread: setting an atomic is one of the
        // few things that is safe to do inside a signal handler.
        signal_hook::flag::register(signal_hook::consts::SIGTSTP, Arc::clone(&flag))?;
        Ok(Self { flag })
    }

    /// True once per signal received.
    pub fn take(&self) -> bool {
        self.flag.swap(false, Ordering::Relaxed)
    }
}
