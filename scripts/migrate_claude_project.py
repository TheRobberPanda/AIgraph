#!/usr/bin/env python3
"""Migrate every conversation in a claude.ai project into AIgraph.

Reads the claude.ai session cookie from Claude Desktop's local Chromium
profile, pulls the project's conversations from the claude.ai API, then
archives them into AIgraph exactly the way the app archives a finished
conversation: one `sessions` row, one `turns` row per turn with byte offsets
that slice the transcript exactly, and a markdown copy beside the database.

The sessions land in a folder named after the project, keep Claude's titles
(locked, so re-extraction never overwrites a title the person already has),
and are left in the `pending` extraction queue — AIgraph reads them back into
the map on its next launch, exactly as it would a conversation just pressed
Done on.

Only what was said is migrated. Claude's thinking blocks are not stored, and
neither are its machine decorations — the quote verifier reads this same
record, and neither is speech.

Requires: python3-dbus, python3-cryptography. No other dependencies.

    python3 scripts/migrate_claude_project.py [--project NAME] [--dry-run]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HOME = Path.home()
CLAUDE_CONFIG = HOME / ".config" / "Claude"
DATA_DIR = HOME / ".local" / "share" / "app.aigraph"

DESKTOP_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Claude/1.0 Chrome/138.0.0.0 Electron/36.0.0 Safari/537.36"
)
CLIENT_HEADERS = {
    "anthropic-client-type": "claude-desktop",
    "anthropic-client-version": "1.49585.0",
    "Accept": "application/json",
}

USER_MARKER = "USER: "
ASSISTANT_MARKER = "ASSISTANT: "
SEPARATOR = "\n\n"

Turn = tuple[int, str, str]  # (ord, role, text)


def _keyring_secret() -> bytes:
    """The safe-storage password Claude Desktop keeps in the login keyring.

    Chromium derives its cookie key from it: PBKDF2-HMAC-SHA1, salt
    "saltysalt", one iteration, AES-128-CBC, IV of sixteen spaces.
    """
    import dbus

    bus = dbus.SessionBus()
    service = dbus.Interface(
        bus.get_object("org.freedesktop.secrets", "/org/freedesktop/secrets"),
        "org.freedesktop.Secret.Service",
    )
    props = dbus.Interface(
        bus.get_object("org.freedesktop.secrets", "/org/freedesktop/secrets"),
        "org.freedesktop.DBus.Properties",
    )
    _, session = service.OpenSession("plain", dbus.String(""))

    secret = None
    for collection in props.Get("org.freedesktop.Secret.Service", "Collections"):
        cp = dbus.Interface(
            bus.get_object("org.freedesktop.secrets", collection),
            "org.freedesktop.DBus.Properties",
        )
        for item in cp.Get("org.freedesktop.Secret.Collection", "Items"):
            ip = dbus.Interface(
                bus.get_object("org.freedesktop.secrets", item),
                "org.freedesktop.DBus.Properties",
            )
            try:
                attrs = {str(k): str(v) for k, v in ip.Get(
                    "org.freedesktop.Secret.Item", "Attributes").items()}
            except dbus.DBusException:
                continue
            if (attrs.get("application") == "Claude"
                    and "os_crypt" in attrs.get("xdg:schema", "")):
                got = dbus.Interface(
                    bus.get_object("org.freedesktop.secrets", item),
                    "org.freedesktop.Secret.Item").GetSecret(session)
                secret = bytes(got[2])
    if secret is None:
        sys.exit("no 'Claude' safe-storage key in the login keyring — is Claude Desktop installed and signed in?")
    return secret


def _cbc_key(secret: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha1", secret, b"saltysalt", 1, 16)


def _unpad(block: bytes) -> bytes:
    n = block[-1]
    if not 1 <= n <= 16 or block[-n:] != bytes([n]) * n:
        raise ValueError("bad PKCS#7 padding")
    return block[:-n]


def _v11_plain(encrypted: bytes, key: bytes, host: str) -> bytes:
    """Decrypt one Chromium `v11` value: AES-128-CBC, IV of sixteen spaces,
    plaintext prefixed with sha256(host)[:32] as a per-domain check."""
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    d = Cipher(algorithms.AES(key), modes.CBC(b" " * 16)).decryptor()
    plain = _unpad(d.update(encrypted[3:]) + d.finalize())
    if plain[:32] != hashlib.sha256(host.encode()).digest()[:32]:
        raise ValueError(f"domain prefix mismatch for {host}")
    return plain[32:]


def desktop_session() -> tuple[str, str]:
    """(sessionKey, lastActiveOrg) from Claude Desktop's cookie jar."""
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    secret = _keyring_secret()
    key = _cbc_key(secret)

    con = sqlite3.connect(f"file:{CLAUDE_CONFIG / 'Cookies'}?mode=ro", uri=True)
    got: dict[str, str] = {}
    for host, name, raw in con.execute(
        "SELECT host_key, name, encrypted_value FROM cookies"
    ):
        raw = bytes(raw)
        if raw[:3] != b"v11" or host != ".claude.ai" or name not in (
            "sessionKey", "sessionKeyV3", "lastActiveOrg"
        ):
            continue
        d = Cipher(algorithms.AES(key), modes.CBC(b" " * 16)).decryptor()
        try:
            plain = _unpad(d.update(raw[3:]) + d.finalize())
        except ValueError:
            continue
        if plain[:32] != hashlib.sha256(host.encode()).digest()[:32]:
            continue
        got[name] = plain[32:].decode("utf-8")
    con.close()

    session_key = got.get("sessionKeyV3") or got.get("sessionKey")
    org = got.get("lastActiveOrg")
    if not session_key or not org:
        sys.exit("no claude.ai session cookie in Claude Desktop's store — open Claude Desktop once, then retry")
    return session_key, org


def claude_get(url: str, session_key: str, org: str, retries: int = 3) -> dict:
    headers = dict(CLIENT_HEADERS)
    headers["Cookie"] = f"sessionKey={session_key}; lastActiveOrg={org}"
    headers["User-Agent"] = DESKTOP_UA
    for attempt in range(retries):
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code in (401, 403, 404):
                raise
            if attempt == retries - 1:
                raise
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"unreachable: {url}")


def find_project(session_key: str, org: str, name: str) -> dict:
    projects = claude_get(
        f"https://claude.ai/api/organizations/{org}/projects?limit=100",
        session_key, org,
    )
    wanted = name.strip().lower()
    matches = [p for p in projects if p.get("name", "").strip().lower() == wanted]
    if not matches:
        matches = [p for p in projects if wanted in p.get("name", "").lower()]
    if not matches:
        known = "\n".join(f"  - {p.get('name')}" for p in projects)
        sys.exit(f"no project matching {name!r}. Projects on this account:\n{known}")
    return matches[0]


def turns_of(conversation: dict) -> list[Turn]:
    out: list[Turn] = []
    for m in conversation.get("chat_messages") or []:
        sender = m.get("sender")
        if sender not in ("human", "assistant"):
            continue
        parts = [p.get("text", "") for p in (m.get("content") or [])
                 if p.get("type") == "text" and (p.get("text") or "").strip()]
        text = "\n\n".join(p.strip() for p in parts).strip()
        if not text:
            continue
        out.append((len(out), "user" if sender == "human" else "assistant", text))
    return out


def render(messages: list[Turn]) -> tuple[str, list[tuple[int, str, int, int]]]:
    """The transcript exactly as AIgraph renders one: `USER: ` / `ASSISTANT: `
    markers, turns separated by a blank line, and spans as UTF-8 byte offsets
    that slice out each turn's content."""
    data = b""
    spans = []
    for ord_, role, content in messages:
        if ord_ > 0:
            data += SEPARATOR.encode()
        data += (USER_MARKER if role == "user" else ASSISTANT_MARKER).encode()
        start = len(data)
        data += content.encode()
        spans.append((ord_, role, start, len(data)))
    return data.decode("utf-8"), spans


def normalize(ts: str) -> str:
    """claude.ai UTC timestamps → the +00:00 RFC3339 the app writes."""
    return datetime.fromisoformat(ts.replace("Z", "+00:00")) \
        .astimezone(timezone.utc).isoformat()


def write_markdown(md_dir: Path, transcript: str, started: str, ended: str, model: str) -> Path:
    """The same file the app writes when a conversation is archived."""
    md_dir.mkdir(parents=True, exist_ok=True)
    base = datetime.fromisoformat(started).astimezone(timezone.utc).strftime("%Y-%m-%d-%H%M%S")
    path = md_dir / f"{base}.md"
    suffix = 2
    while path.exists():
        path = md_dir / f"{base}-{suffix}.md"
        suffix += 1
    body = f"---\nstarted: {started}\nended: {ended}\nmodel: {model}\n---\n\n{transcript}\n"
    path.write_text(body, encoding="utf-8")
    return path


def ensure_folder(con: sqlite3.Connection, name: str) -> int:
    row = con.execute("SELECT id FROM folders WHERE name = ?", (name,)).fetchone()
    if row:
        return row[0]
    now = datetime.now(timezone.utc).isoformat()
    con.execute("INSERT INTO folders (name, created_at) VALUES (?, ?)", (name, now))
    return con.execute("SELECT id FROM folders WHERE name = ?", (name,)).fetchone()[0]


def insert_session(con, folder_id, transcript, spans, started, ended, model, convo, md_file) -> int:
    title = (convo.get("name") or "").strip()
    cur = con.execute(
        """INSERT INTO sessions
             (started_at, ended_at, md_path, transcript, model, extract_state,
              title, title_locked, folder_id)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)""",
        (started, ended, str(md_file), transcript, model,
         title, 1 if title else 0, folder_id),
    )
    sid = cur.lastrowid
    raw = transcript.encode()
    for ord_, role, start, end in spans:
        con.execute(
            "INSERT INTO turns (session_id, ord, role, text, start_byte, end_byte)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (sid, ord_, role, raw[start:end].decode("utf-8"), start, end),
        )
    return sid


def migrate(dry_run: bool, project_name: str, db_path: Path, md_dir: Path, fresh: bool) -> None:
    session_key, org = desktop_session()

    project = find_project(session_key, org, project_name)
    print(f"project: {project['name']} ({project['uuid']})")

    listing = claude_get(
        f"https://claude.ai/api/organizations/{org}/projects/{project['uuid']}"
        f"/conversations?limit=500", session_key, org,
    )
    listing.sort(key=lambda c: c.get("created_at") or "")
    print(f"conversations in project: {len(listing)}")

    if not db_path.exists():
        sys.exit(f"AIgraph database not found at {db_path} — open AIgraph once, then retry")
    con = sqlite3.connect(str(db_path))
    con.execute("PRAGMA foreign_keys = ON")
    existing = {row[0] for row in con.execute("SELECT transcript FROM sessions")}

    folder_id = 0
    if not dry_run:
        folder_id = ensure_folder(con, project["name"])
    print(f"folder: {project['name']}")

    done = skipped = failed = removed = 0
    for entry in listing:
        uuid = entry["uuid"]
        try:
            convo = claude_get(
                f"https://claude.ai/api/organizations/{org}/chat_conversations/{uuid}"
                f"?tree=True&rendering_mode=messages", session_key, org,
            )
        except (urllib.error.HTTPError, urllib.error.URLError) as e:
            print(f"  ! could not fetch {uuid}: {e}")
            failed += 1
            continue
        time.sleep(0.3)

        messages = turns_of(convo)
        if not messages:
            print(f"  - no speech, skipped: {convo.get('name') or uuid}")
            skipped += 1
            continue

        started = normalize(convo.get("created_at") or entry["created_at"])
        ended = normalize(convo.get("updated_at") or convo.get("created_at") or started)
        model = convo.get("model") or "claude"
        transcript, spans = render(messages)

        if fresh:
            stale = con.execute(
                "SELECT id, md_path FROM sessions WHERE transcript = ?", (transcript,)
            ).fetchall()
            if dry_run:
                removed += len(stale)
            else:
                for sid, md in stale:
                    con.execute("DELETE FROM sessions WHERE id = ?", (sid,))
                    if md and Path(md).exists():
                        Path(md).unlink()
                    removed += 1

        if transcript in existing and not fresh:
            print(f"  = already archived, skipped: {convo.get('name') or uuid}")
            skipped += 1
            continue

        if dry_run:
            print(f"  would archive: {convo.get('name') or uuid} ({len(messages)} turns, {len(transcript)} chars)")
            done += 1
            continue

        md_file = write_markdown(md_dir, transcript, started, ended, model)
        sid = insert_session(con, folder_id, transcript, spans, started, ended, model, convo, md_file)
        print(f"  archived: {convo.get('name') or uuid} -> session {sid} ({len(messages)} turns)")
        done += 1

    if fresh and not dry_run:
        orphans = con.execute(
            "SELECT count(*) FROM ideas WHERE id NOT IN (SELECT idea_id FROM evidence)"
        ).fetchone()[0]
        if orphans:
            con.execute("DELETE FROM ideas WHERE id NOT IN (SELECT idea_id FROM evidence)")
            print(f"  dropped {orphans} ideas left without any evidence (they will be re-extracted)")
    if not dry_run:
        con.commit()
    con.close()
    print(f"\ndone: {done} archived, {removed} replaced, {skipped} skipped, {failed} failed"
          + (" (dry run — nothing written)" if dry_run else ""))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Migrate a claude.ai project's conversations into AIgraph.")
    ap.add_argument("--project", default="notes from a crazy man")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--fresh", action="store_true",
                    help="delete sessions with the same transcript first, then archive anew; ideas left "
                         "without any surviving evidence are dropped and re-extracted")
    args = ap.parse_args()
    migrate(dry_run=args.dry_run, project_name=args.project, fresh=args.fresh,
            db_path=DATA_DIR / "aigraph.db", md_dir=DATA_DIR / "transcripts")