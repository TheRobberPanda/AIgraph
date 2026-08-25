//! Fetching and locating the speech models.
//!
//! Parakeet is ~487MB and Silero VAD under 1MB. Neither ships with the app —
//! bundling half a gigabyte into an installer for a feature not everyone uses
//! would be rude, and the licence terms differ from ours. They are downloaded on
//! first use, with progress, into the app data directory.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

const PARAKEET_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2";
const PARAKEET_DIR: &str = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";
const VAD_URL: &str =
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx";

/// Roughly how big the download is, for the progress display. The server's
/// `Content-Length` is preferred when present; this is only a fallback so the
/// bar isn't blank.
const PARAKEET_APPROX_BYTES: u64 = 487_200_000;

#[derive(Debug, thiserror::Error)]
pub enum ModelError {
    #[error("network: {0}")]
    Network(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("the downloaded archive is missing {0}")]
    Incomplete(String),
}

pub type Result<T> = std::result::Result<T, ModelError>;

/// Where the model files live once installed.
#[derive(Debug, Clone)]
pub struct ModelPaths {
    pub encoder: PathBuf,
    pub decoder: PathBuf,
    pub joiner: PathBuf,
    pub tokens: PathBuf,
    pub vad: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgress {
    pub what: String,
    pub received: u64,
    pub total: u64,
}

pub struct Models {
    root: PathBuf,
}

impl Models {
    pub fn new(app_data_dir: &Path) -> Self {
        Self { root: app_data_dir.join("models") }
    }

    pub fn paths(&self) -> ModelPaths {
        let d = self.root.join(PARAKEET_DIR);
        ModelPaths {
            encoder: d.join("encoder.int8.onnx"),
            decoder: d.join("decoder.int8.onnx"),
            joiner: d.join("joiner.int8.onnx"),
            tokens: d.join("tokens.txt"),
            vad: self.root.join("silero_vad.onnx"),
        }
    }

    /// Are all the pieces present? Checked file by file, because a download
    /// interrupted halfway leaves a directory that exists but cannot be loaded.
    pub fn is_installed(&self) -> bool {
        let p = self.paths();
        [&p.encoder, &p.decoder, &p.joiner, &p.tokens, &p.vad].iter().all(|f| f.exists())
    }

    /// Download whatever is missing.
    pub fn ensure(
        &self,
        on_progress: &(dyn Fn(DownloadProgress) + Send + Sync),
    ) -> Result<ModelPaths> {
        std::fs::create_dir_all(&self.root)?;
        let paths = self.paths();

        if !paths.vad.exists() {
            download(VAD_URL, &paths.vad, "voice detector", 0, on_progress)?;
        }

        if !paths.encoder.exists() || !paths.tokens.exists() {
            let archive = self.root.join("parakeet.tar.bz2");
            download(PARAKEET_URL, &archive, "speech model", PARAKEET_APPROX_BYTES, on_progress)?;
            extract(&archive, &self.root)?;
            // The archive is dead weight once unpacked; ~487MB is worth reclaiming.
            std::fs::remove_file(&archive).ok();
        }

        for (file, name) in [
            (&paths.encoder, "encoder"),
            (&paths.decoder, "decoder"),
            (&paths.joiner, "joiner"),
            (&paths.tokens, "tokens"),
        ] {
            if !file.exists() {
                return Err(ModelError::Incomplete(name.to_string()));
            }
        }
        Ok(paths)
    }
}

/// Fetch one file with progress. Public so the embedded model can reuse it
/// rather than growing a second, subtly different downloader.
pub fn download_to(
    url: &str,
    dest: &Path,
    what: &str,
    approx_total: u64,
    on_progress: &(dyn Fn(DownloadProgress) + Send + Sync),
) -> Result<()> {
    download(url, dest, what, approx_total, on_progress)
}

fn download(
    url: &str,
    dest: &Path,
    what: &str,
    approx_total: u64,
    on_progress: &(dyn Fn(DownloadProgress) + Send + Sync),
) -> Result<()> {
    let resp = ureq::get(url).call().map_err(|e| ModelError::Network(e.to_string()))?;

    let total =
        resp.header("Content-Length").and_then(|v| v.parse::<u64>().ok()).unwrap_or(approx_total);

    // Download beside the target, then rename. An interrupted download must not
    // leave a truncated file that `is_installed` would happily accept.
    let partial = dest.with_extension("partial");
    if let Some(parent) = partial.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut out = std::fs::File::create(&partial)?;
    let mut reader = resp.into_reader();
    let mut buf = vec![0u8; 1 << 16];
    let mut received = 0u64;
    let mut last_reported = 0u64;

    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        std::io::Write::write_all(&mut out, &buf[..n])?;
        received += n as u64;

        // Report about every megabyte rather than every chunk — the UI cannot
        // use a thousand events a second and the channel would drown.
        if received - last_reported > 1 << 20 {
            last_reported = received;
            on_progress(DownloadProgress { what: what.to_string(), received, total });
        }
    }
    drop(out);
    std::fs::rename(&partial, dest)?;
    on_progress(DownloadProgress { what: what.to_string(), received, total: received });
    Ok(())
}

/// Download a `.tar.bz2` and unpack it, leaving no archive behind.
///
/// Shared with the voice download, which is the same shape as the speech
/// model's — same host, same packaging, same progress channel.
pub fn fetch_archive(
    url: &str,
    into: &Path,
    what: &str,
    approx_total: u64,
    on_progress: &(dyn Fn(DownloadProgress) + Send + Sync),
) -> Result<()> {
    std::fs::create_dir_all(into)?;
    let archive = into.join(format!("{what}.tar.bz2"));
    download(url, &archive, what, approx_total, on_progress)?;
    let out = extract(&archive, into);
    let _ = std::fs::remove_file(&archive);
    out
}

fn extract(archive: &Path, into: &Path) -> Result<()> {
    let file = std::fs::File::open(archive)?;
    let decompressed = bzip2::read::BzDecoder::new(file);
    tar::Archive::new(decompressed).unpack(into)?;
    Ok(())
}
