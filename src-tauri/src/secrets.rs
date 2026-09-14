//! API keys, in the OS keychain.
//!
//! Never in `settings.json`. That file is deliberately plain and readable, gets
//! copied between machines, and would end up in a backup or a screenshot; a
//! credential does not belong in it.
//!
//! Android has no keychain the `keyring` crate can reach — it silently falls
//! back to an in-memory store there, and a key would vanish on every restart.
//! So on the phone keys live in a file in the app's private data directory,
//! which Android sandboxes to this app and encrypts at rest. Still never in
//! `settings.json`, for the same reasons.

use std::path::Path;

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("keychain: {0}")]
    Keychain(String),
}

/// Tell the store where the app keeps its data. Only the phone needs it.
pub fn init(data_dir: &Path) {
    backend::init(data_dir);
}

pub fn set(account: &str, secret: &str) -> Result<(), SecretError> {
    backend::set(account, secret)
}

/// The stored secret, or `None` if there isn't one.
///
/// A missing entry is not an error — it is the normal state before anyone has
/// entered a key.
pub fn get(account: &str) -> Option<String> {
    backend::get(account)
}

pub fn delete(account: &str) -> Result<(), SecretError> {
    backend::delete(account)
}

pub const ANTHROPIC: &str = "anthropic-api-key";
pub const OPENROUTER: &str = "openrouter-api-key";

#[cfg(not(target_os = "android"))]
mod backend {
    use super::SecretError;
    use std::path::Path;

    /// Deliberately still the old name.
    ///
    /// The app was renamed; a keychain entry is not a file we can move, and
    /// changing this would silently lose the key of anyone who had already
    /// saved one — they would be told to paste it again with no explanation.
    /// A stable string is worth more here than a tidy one.
    const SERVICE: &str = "dev.ideagraph.app";

    pub fn init(_data_dir: &Path) {}

    fn entry(account: &str) -> Result<keyring::Entry, SecretError> {
        keyring::Entry::new(SERVICE, account).map_err(|e| SecretError::Keychain(e.to_string()))
    }

    pub fn set(account: &str, secret: &str) -> Result<(), SecretError> {
        entry(account)?.set_password(secret).map_err(|e| SecretError::Keychain(e.to_string()))
    }

    pub fn get(account: &str) -> Option<String> {
        entry(account).ok()?.get_password().ok()
    }

    pub fn delete(account: &str) -> Result<(), SecretError> {
        match entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(SecretError::Keychain(e.to_string())),
        }
    }
}

#[cfg(target_os = "android")]
mod backend {
    use super::SecretError;
    use std::collections::BTreeMap;
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, OnceLock};

    static FILE: OnceLock<PathBuf> = OnceLock::new();
    /// Read-modify-write of one small file; two saves at once must not lose one.
    static LOCK: Mutex<()> = Mutex::new(());

    pub fn init(data_dir: &Path) {
        let _ = FILE.set(data_dir.join("secrets.json"));
    }

    fn read() -> BTreeMap<String, String> {
        FILE.get()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    fn write(keys: &BTreeMap<String, String>) -> Result<(), SecretError> {
        let err = |e: std::io::Error| SecretError::Keychain(e.to_string());
        let path = FILE.get().ok_or_else(|| SecretError::Keychain("not initialised".into()))?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(err)?;
        }
        // Written aside and renamed over, so a crash mid-write leaves the old
        // keys rather than half a file and none.
        let tmp = path.with_extension("json.tmp");
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(err)?;
        f.write_all(&serde_json::to_vec(keys).expect("a map of strings serialises"))
            .map_err(err)?;
        f.sync_all().map_err(err)?;
        std::fs::rename(&tmp, path).map_err(err)
    }

    pub fn set(account: &str, secret: &str) -> Result<(), SecretError> {
        let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let mut keys = read();
        keys.insert(account.to_string(), secret.to_string());
        write(&keys)
    }

    pub fn get(account: &str) -> Option<String> {
        let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
        read().remove(account)
    }

    pub fn delete(account: &str) -> Result<(), SecretError> {
        let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let mut keys = read();
        if keys.remove(account).is_some() {
            write(&keys)?;
        }
        Ok(())
    }
}
