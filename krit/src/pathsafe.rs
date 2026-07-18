//! Path traversal defense, shared by every handler that touches the repo
//! from a client-supplied relative path.

/// Percent-decode without pulling in a dep; invalid sequences pass through
/// verbatim (matching decodeURIComponent-with-fallback in v1).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = &s[i + 1..i + 3];
            if let Ok(v) = u8::from_str_radix(hex, 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// True when `relative_path` cannot escape `base`: no `..`, no NUL, not
/// absolute (unix or windows-drive), after percent-decoding and backslash
/// normalization. Purely lexical — the file need not exist.
pub fn is_safe_path(relative_path: &str) -> bool {
    let normalized = percent_decode(relative_path).replace('\\', "/");
    if normalized.contains("..") || normalized.contains('\0') {
        return false;
    }
    if normalized.starts_with('/') {
        return false;
    }
    // Windows drive letters ("C:/...") — not expected on this platform but
    // cheap to reject.
    let mut chars = normalized.chars();
    if let (Some(c), Some(':')) = (chars.next(), chars.next())
        && c.is_ascii_alphabetic()
    {
        return false;
    }
    true
}
