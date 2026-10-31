//! A command failure that keeps the status the browser saw.
//!
//! The web build's proxy answered each failure with a status the interface
//! reads: 409 when RTKLIB is not installed, 413 when a file is over the limit,
//! 415 for a closed receiver format, 422 when the engine ran and refused the
//! data, 504 for a timeout. A Tauri command cannot set an HTTP status, so it
//! carries one here and `src/native.js` turns it back into the response status.
//! The message is what the interface prints, word for word from `serve.py`,
//! because those sentences name the next thing to try.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Failure {
    /// What the interface shows.
    pub message: String,
    /// The status the web build's proxy answered with.
    pub status: u16,
}

impl Failure {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status,
        }
    }

    /// A request that is wrong on its face, which is what 400 meant.
    pub fn bad(message: impl Into<String>) -> Self {
        Self::new(400, message)
    }
}

impl std::fmt::Display for Failure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for Failure {}

impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self::new(500, message)
    }
}

impl From<&str> for Failure {
    fn from(message: &str) -> Self {
        Self::new(500, message.to_string())
    }
}

impl From<std::io::Error> for Failure {
    fn from(error: std::io::Error) -> Self {
        Self::new(500, error.to_string())
    }
}
