# Releasing

## Before the repository is public

**Delete the `dev-data` branch from the remote.** It holds a real database and
real transcripts — actual conversations, including someone else's — committed
during development so the extraction prompts could be tuned against real
material. It is not on `main` and never has been, but a public repository
publishes every branch.

```bash
git push origin --delete dev-data
```

Keep the local branch if it is still useful; it is the remote copy that
matters. Check nothing else came with it:

```bash
git ls-tree -r --name-only main | grep -iE '\.db$|transcripts/'   # expect nothing
```

`.gitignore` now refuses `*.db` and `transcripts/`, so this cannot happen again
by accident.

## Cutting a release

1. Update `CHANGELOG.md`.
2. Bump the version in three places, which must agree — Tauri reads its own,
   and a mismatch ships installers whose filenames disagree with the app:
   - `package.json`
   - `src-tauri/Cargo.toml`
   - `src-tauri/tauri.conf.json`
3. Commit, then build and upload from this machine:

   ```bash
   scripts/release.sh
   ```

   It runs the checks CI used to run, builds the Linux installers, tags
   `vX.Y.Z`, pushes `main` and the tag, and opens a **draft** release with the
   installers attached. Check them, write the notes, publish.

Nothing compiles on GitHub any more — the workflows are manual-only, because a
cold runner takes far too long. The cost is Windows: its installers cannot be
built on Linux, so a release has none unless the `Release` workflow is run by
hand (Actions → Release → Run workflow) or the build is done on a Windows
machine.

Drafts rather than direct publication on purpose: a release is the one thing
here that cannot be taken back once people have downloaded it.

## Building locally

```bash
npm run package
```

Linux only, from a Linux machine. Windows installers cannot be
cross-compiled — the toolchain, the webview headers and the NSIS packaging all
want to run there — which is why the workflow has a matrix rather than a single
job.
