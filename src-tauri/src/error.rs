//! One error shape for every command.
//!
//! Before this module, all 88 commands returned `Result<T, String>` and the
//! frontend rendered `String(e)` straight into a banner. A Windows developer
//! whose VHD compaction failed read `Os { code: 5, kind: PermissionDenied }`,
//! which names the syscall and not the cause. The actual cause is almost always
//! one of about a dozen things, and every one of them has a next step.
//!
//! So the string is classified here, at the boundary where it is produced,
//! rather than in the frontend where the command that produced it is no longer
//! known. `message` is a complete sentence safe to show as-is, `hint` is the
//! recovery, and `detail` keeps the original text behind a disclosure - the
//! product's whole thesis is that it never hides what actually happened.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorKind {
    /// Windows refused the operation outright.
    Permission,
    /// The operation needs administrator rights and did not get them.
    Elevation,
    /// Something else holds the file or the distro handle.
    Busy,
    /// The file, distro, image or container is gone.
    NotFound,
    /// The drive has no room for the result.
    DiskFull,
    /// The Docker engine is not answering.
    DockerDown,
    /// WSL is missing, stopped, or has no distros.
    WslDown,
    /// A download or registry call did not complete.
    Network,
    /// The operation ran past its deadline.
    Timeout,
    /// The user backed out, including declining a UAC prompt.
    Cancelled,
    /// The input or the tool's output was not what the command expected.
    Invalid,
    /// Classified as nothing in particular. `message` falls back to the raw text.
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
pub struct AtlasError {
    pub kind: ErrorKind,
    /// One plain sentence naming the cause. Never a code, never a Rust type.
    pub message: String,
    /// What to do next. `None` when the kind does not imply a single next step.
    pub hint: Option<String>,
    /// The original text from Windows, Docker or WSL, when it adds anything the
    /// message does not already say.
    pub detail: Option<String>,
}

impl AtlasError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into(), hint: None, detail: None }
    }

    pub fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    pub fn detail(mut self, detail: impl Into<String>) -> Self {
        let d = detail.into();
        let d = d.trim();
        if !d.is_empty() {
            self.detail = Some(d.to_string());
        }
        self
    }

    /// An input the command itself rejected. These are our own messages, so they
    /// are already written for a human and pass through unchanged.
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Invalid, message)
    }
}

impl std::fmt::Display for AtlasError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for AtlasError {}

/// Every `?` on a `Result<_, String>` inside a command lands here. That is the
/// point: the 60-odd existing `map_err(|e| e.to_string())` sites did not have to
/// change to start producing a classified error.
impl From<String> for AtlasError {
    fn from(raw: String) -> Self {
        classify(&raw)
    }
}

impl From<&str> for AtlasError {
    fn from(raw: &str) -> Self {
        classify(raw)
    }
}

impl From<std::io::Error> for AtlasError {
    fn from(e: std::io::Error) -> Self {
        classify(&e.to_string())
    }
}

/// Match the raw text against the failures this app actually hits on Windows.
///
/// Order matters: elevation is checked before permission because a declined UAC
/// prompt also reports as access-denied, and the recovery is different. Kept as
/// a flat scan of lowercase substrings rather than regex, because the inputs are
/// Windows error text, `docker` stderr and `wsl` stderr, none of which are
/// stable enough to be worth a grammar.
pub fn classify(raw: &str) -> AtlasError {
    let t = raw.to_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| t.contains(n));

    // Ours already, from `AtlasError::invalid` upstream or a hand-written check.
    // Nothing to classify and nothing to add.
    if raw.is_empty() {
        return AtlasError::new(ErrorKind::Unknown, "The operation failed without reporting a reason.")
            .hint("Re-run it with the terminal panel open to see the raw output.");
    }

    if has(&["cancelled by the user", "canceled by the user", "operation was canceled", "administrator access was cancelled", "requires elevation", "os error 740", "the operation was cancelled by the user"]) {
        return AtlasError::new(ErrorKind::Elevation, "Administrator approval was not given.")
            .hint("Windows needs elevated rights for this one. Run it again and approve the prompt.")
            .detail(raw);
    }

    if has(&["access is denied", "permission denied", "permissiondenied", "os error 5", "not authorized", "access to the path"]) {
        return AtlasError::new(ErrorKind::Permission, "Windows denied access.")
            .hint("Something is holding the file, or the path sits outside your account's reach. Stop the distro or container that uses it and try again.")
            .detail(raw);
    }

    if has(&["being used by another process", "os error 32", "sharing violation", "resource busy", "is currently in use", "device or resource busy", "text file busy", "os error 33"]) {
        return AtlasError::new(ErrorKind::Busy, "The file is open in another program.")
            .hint("A running distro or container is the usual holder. Stop it, then try again.")
            .detail(raw);
    }

    if has(&["no space left", "not enough space", "os error 112", "insufficient disk space", "disk full", "no space available"]) {
        return AtlasError::new(ErrorKind::DiskFull, "The drive ran out of room.")
            .hint("Free some space and try again. Docker's own reclaimable space is on the Prune page.")
            .detail(raw);
    }

    if has(&["cannot connect to the docker daemon", "is the docker daemon running", "error during connect", "docker_engine", "docker daemon is not running"]) {
        return AtlasError::new(ErrorKind::DockerDown, "The Docker engine is not answering.")
            .hint("Start Docker Desktop and wait for it to finish starting, then try again.")
            .detail(raw);
    }

    if has(&["wsl is not installed", "has no installed distributions", "no installed distributions", "wsl/service/", "the wsl optional component is not enabled", "wsl2 is not supported"]) {
        return AtlasError::new(ErrorKind::WslDown, "WSL is not available right now.")
            .hint("Check that WSL is installed and running. `wsl --status` reports what is missing.")
            .detail(raw);
    }

    if has(&["is not a registered distribution", "cannot find the file", "cannot find the path", "os error 2", "os error 3", "no such file", "not found", "does not exist"]) {
        return AtlasError::new(ErrorKind::NotFound, "It is not there any more.")
            .hint("Refresh to pick up the current state. Something else may have removed it.")
            .detail(raw);
    }

    if has(&["could not resolve", "dns", "connection refused", "network is unreachable", "os error 10054", "os error 10060", "os error 11001", "certificate", "tls", "connection reset"]) {
        return AtlasError::new(ErrorKind::Network, "The download did not complete.")
            .hint("Check the connection and try again. This is the only step in the app that needs the network.")
            .detail(raw);
    }

    if has(&["timed out", "timeout", "deadline exceeded"]) {
        return AtlasError::new(ErrorKind::Timeout, "The operation ran past its time limit.")
            .hint("It may still be finishing in the background. Refresh before starting it again.")
            .detail(raw);
    }

    if has(&["cancelled", "canceled", "aborted"]) {
        return AtlasError::new(ErrorKind::Cancelled, "The operation was cancelled.").detail(raw);
    }

    // Nothing matched. The raw text is the best available message, so show it
    // rather than replacing a specific failure with a vague one. No `detail`,
    // because it would repeat the message verbatim.
    AtlasError::new(ErrorKind::Unknown, raw.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One check per branch that has a distinct recovery, plus the two ordering
    /// traps: a declined UAC prompt also says "access is denied", and a missing
    /// docker pipe also says "cannot find the file".
    #[test]
    fn classifies_the_failures_this_app_actually_hits() {
        assert_eq!(classify("Os { code: 5, kind: PermissionDenied }").kind, ErrorKind::Permission);
        assert_eq!(classify("The requested operation requires elevation. (os error 740)").kind, ErrorKind::Elevation);
        assert_eq!(classify("Administrator access was cancelled.").kind, ErrorKind::Elevation);
        assert_eq!(classify("The process cannot access the file because it is being used by another process. (os error 32)").kind, ErrorKind::Busy);
        assert_eq!(classify("There is not enough space on the disk. (os error 112)").kind, ErrorKind::DiskFull);
        assert_eq!(classify("error during connect: Get http://%2F%2F.%2Fpipe%2Fdocker_engine/v1.24/info: open //./pipe/docker_engine").kind, ErrorKind::DockerDown);
        assert_eq!(classify("Windows Subsystem for Linux has no installed distributions.").kind, ErrorKind::WslDown);
        assert_eq!(classify("Ubuntu-24.04 is not a registered distribution.").kind, ErrorKind::NotFound);
        assert_eq!(classify("failed to lookup address information: could not resolve host").kind, ErrorKind::Network);
        assert_eq!(classify("operation timed out").kind, ErrorKind::Timeout);

        // Elevation wins over permission when both signals are present.
        assert_eq!(
            classify("Access is denied. The requested operation requires elevation.").kind,
            ErrorKind::Elevation,
        );

        // An unclassified string is shown as-is rather than replaced by a vague
        // sentence, and carries no duplicate detail.
        let odd = classify("compose file has a duplicate service key");
        assert_eq!(odd.kind, ErrorKind::Unknown);
        assert_eq!(odd.message, "compose file has a duplicate service key");
        assert!(odd.detail.is_none());

        // Every classified kind keeps the raw text for the disclosure.
        assert!(classify("Os { code: 5, kind: PermissionDenied }").detail.is_some());
    }

    #[test]
    fn empty_error_still_says_something_useful() {
        let e = classify("");
        assert_eq!(e.kind, ErrorKind::Unknown);
        assert!(e.hint.is_some());
        assert!(!e.message.is_empty());
    }
}
