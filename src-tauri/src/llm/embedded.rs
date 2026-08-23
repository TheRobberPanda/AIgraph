//! The model the app runs itself.
//!
//! # Why a subprocess rather than linked-in bindings
//!
//! The obvious approach is a Rust binding to llama.cpp, compiled into the
//! binary. This runs `llama-server` as a child process and talks to it over
//! its OpenAI-compatible HTTP API instead, for four reasons that all point the
//! same way:
//!
//! 1. **The quantisation moves faster than the bindings.** Bonsai's `Q1_0`
//!    needs a llama.cpp newer than the one any published Rust binding vendors.
//!    A downloaded binary can be updated on its own; a vendored submodule
//!    cannot without waiting for the crate.
//! 2. **The GPU backend matrix stays out of our build.** CUDA, ROCm, Vulkan and
//!    Metal builds already exist upstream, prebuilt. Linking in would mean
//!    owning all of them, which is the largest cost of embedding a model at
//!    all.
//! 3. **A crash stays a crash of the model, not of the app.** Loading a large
//!    model on a contended card is exactly where this falls over, and in-process
//!    that takes the session down with it.
//! 4. **The provider already exists.** `llama-server` speaks the same API as LM
//!    Studio, so [`crate::llm::openai_compat`] drives it unchanged.
//!
//! What the person sees is unaffected: nothing to install, the app fetches and
//! runs it.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::Serialize;

use crate::settings::Runtime;
use crate::stt::model::DownloadProgress;

/// Where the weights come from. Apache 2.0, so they can be built on freely.
pub const REPO: &str = "prism-ml/Bonsai-27B-gguf";
pub const FILE: &str = "Bonsai-27B-Q1_0.gguf";
/// Roughly 3.8 GB. Only used to show a sensible bar before the server
/// reports a real Content-Length.
const APPROX_BYTES: u64 = 3_800_000_000;

/// Loopback only. The server is ours and must not be reachable from off the
/// machine — this is a local-first app and the whole point is that nothing
/// leaves it.
const HOST: &str = "127.0.0.1";
const PORT: u16 = 8127;

fn url_for(repo: &str, file: &str) -> String {
    format!("https://huggingface.co/{repo}/resolve/main/{file}?download=true")
}

/// One model on Hugging Face, as the search returns it.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct RemoteModel {
    pub id: String,
    #[serde(default)]
    pub downloads: u64,
    #[serde(default)]
    pub likes: u64,
}

/// One GGUF inside a repository.
#[derive(Debug, Clone, Serialize)]
pub struct RemoteFile {
    pub path: String,
    pub size: u64,
}

/// Search Hugging Face for GGUF repositories.
///
/// Live rather than a list baked into the app: a hardcoded catalogue is out of
/// date the week after it ships, and this is a field that moves monthly.
pub async fn search(query: &str) -> Result<Vec<RemoteModel>, String> {
    let url = format!(
        "https://huggingface.co/api/models?filter=gguf&search={}&sort=downloads&direction=-1&limit=25",
        urlencode(query)
    );
    reqwest::get(&url)
        .await
        .map_err(|e| e.to_string())?
        .json::<Vec<RemoteModel>>()
        .await
        .map_err(|e| e.to_string())
}

/// The GGUF files in one repository, largest last.
///
/// Quantisations are what actually differ here, and the size is the number
/// that decides whether a machine can run it — so both are surfaced rather
/// than making someone guess from the filename.
pub async fn files(repo: &str) -> Result<Vec<RemoteFile>, String> {
    #[derive(serde::Deserialize)]
    struct Entry {
        path: String,
        #[serde(default)]
        size: u64,
    }
    let url = format!("https://huggingface.co/api/models/{repo}/tree/main?recursive=true");
    let entries: Vec<Entry> = reqwest::get(&url)
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let mut out: Vec<RemoteFile> = entries
        .into_iter()
        .filter(|e| e.path.to_lowercase().ends_with(".gguf"))
        // The vision tower and the speculative drafter ship alongside the
        // weights and are not themselves runnable, so they are not offered.
        .filter(|e| !e.path.to_lowercase().contains("mmproj"))
        .map(|e| RemoteFile { path: e.path, size: e.size })
        .collect();
    out.sort_by_key(|f| f.size);
    Ok(out)
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            b' ' => "+".to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
pub struct EmbeddedStatus {
    /// The weights are on disk.
    pub model_ready: bool,
    /// A `llama-server` we can run was found.
    pub server_ready: bool,
    /// Where that server came from, for the UI to explain.
    pub server_path: Option<String>,
    /// It is running now and answering.
    pub running: bool,
    /// Every GGUF already on disk, so one of several can be chosen.
    pub downloaded: Vec<String>,
    pub download_gb: f32,
    pub host: String,
}

pub struct Embedded {
    root: PathBuf,
    child: Option<std::process::Child>,
}

impl Drop for Embedded {
    fn drop(&mut self) {
        self.stop();
    }
}

impl Embedded {
    pub fn new(app_data_dir: &Path) -> Self {
        Self { root: app_data_dir.join("llm"), child: None }
    }

    pub fn model_path(&self) -> PathBuf {
        self.root.join(FILE)
    }

    /// Where a chosen file lands. Flattened to the basename: a repo path with
    /// directories in it would otherwise put weights in surprising places.
    pub fn path_for(&self, file: &str) -> PathBuf {
        let name = file.rsplit('/').next().unwrap_or(file);
        self.root.join(name)
    }

    /// Every GGUF already downloaded, so more than one can be kept.
    pub fn downloaded(&self) -> Vec<String> {
        let Ok(dir) = std::fs::read_dir(&self.root) else {
            return Vec::new();
        };
        let mut out: Vec<String> = dir
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.to_lowercase().ends_with(".gguf"))
            .collect();
        out.sort();
        out
    }

    /// Fetch any GGUF, not only the one the app suggests.
    pub fn download_file(
        &self,
        repo: &str,
        file: &str,
        approx: u64,
        on_progress: &(dyn Fn(DownloadProgress) + Send + Sync),
    ) -> Result<(), String> {
        let dest = self.path_for(file);
        if dest.is_file() {
            return Ok(());
        }
        std::fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        crate::stt::model::download_to(&url_for(repo, file), &dest, file, approx, on_progress)
            .map_err(|e| e.to_string())
    }

    pub fn host(&self) -> String {
        format!("http://{HOST}:{PORT}")
    }

    /// A `llama-server` to drive, if there is one.
    ///
    /// Ours first, then whatever is on PATH — someone who already has llama.cpp
    /// built should not be made to download a second copy.
    pub fn server_binary(&self) -> Option<PathBuf> {
        let own = self.root.join(if cfg!(windows) { "llama-server.exe" } else { "llama-server" });
        if own.is_file() {
            return Some(own);
        }
        which_on_path("llama-server")
    }

    pub fn status(&mut self) -> EmbeddedStatus {
        let server = self.server_binary();
        EmbeddedStatus {
            model_ready: self.model_path().is_file(),
            server_ready: server.is_some(),
            server_path: server.map(|p| p.display().to_string()),
            running: self.is_running(),
            downloaded: self.downloaded(),
            download_gb: APPROX_BYTES as f32 / 1e9,
            host: self.host(),
        }
    }

    /// Still alive? `try_wait` rather than a flag, so a server that died on its
    /// own is not reported as running.
    pub fn is_running(&mut self) -> bool {
        match self.child.as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(None)),
            None => false,
        }
    }

    /// Fetch the weights. Resumable only in the sense that a failed attempt
    /// leaves no usable file behind — see the `.partial` rename in `stt::model`.
    pub fn download(
        &self,
        on_progress: &(dyn Fn(DownloadProgress) + Send + Sync),
    ) -> Result<(), String> {
        let dest = self.model_path();
        if dest.is_file() {
            return Ok(());
        }
        std::fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        crate::stt::model::download_to(&url_for(REPO, FILE), &dest, FILE, APPROX_BYTES, on_progress)
            .map_err(|e| e.to_string())
    }

    /// Start the server, or do nothing if it is already up.
    ///
    /// The runtime settings become flags here. That is the whole reason they
    /// are settings: they are the ones that decide whether a 27B model is
    /// pleasant or painful on a given machine.
    pub fn start(&mut self, rt: &Runtime, file: Option<&str>) -> Result<(), String> {
        if self.is_running() {
            return Ok(());
        }
        let model = match file {
            Some(f) => self.path_for(f),
            None => self.model_path(),
        };
        if !model.is_file() {
            return Err("the model has not been downloaded yet".into());
        }
        let bin = self
            .server_binary()
            .ok_or("no llama-server found — install llama.cpp or put llama-server on PATH")?;

        let mut cmd = std::process::Command::new(bin);
        cmd.arg("-m")
            .arg(&model)
            .arg("--host")
            .arg(HOST)
            .arg("--port")
            .arg(PORT.to_string())
            .arg("-c")
            .arg(rt.context_length.to_string())
            .arg("-ngl")
            .arg(rt.gpu_layers.to_string())
            // Quiet: its logs are not this app's logs, and a chatty child
            // filling a pipe nobody reads will eventually block it.
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        // llama.cpp's flag is the negative one. Off by default there, so it is
        // only passed when the setting says to keep the cache on the CPU.
        if !rt.kv_cache_on_gpu {
            cmd.arg("--no-kv-offload");
        }

        let child = cmd.spawn().map_err(|e| format!("could not start llama-server: {e}"))?;
        self.child = Some(child);
        Ok(())
    }

    pub fn stop(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

/// Look for a binary on PATH without pulling in a crate for it.
fn which_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).find_map(|dir| {
        let candidate = dir.join(name);
        candidate.is_file().then_some(candidate)
    })
}
