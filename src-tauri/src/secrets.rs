//! API keys, in the OS keychain.
//!
//! Never in `settings.json`. That file is deliberately plain and readable, gets
//! copied between machines, and would end up in a backup or a screenshot; a
//! credential does not belong in it.

/// Deliberately still the old name.
///
/// The app was renamed; a keychain entry is not a file we can move, and
/// changing this would silently lose the key of anyone who had already saved
/// one — they would be told to paste it again with no explanation. A stable
/// string is worth more here than a tidy one.
const SERVICE: &str = "dev.ideagraph.app";

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("keychain: {0}")]
    Keychain(String),
}

fn entry(account: &str) -> Result<keyring::Entry, SecretError> {
    keyring::Entry::new(SERVICE, account).map_err(|e| SecretError::Keychain(e.to_string()))
}

pub fn set(account: &str, secret: &str) -> Result<(), SecretError> {
    entry(account)?.set_password(secret).map_err(|e| SecretError::Keychain(e.to_string()))
}

/// The stored secret, or `None` if there isn't one.
///
/// A missing entry is not an error — it is the normal state before anyone has
/// entered a key.
pub fn get(account: &str) -> Option<String> {
    entry(account).ok()?.get_password().ok()
}

pub fn delete(account: &str) -> Result<(), SecretError> {
    match entry(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(SecretError::Keychain(e.to_string())),
    }
}

pub const ANTHROPIC: &str = "anthropic-api-key";
