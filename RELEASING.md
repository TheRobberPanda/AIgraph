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

   It runs the checks CI used to run, builds the deb and AppImage, tags
   `vX.Y.Z`, pushes `main` and the tag, and opens a **draft** release with
   them attached. Then it starts the `Release` workflow on GitHub, which builds
   the Windows installers (NSIS and MSI) and the rpm and uploads them into the
   same draft.
4. Wait for that run (`gh run watch`), check the files, publish.

Only Windows and rpm are built on GitHub, because they can't be built here:
Windows installers cannot be made on Linux, and this machine has no
`rpmbuild`. Everything else stays local because a cold runner takes far too
long. To add them to a release that already exists, run the workflow by hand
(Actions → Release → Run workflow) with its tag.

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
