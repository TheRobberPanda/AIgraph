#!/usr/bin/env bash
# Build a release on this machine and put it on GitHub's Releases tab as a
# draft — what the Release workflow used to do, without waiting on a runner.
#
# Run from a clean `main` after bumping the version and updating CHANGELOG.md
# (see RELEASING.md). Linux installers only: Windows ones cannot be built here.
set -euo pipefail

cd "$(dirname "$0")/.."

version=$(node -p "require('./package.json').version")
tag="v$version"

# The three versions must agree, or the installers' names disagree with the app.
cargo_version=$(grep -m1 '^version' src-tauri/Cargo.toml | cut -d'"' -f2)
tauri_version=$(node -p "require('./src-tauri/tauri.conf.json').version")
if [[ "$cargo_version" != "$version" || "$tauri_version" != "$version" ]]; then
  echo "Versions disagree: package.json $version, Cargo.toml $cargo_version, tauri.conf.json $tauri_version" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Uncommitted changes — commit the release first." >&2
  exit 1
fi

# The same checks CI ran, so nothing ships that Check would have failed.
npx tsc --noEmit
npm run build
(
  cd src-tauri
  cargo fmt -- --check
  cargo clippy --no-default-features -- -D warnings
  cargo test --no-default-features
)

# rpm needs rpmbuild; skip that format rather than fail the whole build.
bundles="deb,appimage"
command -v rpmbuild >/dev/null && bundles="deb,rpm,appimage"
npm run package -- --bundles "$bundles"

bundle_dir=src-tauri/target/release/bundle
mapfile -t files < <(find "$bundle_dir/deb" "$bundle_dir/rpm" "$bundle_dir/appimage" \
  -maxdepth 1 -type f \( -name "*_${version}_*.deb" -o -name "*-${version}-*.rpm" -o -name "*_${version}_*.AppImage" \) 2>/dev/null)
if [[ ${#files[@]} -eq 0 ]]; then
  echo "No installers for $version found under $bundle_dir." >&2
  exit 1
fi
printf 'Built:\n'; printf '  %s\n' "${files[@]}"

git tag -f "$tag"
git push origin main
git push -f origin "$tag"

# A draft, as before: check the files, then publish from the Releases tab.
if gh release view "$tag" >/dev/null 2>&1; then
  gh release upload "$tag" "${files[@]}" --clobber
else
  gh release create "$tag" "${files[@]}" --draft \
    --title "AIgraph $tag" --notes "See CHANGELOG.md. Downloads are below."
fi
gh release view "$tag" --json url -q .url
