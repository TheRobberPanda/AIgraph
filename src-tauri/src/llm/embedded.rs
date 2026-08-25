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

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};

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
    /// Which build was installed, if it was installed by us.
    pub server_build: Option<String>,
    /// Whether a vendor-neutral GPU build exists for this platform.
    pub vulkan_available: bool,
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
    /// The tail of the server's own output, kept so a failure can say why.
    log: Option<Arc<Mutex<VecDeque<String>>>>,
}

impl Drop for Embedded {
    fn drop(&mut self) {
        self.stop();
    }
}

impl Embedded {
    pub fn new(app_data_dir: &Path) -> Self {
        Self { root: app_data_dir.join("llm"), child: None, log: None }
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

    /// Fetch a `llama-server` build and unpack it beside the weights.
    ///
    /// Two flavours, because "the GPU matrix is too expensive to own" turned
    /// out to have one honest exception: the Vulkan build is a single archive
    /// that works across AMD, Nvidia and Intel. CUDA and ROCm would each be
    /// another matrix; Vulkan is one more file. Anything beyond that is still
    /// someone putting their own `llama-server` on PATH, which is preferred
    /// over ours.
    pub fn install_server(
        &self,
        flavour: &str,
        on_progress: &(dyn Fn(DownloadProgress) + Send + Sync),
    ) -> Result<(), String> {
        // Resolved at install time rather than pinned to a build chosen when
        // this was written. The whole reason this app drives a subprocess
        // instead of linking a binding is that quantisations move faster than
        // releases do — pinning would reintroduce exactly the problem, and it
        // did: the pinned build could not read the model it was fetched for.
        let tag = latest_build().unwrap_or_else(|| PINNED_BUILD.to_string());
        let asset = server_asset(&tag, flavour).ok_or(
            "no prebuilt llama-server for this platform — build llama.cpp and put llama-server on PATH",
        )?;
        // Wiped and rebuilt rather than unpacked over: a CPU build laid on top
        // of a Vulkan one leaves both sets of libraries side by side, and the
        // binary loads whichever the linker finds first.
        let dir = self.engine_dir();
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let archive = dir.join(&asset);
        crate::stt::model::download_to(
            &format!("https://github.com/ggml-org/llama.cpp/releases/download/{tag}/{asset}"),
            &archive,
            "llama-server",
            SERVER_APPROX_BYTES,
            on_progress,
        )
        .map_err(|e| e.to_string())?;
        let out = unpack(&archive, &dir);
        let _ = std::fs::remove_file(&archive);
        out?;
        // The archives nest everything under a build directory. The binary
        // loads its libraries from beside itself, so the whole directory it
        // came in moves up together — picking out files by extension missed
        // `libllama-common.so.0`, and the server would not start.
        flatten(&dir)?;
        let bin = dir.join(server_name());
        if !bin.is_file() {
            return Err("the archive did not contain a llama-server".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755));
        }
        std::fs::write(dir.join("build.txt"), format!("{tag} · {flavour}"))
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Where an engine we installed lives. Its own directory, apart from the
    /// weights, so replacing it never touches a multi-gigabyte download.
    fn engine_dir(&self) -> PathBuf {
        self.root.join("engine")
    }

    /// Which build is installed, for the UI to name.
    pub fn server_build(&self) -> Option<String> {
        std::fs::read_to_string(self.engine_dir().join("build.txt")).ok()
    }

    /// A `llama-server` to drive, if there is one.
    ///
    /// Whatever is on PATH first, then ours — someone who has built llama.cpp
    /// themselves has a GPU build, and ours is deliberately CPU-only.
    pub fn server_binary(&self) -> Option<PathBuf> {
        if let Some(found) = which_on_path("llama-server") {
            return Some(found);
        }
        let own = self.engine_dir().join(server_name());
        own.is_file().then_some(own)
    }

    pub fn status(&mut self) -> EmbeddedStatus {
        let server = self.server_binary();
        EmbeddedStatus {
            model_ready: self.model_path().is_file(),
            server_ready: server.is_some(),
            server_path: server.map(|p| p.display().to_string()),
            server_build: self.server_build(),
            vulkan_available: vulkan_available(),
            running: self.is_running(),
            downloaded: self.downloaded(),
            download_gb: APPROX_BYTES as f32 / 1e9,
            host: self.host(),
        }
    }

    /// Still alive? `try_wait` rather than a flag, so a server that died on its
    /// own is not reported as running.
    ///
    /// A server we did not start counts too. The app can be killed — closed
    /// while frozen, logged out, crashed — and `Drop` does not run then, so the
    /// server outlives it and keeps the port. The next launch would try to
    /// bind a port its own orphan was holding and report a failure that reads
    /// like a broken install. Finding it and using it is the honest answer:
    /// it is our process, running our model, on our port.
    pub fn is_running(&mut self) -> bool {
        if let Some(c) = self.child.as_mut() {
            if matches!(c.try_wait(), Ok(None)) {
                return true;
            }
            self.child = None;
        }
        self.adopted()
    }

    /// Is a server from a previous run still up on our port?
    ///
    /// The port is the answer, not the pid file. Port 8127 on loopback is this
    /// app's by convention and nothing else is expected there — and requiring
    /// a pid file meant a server started before that file existed, or after it
    /// was cleaned away, was invisible. That is exactly the case that produced
    /// the failure: an orphan holding the port that the app could not see.
    fn adopted(&self) -> bool {
        port_answering()
    }

    /// The process to signal when stopping one we did not start.
    ///
    /// The pid file first, since we wrote it. Failing that, the process table
    /// — a `llama-server` whose command line names our port is ours, because
    /// nothing else would be asked to listen there.
    fn orphan_pid(&self) -> Option<u32> {
        if let Some(pid) = std::fs::read_to_string(self.pid_path())
            .ok()
            .and_then(|p| p.trim().parse::<u32>().ok())
        {
            if is_llama_server(pid) {
                return Some(pid);
            }
        }
        find_server_on_port()
    }

    fn pid_path(&self) -> PathBuf {
        self.engine_dir().join("server.pid")
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
            .ok_or("no llama-server found — install one below, or put llama-server on PATH")?;

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
            .arg("--parallel")
            .arg(rt.parallel.max(1).to_string())
            .arg("--batch-size")
            .arg(rt.batch_size.max(32).to_string())
            .arg("--ubatch-size")
            .arg(rt.ubatch_size.max(32).min(rt.batch_size.max(32)).to_string())
            .arg("--temp")
            .arg(rt.temperature.to_string())
            .arg("--top-p")
            .arg(rt.top_p.to_string())
            .arg("--top-k")
            .arg(rt.top_k.to_string())
            .arg("--repeat-penalty")
            .arg(rt.repeat_penalty.to_string())
            .stdout(Stdio::null())
            // Kept rather than discarded. A server that refuses to start says
            // exactly why on stderr, and sending that to /dev/null is how a
            // rejected flag became "it does not work" with nothing to go on.
            .stderr(Stdio::piped());

        // Zero means "decide from the machine", which is llama.cpp's own
        // behaviour when the flag is absent — so absence is how we say it.
        if rt.threads > 0 {
            cmd.arg("-t").arg(rt.threads.to_string());
        }
        // Long form and an explicit value: the short `-fa` took no argument in
        // older builds and takes on/off/auto in current ones, so the spelling
        // that works everywhere is the one that says what it means.
        cmd.arg("--flash-attn").arg(if rt.flash_attention { "on" } else { "off" });
        if rt.mlock {
            cmd.arg("--mlock");
        }
        cmd.arg(if rt.kv_unified { "--kv-unified" } else { "--no-kv-unified" });
        // Counters for the readout. `/slots` reports the prompt but says
        // nothing about generation, which is where the time actually goes.
        cmd.arg("--metrics");
        // llama.cpp's flag is the negative one. Off by default there, so it is
        // only passed when the setting says to keep the cache on the CPU.
        if !rt.kv_cache_on_gpu {
            cmd.arg("--no-kv-offload");
        }

        let mut child = cmd.spawn().map_err(|e| format!("could not start llama-server: {e}"))?;
        let _ = std::fs::create_dir_all(self.engine_dir());
        let _ = std::fs::write(self.pid_path(), child.id().to_string());

        // Drained on a thread so a full pipe cannot block the server, keeping
        // only the tail — enough to say what went wrong, not a log file.
        let log = Arc::new(Mutex::new(VecDeque::<String>::new()));
        if let Some(err) = child.stderr.take() {
            let log = log.clone();
            std::thread::spawn(move || {
                for line in BufRead::lines(BufReader::new(err)).map_while(Result::ok) {
                    let mut l = log.lock().unwrap();
                    if l.len() == 40 {
                        l.pop_front();
                    }
                    l.push_back(line);
                }
            });
        }

        // Give it long enough to reject its own arguments. A bad flag or a
        // model the build cannot read kills it in well under a second, and
        // reporting that here is the difference between an error and silence.
        for _ in 0..12 {
            std::thread::sleep(std::time::Duration::from_millis(150));
            if let Ok(Some(status)) = child.try_wait() {
                let tail = log.lock().unwrap().iter().cloned().collect::<Vec<_>>();
                return Err(explain(&tail, status.code()));
            }
        }

        self.child = Some(child);
        self.log = Some(log);
        Ok(())
    }

    /// What the server last said, for a failure the UI wants to show.
    pub fn last_output(&self) -> Vec<String> {
        self.log
            .as_ref()
            .map(|l| l.lock().unwrap().iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn stop(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
            let _ = std::fs::remove_file(self.pid_path());
            return;
        }
        // Nothing of ours in this process, but possibly one from a previous
        // run. Stopping has to reach that too, or the button says "stop" and
        // the model stays loaded.
        if let Some(pid) = self.orphan_pid() {
            kill(pid);
            let _ = std::fs::remove_file(self.pid_path());
        }
    }
}

/// Used only when the release list cannot be reached. Not a pin — see
/// `install_server` for why pinning is the wrong answer here.
const PINNED_BUILD: &str = "b10612";
/// Roughly 20 MB compressed, for the bar before Content-Length arrives.
const SERVER_APPROX_BYTES: u64 = 20_000_000;

pub fn server_name() -> &'static str {
    if cfg!(windows) { "llama-server.exe" } else { "llama-server" }
}

/// The newest `bNNNN` release upstream has published.
fn latest_build() -> Option<String> {
    let body: String = ureq::get("https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10")
        .set("User-Agent", "idea-graph")
        .call()
        .ok()?
        .into_string()
        .ok()?;
    let releases: Vec<serde_json::Value> = serde_json::from_str(&body).ok()?;
    releases
        .iter()
        .filter_map(|r| r.get("tag_name")?.as_str())
        .find(|t| t.starts_with('b') && t[1..].chars().all(|c| c.is_ascii_digit()))
        .map(str::to_string)
}

/// Whether this platform has a Vulkan build to offer.
pub fn vulkan_available() -> bool {
    server_asset("b0", "vulkan").is_some()
}

/// The prebuilt asset for this machine, if upstream publishes one.
///
/// Linux and macOS ship `.tar.gz`, Windows `.zip` — upstream's choice, not
/// ours, and [`unpack`] reads both.
fn server_asset(tag: &str, flavour: &str) -> Option<String> {
    let arch = std::env::consts::ARCH;
    let gpu = flavour == "vulkan";
    Some(match (std::env::consts::OS, arch, gpu) {
        ("linux", "x86_64", false) => format!("llama-{tag}-bin-ubuntu-x64.tar.gz"),
        ("linux", "x86_64", true) => format!("llama-{tag}-bin-ubuntu-vulkan-x64.tar.gz"),
        ("linux", "aarch64", false) => format!("llama-{tag}-bin-ubuntu-arm64.tar.gz"),
        ("linux", "aarch64", true) => format!("llama-{tag}-bin-ubuntu-vulkan-arm64.tar.gz"),
        // Metal is in the ordinary macOS build; there is no separate one, and
        // no Vulkan build either.
        ("macos", "aarch64", false) => format!("llama-{tag}-bin-macos-arm64.tar.gz"),
        ("macos", "x86_64", false) => format!("llama-{tag}-bin-macos-x64.tar.gz"),
        ("windows", "x86_64", false) => format!("llama-{tag}-bin-win-cpu-x64.zip"),
        ("windows", "x86_64", true) => format!("llama-{tag}-bin-win-vulkan-x64.zip"),
        _ => return None,
    })
}

/// Unpack a release archive, `.tar.gz` or `.zip` depending on the platform.
fn unpack(archive: &Path, into: &Path) -> Result<(), String> {
    let name = archive.file_name().unwrap_or_default().to_string_lossy();
    if name.ends_with(".zip") {
        return unzip(archive, into);
    }
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let gz = flate2::read::GzDecoder::new(file);
    tar::Archive::new(gz).unpack(into).map_err(|e| e.to_string())
}

/// Unpack a zip, refusing any entry whose path climbs out of the destination —
/// an archive is untrusted input even from a release page we chose.
fn unzip(archive: &Path, into: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = entry.enclosed_name() else { continue };
        let dest = into.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Move the whole directory the server arrived in up to the top.
///
/// Everything that came with it moves, not a chosen list: the binary loads its
/// libraries from beside itself, and picking files out by extension missed
/// `libllama-common.so.0` — a versioned suffix ends in a digit, not in `.so`.
/// The archive knows what belongs together; we do not need to.
fn flatten(root: &Path) -> Result<(), String> {
    let Some(home) = find_server(root, 0) else {
        return Ok(());
    };
    if home == root {
        return Ok(());
    }
    let entries = std::fs::read_dir(&home).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let dest = root.join(entry.file_name());
        let _ = std::fs::rename(entry.path(), &dest);
    }
    let _ = std::fs::remove_dir_all(&home);
    Ok(())
}

/// The directory holding `llama-server`, wherever the archive put it.
fn find_server(dir: &Path, depth: usize) -> Option<PathBuf> {
    if depth > 4 {
        return None;
    }
    if dir.join(server_name()).is_file() {
        return Some(dir.to_path_buf());
    }
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_server(&path, depth + 1) {
                return Some(found);
            }
        }
    }
    None
}

/// Is anything listening on our port?
fn port_answering() -> bool {
    use std::net::{SocketAddr, TcpStream};
    let addr: SocketAddr = format!("{HOST}:{PORT}").parse().expect("loopback address");
    TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(250)).is_ok()
}

/// A running `llama-server` told to listen on our port, if there is one.
#[cfg(unix)]
fn find_server_on_port() -> Option<u32> {
    let entries = std::fs::read_dir("/proc").ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str().and_then(|n| n.parse::<u32>().ok()) else { continue };
        let Ok(cmdline) = std::fs::read_to_string(format!("/proc/{pid}/cmdline")) else { continue };
        if cmdline.contains("llama-server") && cmdline.contains(&PORT.to_string()) {
            return Some(pid);
        }
    }
    None
}

#[cfg(not(unix))]
fn find_server_on_port() -> Option<u32> {
    None
}

/// Is this pid a live `llama-server`?
#[cfg(unix)]
fn is_llama_server(pid: u32) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/cmdline"))
        .map(|c| c.contains("llama-server"))
        .unwrap_or(false)
}

/// Elsewhere, take the pid file's word for it. A stale pid whose number has
/// been reused is possible in theory; the port check above already makes it
/// unlikely, and the alternative is a platform-specific process listing for a
/// case that resolves itself the moment someone presses stop.
#[cfg(not(unix))]
fn is_llama_server(_pid: u32) -> bool {
    true
}

#[cfg(unix)]
fn kill(pid: u32) {
    // SAFETY: `kill` with a pid we recorded ourselves and just verified is a
    // llama-server. SIGTERM so it can close its socket rather than leaving it
    // in TIME_WAIT for the next launch to trip over.
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
}

#[cfg(not(unix))]
fn kill(pid: u32) {
    let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/F"]).status();
}

/// Turn the server's parting words into something worth reading.
///
/// llama.cpp says what is wrong perfectly clearly and then says forty more
/// lines about backends. The two failures that actually happen get named; for
/// anything else the tail is better than a bare exit code.
fn explain(tail: &[String], code: Option<i32>) -> String {
    let joined = tail.join("\n");
    if joined.contains("invalid argument") {
        let arg = tail
            .iter()
            .find(|l| l.contains("invalid argument"))
            .cloned()
            .unwrap_or_default();
        return format!(
            "this llama-server does not understand one of the settings — {arg}. \
             Installing the current build usually fixes it."
        );
    }
    if joined.contains("OutOfDeviceMemory") || joined.contains("out of memory") {
        return "the graphics card does not have room for this. Close whatever \
                else is using it — another model loaded in LM Studio or Ollama \
                holds its memory until it is unloaded — or lower the context, \
                which is what most of it goes on."
            .into();
    }
    if joined.contains("invalid ggml type") || joined.contains("failed to load model") {
        return "this llama-server is too old to read that model. Install the current \
                build, or pick a model in a quantisation it understands."
            .into();
    }
    let last: Vec<&String> = tail.iter().rev().take(6).rev().collect();
    if last.is_empty() {
        return format!("llama-server exited immediately (code {})", code.unwrap_or(-1));
    }
    format!(
        "llama-server exited immediately:\n{}",
        last.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("\n")
    )
}

/// Look for a binary on PATH without pulling in a crate for it.
fn which_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).find_map(|dir| {
        let candidate = dir.join(name);
        candidate.is_file().then_some(candidate)
    })
}
