//! Database schema.
//!
//! The whole schema from the plan is created up front, including tables the
//! current milestone doesn't write to yet. Ideas, evidence and revisions are
//! deliberately shaped for mutability from day one — retrofitting "an idea can
//! be rewritten and supported by several quotes" onto a one-row-per-idea table
//! would mean migrating live user data later.

pub const VERSION: i32 = 1;

pub const SCHEMA: &str = r#"
-- Somewhere to keep one line of thinking apart from another. A conversation
-- belongs to exactly one folder; the ideas it produced follow it there.
-- Folder 1 is "Root" and always exists — anything unsorted lands in it.
CREATE TABLE IF NOT EXISTS folders (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id            INTEGER PRIMARY KEY,
    started_at    TEXT NOT NULL,
    ended_at      TEXT,
    md_path       TEXT,
    transcript    TEXT NOT NULL,
    model         TEXT NOT NULL,
    -- pending | extracting | done | failed
    extract_state TEXT NOT NULL DEFAULT 'pending',
    extract_error TEXT,
    -- Short AI-generated title, e.g. "American Economic Empire". Empty until
    -- extraction runs once.
    title         TEXT NOT NULL DEFAULT '',
    -- Set once a person renames the session by hand, so a later re-extraction
    -- never overwrites their own choice.
    title_locked  INTEGER NOT NULL DEFAULT 0,
    archived      INTEGER NOT NULL DEFAULT 0,
    folder_id     INTEGER NOT NULL DEFAULT 1 REFERENCES folders(id)
);

-- `start_byte`/`end_byte` locate this turn's CONTENT inside sessions.transcript.
-- Written only by session::transcript::render, which produces text and offsets
-- together so they cannot drift apart.
CREATE TABLE IF NOT EXISTS turns (
    id         INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    ord        INTEGER NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
    text       TEXT NOT NULL,
    start_byte INTEGER NOT NULL,
    end_byte   INTEGER NOT NULL,
    UNIQUE (session_id, ord)
);

-- An idea owns no quote and no session: it is a claim that can be rewritten and
-- can draw support from many moments. See `evidence`.
CREATE TABLE IF NOT EXISTS ideas (
    id         INTEGER PRIMARY KEY,
    claim      TEXT NOT NULL,
    -- A short, glanceable name for the idea, written from its context rather
    -- than sliced out of the claim — "Giving as a hedge against envy", not the
    -- first sixty characters of the sentence.
    title      TEXT NOT NULL DEFAULT '',
    -- What the idea is about. Colours the map by subject rather than by which
    -- conversation happened to produce it.
    category   TEXT NOT NULL DEFAULT '',
    revision   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- One verified quote supporting an idea. `start_byte`/`end_byte` are relative to
-- turns.text, not to the transcript; combine via session::transcript::absolute.
CREATE TABLE IF NOT EXISTS evidence (
    id          INTEGER PRIMARY KEY,
    idea_id     INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
    session_id  INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id     INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    quote       TEXT NOT NULL,
    start_byte  INTEGER NOT NULL,
    end_byte    INTEGER NOT NULL,
    ambiguous   INTEGER NOT NULL DEFAULT 0,
    normalized  INTEGER NOT NULL DEFAULT 0,
    -- Why the model read this passage as carrying this claim. Shown on hover in
    -- the conversation's deep dive.
    reasoning   TEXT NOT NULL DEFAULT '',
    provider    TEXT NOT NULL,
    model       TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idea_revisions (
    id                INTEGER PRIMARY KEY,
    idea_id           INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
    prev_claim        TEXT NOT NULL,
    new_claim         TEXT NOT NULL,
    cause_evidence_id INTEGER REFERENCES evidence(id) ON DELETE SET NULL,
    verdict           TEXT NOT NULL,
    confidence        REAL NOT NULL,
    reverted_at       TEXT,
    created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS relations (
    id         INTEGER PRIMARY KEY,
    idea_a     INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
    idea_b     INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('duplicate','refines','contradicts','related')),
    confidence REAL NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (idea_a, idea_b, kind)
);

-- Nudges on a whole conversation, as distinct from a single idea.
CREATE TABLE IF NOT EXISTS session_nudges (
    id         INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('strong','weak')),
    text       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nudges (
    id      INTEGER PRIMARY KEY,
    idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
    kind    TEXT NOT NULL CHECK (kind IN ('strong','weak')),
    text    TEXT NOT NULL
);

-- `model` matters: vectors from different embedding models are not comparable,
-- so they are filtered on read rather than silently mixed.
-- A short version of one answer, made after the fact. The answer itself is
-- never altered — this sits beside it in `turns`.
CREATE TABLE IF NOT EXISTS reply_digests (
    turn_id    INTEGER PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
    content    TEXT NOT NULL,
    model      TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- A fuller argument about one idea, generated on first open and kept.
-- Doing this for every idea at extraction time would multiply the cost of every
-- session for material most ideas are never asked about.
CREATE TABLE IF NOT EXISTS idea_deep_dives (
    idea_id    INTEGER PRIMARY KEY REFERENCES ideas(id) ON DELETE CASCADE,
    content    TEXT NOT NULL,
    model      TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS embeddings (
    idea_id INTEGER PRIMARY KEY REFERENCES ideas(id) ON DELETE CASCADE,
    dims    INTEGER NOT NULL,
    vec     BLOB NOT NULL,
    model   TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS positions (
    idea_id INTEGER PRIMARY KEY REFERENCES ideas(id) ON DELETE CASCADE,
    x       REAL NOT NULL,
    y       REAL NOT NULL
);

-- Ideas the model proposed that could not be traced to real words. Kept rather
-- than discarded: the drop rate is the product's honesty metric, and it can only
-- be computed and inspected if the failures are retained.
CREATE TABLE IF NOT EXISTS rejected_ideas (
    id         INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    claim      TEXT NOT NULL,
    quote      TEXT NOT NULL,
    reason     TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_turns_session   ON turns(session_id);
CREATE INDEX IF NOT EXISTS idx_evidence_idea   ON evidence(idea_id);
CREATE INDEX IF NOT EXISTS idx_evidence_turn   ON evidence(turn_id);
CREATE INDEX IF NOT EXISTS idx_nudges_idea     ON nudges(idea_id);
CREATE INDEX IF NOT EXISTS idx_sessions_state  ON sessions(extract_state);
"#;


/// Additive migrations for databases created by an earlier build.
///
/// Deliberately tiny and idempotent: this is a local-first app, and a user's
/// only copy of their thinking lives in this file. Anything that could drop a
/// column or rewrite rows does not belong here.
pub fn migrate(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    let columns: Vec<String> = conn
        .prepare("SELECT name FROM pragma_table_info('embeddings')")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;

    let evidence_cols: Vec<String> = conn
        .prepare("SELECT name FROM pragma_table_info('evidence')")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    if !evidence_cols.iter().any(|c| c == "reasoning") {
        conn.execute_batch(
            "ALTER TABLE evidence ADD COLUMN reasoning TEXT NOT NULL DEFAULT '';",
        )?;
    }

    let idea_cols: Vec<String> = conn
        .prepare("SELECT name FROM pragma_table_info('ideas')")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    if !idea_cols.iter().any(|c| c == "category") {
        conn.execute_batch("ALTER TABLE ideas ADD COLUMN category TEXT NOT NULL DEFAULT '';")?;
    }
    if !idea_cols.iter().any(|c| c == "title") {
        conn.execute_batch("ALTER TABLE ideas ADD COLUMN title TEXT NOT NULL DEFAULT '';")?;
    }

    if !columns.iter().any(|c| c == "model") {
        conn.execute_batch(
            "ALTER TABLE embeddings ADD COLUMN model TEXT NOT NULL DEFAULT '';
             -- Existing vectors predate model tracking, so their provenance is
             -- unknown. Dropping them costs one re-embed; keeping them risks
             -- comparing incomparable spaces forever.
             DELETE FROM embeddings;",
        )?;
    }

    let session_cols: Vec<String> = conn
        .prepare("SELECT name FROM pragma_table_info('sessions')")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    if !session_cols.iter().any(|c| c == "title") {
        conn.execute_batch("ALTER TABLE sessions ADD COLUMN title TEXT NOT NULL DEFAULT '';")?;
    }
    if !session_cols.iter().any(|c| c == "title_locked") {
        conn.execute_batch(
            "ALTER TABLE sessions ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0;",
        )?;
    }
    if !session_cols.iter().any(|c| c == "archived") {
        conn.execute_batch("ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;")?;
    }
    if !session_cols.iter().any(|c| c == "folder_id") {
        // No REFERENCES here: SQLite cannot add a column with a foreign key
        // that has a non-constant default. The constraint holds on new
        // databases, and every write goes through set_session_folder anyway.
        conn.execute_batch("ALTER TABLE sessions ADD COLUMN folder_id INTEGER NOT NULL DEFAULT 1;")?;
    }

    // Root always exists, on a fresh database and on one made before folders.
    conn.execute(
        "INSERT OR IGNORE INTO folders (id, name, created_at) VALUES (1, 'Root', ?1)",
        [chrono::Utc::now().to_rfc3339()],
    )?;
    Ok(())
}
