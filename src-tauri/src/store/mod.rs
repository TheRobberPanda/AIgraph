//! SQLite persistence.

pub mod schema;

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::embed;
use crate::extract::verify::{Rejection, Turn};
use crate::extract::{Extraction, VerifiedIdea};
use crate::llm::types::Role;
use crate::reconcile::Decision;
use crate::session::transcript::Rendered;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("writing transcript: {0}")]
    Io(#[from] std::io::Error),
    /// Stored offsets no longer select the stored quote. Should be impossible;
    /// surfaced loudly rather than papered over, because a wrong highlight is
    /// worse than a missing one.
    #[error(
        "evidence {evidence_id} no longer matches its source (expected {quote:?}, found {found:?})"
    )]
    Provenance { evidence_id: i64, quote: String, found: String },
}

pub type Result<T> = std::result::Result<T, StoreError>;

pub struct Store {
    conn: Connection,
}

/// A place to keep one line of thinking apart from another.
#[derive(Debug, Clone, Serialize)]
pub struct Folder {
    pub id: i64,
    pub name: String,
    /// How many conversations are filed here.
    pub session_count: i64,
}

/// Root always exists and cannot be removed — unsorted thinking lands here.
pub const ROOT_FOLDER: i64 = 1;

#[derive(Debug, Clone, Serialize)]
pub struct SessionSummary {
    pub id: i64,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub md_path: Option<String>,
    pub model: String,
    pub extract_state: String,
    pub turn_count: i64,
    /// How many ideas came out of it — the reason to go back to a conversation.
    pub idea_count: i64,
    /// The subjects it turned out to be about, taken from the ideas it produced.
    ///
    /// Derived rather than typed in: tags nobody maintains go stale, and the
    /// categories are already being assigned.
    pub tags: Vec<String>,
    /// First thing the user said, for identifying a session at a glance.
    pub opening: String,
    /// Short AI-generated title, e.g. "American Economic Empire". Empty until
    /// extraction has run once, or set by hand.
    pub title: String,
    pub archived: bool,
    pub folder_id: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct StoredIdea {
    pub id: i64,
    pub claim: String,
    /// A short, glanceable name — see the column comment on `ideas.title`.
    /// Falls back to the claim itself for ideas extracted before this existed.
    pub title: String,
    /// What the idea is about. Carried so a list can colour by subject the
    /// same way the map does.
    pub category: String,
    pub evidence: Vec<StoredEvidence>,
    pub strong: Vec<String>,
    pub weak: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StoredEvidence {
    pub id: i64,
    pub session_id: i64,
    pub turn_id: i64,
    pub quote: String,
    pub start_byte: i64,
    pub end_byte: i64,
    pub normalized: bool,
    pub ambiguous: bool,
}

/// A conversation's file: the transcript, pre-split around every extracted span.
///
/// Split in Rust for the same reason as [`SourceView`] — Rust counts UTF-8
/// bytes and JavaScript indexes UTF-16 code units, so only whole strings cross
/// the boundary.
#[derive(Debug, Clone, Serialize)]
pub struct ConversationView {
    pub session_id: i64,
    pub started_at: String,
    pub title: String,
    pub model: String,
    pub turns: Vec<ViewTurn>,
    pub strong: Vec<String>,
    pub weak: Vec<String>,
}

/// One turn, split around the spans that produced ideas.
///
/// Grouped by turn rather than returned as one flat run, so the reader can show
/// who is speaking without the `USER:` / `ASSISTANT:` markers leaking through —
/// those exist to tell the extraction prompt whose words are whose, and are not
/// something a person should ever have to read.
#[derive(Debug, Clone, Serialize)]
pub struct ViewTurn {
    pub id: i64,
    pub role: String,
    pub segments: Vec<Segment>,
    /// A short version of an answer. The answer itself is always in `segments`.
    pub digest: Option<String>,
}

/// A run of transcript. Highlighted runs carry the idea they produced.
#[derive(Debug, Clone, Serialize)]
pub struct Segment {
    pub text: String,
    pub idea_id: Option<i64>,
    pub claim: Option<String>,
    /// The idea's short, simplified name — shown instead of the claim, which
    /// is often the quote's own words and so reads as a pointless repeat of
    /// the highlighted text right above it.
    pub title: Option<String>,
    /// Why the model read these words as carrying that claim.
    pub reasoning: Option<String>,
}

/// An idea's file.
#[derive(Debug, Clone, Serialize)]
pub struct IdeaView {
    pub id: i64,
    pub claim: String,
    pub title: String,
    pub revision: i64,
    pub strong: Vec<String>,
    pub weak: Vec<String>,
    pub evidence: Vec<IdeaEvidence>,
    pub revisions: Vec<IdeaRevision>,
}

#[derive(Debug, Clone, Serialize)]
pub struct IdeaEvidence {
    pub id: i64,
    pub session_id: i64,
    pub turn_id: i64,
    pub started_at: String,
    pub quote: String,
    pub reasoning: String,
    pub normalized: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct IdeaRevision {
    pub id: i64,
    pub prev_claim: String,
    pub new_claim: String,
    pub confidence: f32,
    pub created_at: String,
    pub reverted_at: Option<String>,
}

/// One node in the bipartite map.
///
/// Ids are prefixed (`s3`, `i7`) because conversations and ideas share a single
/// node namespace in the renderer, and a collision would silently draw edges to
/// the wrong thing.
#[derive(Debug, Clone, Serialize)]
pub struct GraphNode {
    pub id: String,
    pub kind: &'static str,
    pub label: String,
    /// Conversations: how many ideas came out of it.
    /// Ideas: how many conversations it appears in — an idea you keep returning
    /// to earns a bigger dot.
    pub weight: i64,
    pub session_id: Option<i64>,
    pub idea_id: Option<i64>,
    /// What the idea is about. Empty for conversations.
    pub category: String,
    /// When a conversation happened. Empty for ideas.
    pub date: String,
    /// Ideas only: true when more than one conversation supports it. These are
    /// the nodes that actually connect the map together.
    pub shared: bool,
    /// Rewritten in the last few minutes. The map marks these so a claim that
    /// changed while you were away does not change silently.
    pub just_revised: bool,
    /// Carried on the node rather than fetched on hover: the hover animation has
    /// to start in the same frame as the mouse arriving, and a round trip would
    /// make it stutter. At one person's scale this is a few KB of extra JSON.
    pub strong: Vec<String>,
    pub weak: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    /// `from` (conversation → idea), `related`, or `contradicts`.
    pub kind: String,
    pub weight: f32,
    /// Why these two relate, where reconciliation said so. Absent on the
    /// structural edges, and on links drawn from similarity alone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Graph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

/// Everything a deep dive needs about one idea: the claim, what holds up,
/// what is thin, and the words it came from.
pub type IdeaForDeepDive = (String, Vec<String>, Vec<String>, Vec<String>);

/// Notes against each id: what holds up, and what is thin.
pub type NudgesById = std::collections::HashMap<i64, (Vec<String>, Vec<String>)>;

/// The honesty metric, as shown in Diagnostics.
#[derive(Debug, Clone, Serialize, Default)]
pub struct Diagnostics {
    pub ideas: i64,
    pub rejected: i64,
    pub drop_rate: f32,
    /// Ideas found only via the normalized fallback rather than an exact match.
    /// Still real spans, but worth watching: a rising share means the model is
    /// paraphrasing quotes rather than copying them.
    pub normalized: i64,
    pub sessions_extracted: i64,
    pub sessions_pending: i64,
    /// Rejections grouped by reason — `NotFound` climbing means invention,
    /// `AttributedToAssistant` climbing means the prompt is losing track of who
    /// said what. Different problems, different fixes.
    pub by_reason: Vec<(String, i64)>,
}

/// An archived transcript, pre-split around one highlighted quote.
///
/// The split is done here rather than in the UI on purpose. Rust offsets count
/// UTF-8 bytes; JavaScript strings are indexed in UTF-16 code units. Handing
/// raw offsets across that boundary works perfectly until someone types an
/// emoji or an accent, then silently highlights the wrong text — the exact
/// class of failure the verifier exists to prevent. Slicing on this side means
/// the boundary only ever carries whole strings.
#[derive(Debug, Clone, Serialize)]
pub struct SourceView {
    pub session_id: i64,
    pub started_at: String,
    pub before: String,
    pub highlight: String,
    pub after: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct StoredTurn {
    pub id: i64,
    pub ord: i64,
    pub role: String,
    pub text: String,
    pub start_byte: i64,
    pub end_byte: i64,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        // Foreign keys are off by default in SQLite; without this the ON DELETE
        // CASCADE rules in the schema are silently decorative.
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.execute_batch(schema::SCHEMA)?;
        schema::migrate(&conn)?;
        conn.pragma_update(None, "user_version", schema::VERSION)?;
        Ok(Self { conn })
    }

    /// Archive a finished session.
    ///
    /// The transcript and its turn offsets are written in one transaction, so a
    /// crash can never leave turns pointing into a transcript that was never
    /// stored. If `md_dir` is given, a markdown copy is written too — the
    /// database is for the app, the markdown is for the user.
    pub fn archive_session(
        &mut self,
        rendered: &Rendered,
        model: &str,
        started_at: DateTime<Utc>,
        md_dir: Option<&Path>,
    ) -> Result<i64> {
        let ended_at = Utc::now();

        // Written before the transaction so a failing disk doesn't leave a
        // committed session pointing at a file that isn't there.
        let md_path = match md_dir {
            Some(dir) => Some(write_markdown(dir, rendered, model, started_at, ended_at)?),
            None => None,
        };

        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO sessions (started_at, ended_at, md_path, transcript, model, extract_state)
             VALUES (?1, ?2, ?3, ?4, ?5, 'pending')",
            params![
                started_at.to_rfc3339(),
                ended_at.to_rfc3339(),
                md_path.as_ref().map(|p| p.to_string_lossy().to_string()),
                rendered.text,
                model,
            ],
        )?;
        let session_id = tx.last_insert_rowid();

        {
            let mut stmt = tx.prepare(
                "INSERT INTO turns (session_id, ord, role, text, start_byte, end_byte)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            for span in &rendered.spans {
                let role = match span.role {
                    Role::User => "user",
                    Role::Assistant => "assistant",
                };
                stmt.execute(params![
                    session_id,
                    span.ord as i64,
                    role,
                    &rendered.text[span.start..span.end],
                    span.start as i64,
                    span.end as i64,
                ])?;
            }
        }

        tx.commit()?;
        Ok(session_id)
    }

    /// Replace an archived conversation with a longer version of itself.
    ///
    /// Used when a conversation is picked back up: the transcript grows at the
    /// end and nothing before the join moves, so every byte offset already
    /// recorded in `evidence` still points at the same words. That is the whole
    /// reason continuing is safe and editing a past turn would not be.
    ///
    /// The turns are rewritten and the session goes back in the queue. Existing
    /// ideas are left alone — reconciliation will meet them again on the way
    /// through and attach, rewrite, or leave them as it sees fit.
    pub fn extend_session(
        &mut self,
        session_id: i64,
        rendered: &Rendered,
        model: &str,
        md_dir: Option<&Path>,
    ) -> Result<()> {
        let started_at: String = self.conn.query_row(
            "SELECT started_at FROM sessions WHERE id = ?1",
            [session_id],
            |r| r.get(0),
        )?;
        let started = DateTime::parse_from_rfc3339(&started_at)
            .map(|d| d.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now());
        let ended_at = Utc::now();

        let md_path = match md_dir {
            Some(dir) => Some(write_markdown(dir, rendered, model, started, ended_at)?),
            None => None,
        };

        let tx = self.conn.transaction()?;
        tx.execute(
            "UPDATE sessions
                SET ended_at = ?2, transcript = ?3, extract_state = 'pending',
                    md_path = COALESCE(?4, md_path)
              WHERE id = ?1",
            params![
                session_id,
                ended_at.to_rfc3339(),
                rendered.text,
                md_path.as_ref().map(|p| p.to_string_lossy().to_string()),
            ],
        )?;
        tx.execute("DELETE FROM turns WHERE session_id = ?1", [session_id])?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO turns (session_id, ord, role, text, start_byte, end_byte)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            for span in &rendered.spans {
                let role = match span.role {
                    Role::User => "user",
                    Role::Assistant => "assistant",
                };
                stmt.execute(params![
                    session_id,
                    span.ord as i64,
                    role,
                    &rendered.text[span.start..span.end],
                    span.start as i64,
                    span.end as i64,
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Conversations, optionally only those in one folder.
    ///
    /// `None` means every folder. A folder exists to keep one line of thinking
    /// apart from another, so when one is chosen everything derived from a
    /// conversation outside it is out of view as well — otherwise the folders
    /// are labels rather than separations.
    pub fn list_sessions(&self, limit: i64, folder: Option<i64>) -> Result<Vec<SessionSummary>> {
        let mut stmt = self.conn.prepare(
            "SELECT s.id, s.started_at, s.ended_at, s.md_path, s.model, s.extract_state,
                    (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id),
                    (SELECT COUNT(DISTINCT e.idea_id) FROM evidence e WHERE e.session_id = s.id),
                    COALESCE((SELECT t.text FROM turns t
                              WHERE t.session_id = s.id AND t.role = 'user'
                              ORDER BY t.ord LIMIT 1), ''),
                    s.title, s.archived, s.folder_id
             FROM sessions s
             WHERE (?2 IS NULL OR s.folder_id = ?2)
             ORDER BY s.started_at DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit, folder], |r| {
            Ok(SessionSummary {
                id: r.get(0)?,
                started_at: r.get(1)?,
                ended_at: r.get(2)?,
                md_path: r.get(3)?,
                model: r.get(4)?,
                extract_state: r.get(5)?,
                turn_count: r.get(6)?,
                idea_count: r.get(7)?,
                tags: Vec::new(),
                opening: r.get(8)?,
                title: r.get(9)?,
                archived: r.get::<_, i64>(10)? != 0,
                folder_id: r.get(11)?,
            })
        })?;

        let mut summaries: Vec<SessionSummary> = rows.collect::<rusqlite::Result<_>>()?;

        // One query for every session's subjects rather than one per session.
        let mut tag_stmt = self.conn.prepare(
            "SELECT DISTINCT e.session_id, i.category
             FROM evidence e JOIN ideas i ON i.id = e.idea_id
             WHERE i.category <> ''
             ORDER BY i.category",
        )?;
        let mut by_session: std::collections::HashMap<i64, Vec<String>> = Default::default();
        for row in tag_stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))? {
            let (id, tag) = row?;
            by_session.entry(id).or_default().push(tag);
        }
        for s in &mut summaries {
            s.tags = by_session.remove(&s.id).unwrap_or_default();
        }

        Ok(summaries)
    }

    pub fn transcript(&self, session_id: i64) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT transcript FROM sessions WHERE id = ?1", [session_id], |r| r.get(0))
            .optional()?)
    }

    pub fn turns(&self, session_id: i64) -> Result<Vec<StoredTurn>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, ord, role, text, start_byte, end_byte
             FROM turns WHERE session_id = ?1 ORDER BY ord",
        )?;
        let rows = stmt.query_map([session_id], |r| {
            Ok(StoredTurn {
                id: r.get(0)?,
                ord: r.get(1)?,
                role: r.get(2)?,
                text: r.get(3)?,
                start_byte: r.get(4)?,
                end_byte: r.get(5)?,
            })
        })?;
        rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
    }

    /// Sessions archived but not yet extracted.
    ///
    /// Extraction runs after archiving and can be interrupted by a crash or a
    /// quit, so it is driven off this queue rather than fired once and hoped
    /// for. Nothing the user said should be lost to bad timing.
    pub fn pending_extraction(&self) -> Result<Vec<i64>> {
        let mut stmt = self.conn.prepare(
            "SELECT id FROM sessions WHERE extract_state IN ('pending','extracting') ORDER BY id",
        )?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
    }

    /// Turns in the shape the verifier expects.
    pub fn verify_turns(&self, session_id: i64) -> Result<Vec<Turn>> {
        Ok(self
            .turns(session_id)?
            .into_iter()
            .map(|t| Turn {
                id: t.id,
                role: if t.role == "user" { Role::User } else { Role::Assistant },
                text: t.text,
            })
            .collect())
    }

    /// Persist one session's extraction.
    ///
    /// Ideas are inserted as new here. Milestone 5 puts reconciliation in front
    /// of this, at which point most extracted ideas will attach evidence to an
    /// existing bubble instead of creating one.
    ///
    /// Rejected ideas are stored too, not discarded — the drop rate can only be
    /// honest if the failures are kept.
    pub fn save_extraction(
        &mut self,
        session_id: i64,
        extraction: &Extraction,
        provider: &str,
        model: &str,
    ) -> Result<Vec<i64>> {
        let now = Utc::now().to_rfc3339();
        let tx = self.conn.transaction()?;
        let mut ids = Vec::new();

        for v in &extraction.ideas {
            tx.execute(
                "INSERT INTO ideas (claim, revision, created_at, updated_at) VALUES (?1, 0, ?2, ?2)",
                params![v.raw.claim, now],
            )?;
            let idea_id = tx.last_insert_rowid();
            ids.push(idea_id);

            tx.execute(
                "INSERT INTO evidence
                   (idea_id, session_id, turn_id, quote, start_byte, end_byte,
                    ambiguous, normalized, provider, model, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    idea_id,
                    session_id,
                    v.located.turn_id,
                    v.located.matched_text,
                    v.located.start_byte as i64,
                    v.located.end_byte as i64,
                    v.located.ambiguous as i64,
                    v.located.normalized_match as i64,
                    provider,
                    model,
                    now,
                ],
            )?;

            for note in &v.raw.notes {
                tx.execute(
                    "INSERT INTO nudges (idea_id, kind, text) VALUES (?1, ?2, ?3)",
                    params![idea_id, note.kind.column(), note.text],
                )?;
            }
        }

        for r in &extraction.rejected {
            let reason = match r.reason {
                Rejection::NotFound => "not_found",
                Rejection::AttributedToAssistant => "attributed_to_assistant",
                Rejection::EmptyQuote => "empty_quote",
            };
            tx.execute(
                "INSERT INTO rejected_ideas (session_id, claim, quote, reason, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![session_id, r.raw.claim, r.raw.quote, reason, now],
            )?;
        }

        tx.execute(
            "UPDATE sessions SET extract_state = 'done', extract_error = NULL WHERE id = ?1",
            [session_id],
        )?;
        tx.commit()?;
        Ok(ids)
    }

    /// Titles of what has already been thought, newest first.
    ///
    /// Scoped to a folder, because a folder is a separate line of thinking and
    /// crossing them is exactly what folders exist to prevent. Titled ideas
    /// only — an untitled one would be handed over as an empty bullet.
    pub fn idea_titles(&self, folder: Option<i64>, limit: usize) -> Result<Vec<(i64, String)>> {
        let sql = match folder {
            Some(_) => {
                "SELECT DISTINCT i.id, i.title FROM ideas i
                   JOIN evidence e ON e.idea_id = i.id
                   JOIN sessions s ON s.id = e.session_id
                  WHERE i.title <> '' AND COALESCE(s.folder_id, 1) = ?1
                  ORDER BY i.updated_at DESC LIMIT ?2"
            }
            None => {
                "SELECT id, title FROM ideas
                  WHERE title <> '' AND ?1 IS NULL
                  ORDER BY updated_at DESC LIMIT ?2"
            }
        };
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt.query_map(params![folder, limit as i64], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn ideas(&self, folder: Option<i64>) -> Result<Vec<StoredIdea>> {
        let mut stmt = self
            .conn
            // Archiving a conversation archives what came out of it. An idea
            // still supported by a conversation that is not archived stays,
            // since it is that other conversation's idea too.
            .prepare(
                "SELECT i.id, i.claim, i.title, i.category FROM ideas i
                 WHERE EXISTS (
                   SELECT 1 FROM evidence e JOIN sessions s ON s.id = e.session_id
                   WHERE e.idea_id = i.id AND s.archived = 0
                     AND (?1 IS NULL OR s.folder_id = ?1)
                 )
                 ORDER BY i.updated_at DESC, i.id DESC",
            )?;
        let rows: Vec<(i64, String, String, String)> = stmt
            .query_map([folder], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<rusqlite::Result<_>>()?;

        let mut out = Vec::with_capacity(rows.len());
        for (id, claim, title, category) in rows {
            let mut ev = self.conn.prepare(
                "SELECT id, session_id, turn_id, quote, start_byte, end_byte, normalized, ambiguous
                 FROM evidence WHERE idea_id = ?1 ORDER BY created_at",
            )?;
            let evidence = ev
                .query_map([id], |r| {
                    Ok(StoredEvidence {
                        id: r.get(0)?,
                        session_id: r.get(1)?,
                        turn_id: r.get(2)?,
                        quote: r.get(3)?,
                        start_byte: r.get(4)?,
                        end_byte: r.get(5)?,
                        normalized: r.get::<_, i64>(6)? != 0,
                        ambiguous: r.get::<_, i64>(7)? != 0,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;

            let mut nudge =
                self.conn.prepare("SELECT kind, text FROM nudges WHERE idea_id = ?1")?;
            let nudges = nudge
                .query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;

            out.push(StoredIdea {
                id,
                title: if title.is_empty() { claim.clone() } else { title },
                claim,
                category,
                evidence,
                strong: nudges
                    .iter()
                    .filter(|(k, _)| k == "strong")
                    .map(|(_, t)| t.clone())
                    .collect(),
                weak: nudges.iter().filter(|(k, _)| k == "weak").map(|(_, t)| t.clone()).collect(),
            });
        }
        Ok(out)
    }

    pub fn diagnostics(&self) -> Result<Diagnostics> {
        let ideas: i64 = self.conn.query_row("SELECT COUNT(*) FROM ideas", [], |r| r.get(0))?;
        let rejected: i64 =
            self.conn.query_row("SELECT COUNT(*) FROM rejected_ideas", [], |r| r.get(0))?;
        let normalized: i64 =
            self.conn.query_row("SELECT COUNT(*) FROM evidence WHERE normalized = 1", [], |r| {
                r.get(0)
            })?;
        let done: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM sessions WHERE extract_state = 'done'",
            [],
            |r| r.get(0),
        )?;
        let pending: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM sessions WHERE extract_state IN ('pending','extracting')",
            [],
            |r| r.get(0),
        )?;

        let mut stmt = self.conn.prepare(
            "SELECT reason, COUNT(*) FROM rejected_ideas GROUP BY reason ORDER BY 2 DESC",
        )?;
        let by_reason = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let total = ideas + rejected;
        Ok(Diagnostics {
            ideas,
            rejected,
            drop_rate: if total == 0 { 0.0 } else { rejected as f32 / total as f32 },
            normalized,
            sessions_extracted: done,
            sessions_pending: pending,
            by_reason,
        })
    }

    /// The archived transcript, split around one piece of evidence.
    ///
    /// Verifies as it goes: the text at those offsets must still equal the quote
    /// that was stored. If it doesn't, something has drifted, and the honest
    /// response is an error rather than confidently highlighting the wrong
    /// sentence.
    pub fn source_view(&self, evidence_id: i64) -> Result<SourceView> {
        let (session_id, turn_id, quote, start, end): (i64, i64, String, i64, i64) =
            self.conn.query_row(
                "SELECT session_id, turn_id, quote, start_byte, end_byte
                 FROM evidence WHERE id = ?1",
                [evidence_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )?;

        let (transcript, started_at): (String, String) = self.conn.query_row(
            "SELECT transcript, started_at FROM sessions WHERE id = ?1",
            [session_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;

        // Offsets on `evidence` are relative to the turn; `turns` locates the
        // turn within the transcript. Combining them is the only correct way to
        // get an absolute position.
        let turn_start: i64 =
            self.conn
                .query_row("SELECT start_byte FROM turns WHERE id = ?1", [turn_id], |r| r.get(0))?;

        let (abs_start, abs_end) = ((turn_start + start) as usize, (turn_start + end) as usize);

        let valid = abs_end <= transcript.len()
            && transcript.is_char_boundary(abs_start)
            && transcript.is_char_boundary(abs_end)
            && transcript[abs_start..abs_end] == quote;

        if !valid {
            return Err(StoreError::Provenance {
                evidence_id,
                quote,
                found: transcript
                    .get(abs_start..abs_end)
                    .map(str::to_string)
                    .unwrap_or_else(|| "<out of range>".into()),
            });
        }

        Ok(SourceView {
            session_id,
            started_at,
            before: transcript[..abs_start].to_string(),
            highlight: transcript[abs_start..abs_end].to_string(),
            after: transcript[abs_end..].to_string(),
        })
    }

    /// A conversation with every extracted span marked in place.
    pub fn conversation_view(&self, session_id: i64) -> Result<ConversationView> {
        let (started_at, title, model): (String, String, String) = self.conn.query_row(
            "SELECT started_at, COALESCE(title, ''), model FROM sessions WHERE id = ?1",
            [session_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;

        // Offsets on `evidence` are relative to the turn, which is exactly the
        // frame needed here.
        let mut stmt = self.conn.prepare(
            "SELECT e.turn_id, e.idea_id, i.claim, i.title, e.reasoning, e.start_byte, e.end_byte
             FROM evidence e JOIN ideas i ON i.id = e.idea_id
             WHERE e.session_id = ?1
             ORDER BY e.turn_id, e.start_byte",
        )?;
        let spans: Vec<(i64, i64, String, String, String, usize, usize)> = stmt
            .query_map([session_id], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get::<_, i64>(5)? as usize,
                    r.get::<_, i64>(6)? as usize,
                ))
            })?
            .collect::<rusqlite::Result<_>>()?;

        let mut turns = Vec::new();
        for turn in self.turns(session_id)? {
            let text = &turn.text;
            let mut segments = Vec::new();
            let mut cursor = 0usize;

            for (_, idea_id, claim, title, reasoning, start, end) in
                spans.iter().filter(|s| s.0 == turn.id)
            {
                // Skip overlaps and anything that no longer lands on a character
                // boundary. A mangled highlight is worse than none.
                if *start < cursor
                    || *end > text.len()
                    || start >= end
                    || !text.is_char_boundary(*start)
                    || !text.is_char_boundary(*end)
                {
                    continue;
                }
                if *start > cursor {
                    segments.push(Segment {
                        text: text[cursor..*start].to_string(),
                        idea_id: None,
                        claim: None,
                        title: None,
                        reasoning: None,
                    });
                }
                segments.push(Segment {
                    text: text[*start..*end].to_string(),
                    idea_id: Some(*idea_id),
                    claim: Some(claim.clone()),
                    title: Some(if title.is_empty() { claim.clone() } else { title.clone() }),
                    reasoning: Some(reasoning.clone()),
                });
                cursor = *end;
            }
            if cursor < text.len() {
                segments.push(Segment {
                    text: text[cursor..].to_string(),
                    idea_id: None,
                    claim: None,
                    title: None,
                    reasoning: None,
                });
            }

            let digest = self
                .conn
                .query_row("SELECT content FROM reply_digests WHERE turn_id = ?1", [turn.id], |r| {
                    r.get::<_, String>(0)
                })
                .optional()?;
            turns.push(ViewTurn { id: turn.id, role: turn.role, segments, digest });
        }

        let (strong, weak) = self.nudges_for("session_nudges", "session_id", session_id)?;
        Ok(ConversationView { session_id, started_at, title, model, turns, strong, weak })
    }

    /// One idea, with everything that supports it and how it has changed.
    pub fn idea_view(&self, idea_id: i64) -> Result<IdeaView> {
        let (claim, title, revision): (String, String, i64) = self.conn.query_row(
            "SELECT claim, title, revision FROM ideas WHERE id = ?1",
            [idea_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        let title = if title.is_empty() { claim.clone() } else { title };

        let mut ev = self.conn.prepare(
            "SELECT e.id, e.session_id, e.turn_id, s.started_at, e.quote, e.reasoning, e.normalized
             FROM evidence e JOIN sessions s ON s.id = e.session_id
             WHERE e.idea_id = ?1 ORDER BY s.started_at",
        )?;
        let evidence = ev
            .query_map([idea_id], |r| {
                Ok(IdeaEvidence {
                    id: r.get(0)?,
                    session_id: r.get(1)?,
                    turn_id: r.get(2)?,
                    started_at: r.get(3)?,
                    quote: r.get(4)?,
                    reasoning: r.get(5)?,
                    normalized: r.get::<_, i64>(6)? != 0,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut rev = self.conn.prepare(
            "SELECT id, prev_claim, new_claim, confidence, created_at, reverted_at
             FROM idea_revisions WHERE idea_id = ?1 ORDER BY created_at DESC",
        )?;
        let revisions = rev
            .query_map([idea_id], |r| {
                Ok(IdeaRevision {
                    id: r.get(0)?,
                    prev_claim: r.get(1)?,
                    new_claim: r.get(2)?,
                    confidence: r.get(3)?,
                    created_at: r.get(4)?,
                    reverted_at: r.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let (strong, weak) = self.nudges_for("nudges", "idea_id", idea_id)?;
        Ok(IdeaView { id: idea_id, claim, title, revision, strong, weak, evidence, revisions })
    }

    /// Every nudge in one table, grouped by owner.
    fn grouped_nudges(&self, table: &str, column: &str) -> Result<NudgesById> {
        let mut stmt = self.conn.prepare(&format!("SELECT {column}, kind, text FROM {table}"))?;
        let rows: Vec<(i64, String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<_>>()?;

        let mut out: std::collections::HashMap<i64, (Vec<String>, Vec<String>)> =
            Default::default();
        for (id, kind, text) in rows {
            let entry = out.entry(id).or_default();
            if kind == "strong" {
                entry.0.push(text);
            } else {
                entry.1.push(text);
            }
        }
        Ok(out)
    }

    fn nudges_for(&self, table: &str, column: &str, id: i64) -> Result<(Vec<String>, Vec<String>)> {
        // `table` and `column` are compile-time constants at every call site,
        // never user input.
        let mut stmt =
            self.conn.prepare(&format!("SELECT kind, text FROM {table} WHERE {column} = ?1"))?;
        let rows: Vec<(String, String)> = stmt
            .query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        Ok((
            rows.iter().filter(|(k, _)| k == "strong").map(|(_, t)| t.clone()).collect(),
            rows.iter().filter(|(k, _)| k == "weak").map(|(_, t)| t.clone()).collect(),
        ))
    }

    /// The whole map: conversations, ideas, and what links them.
    ///
    /// Small enough to send in one go — a few thousand nodes is a few hundred
    /// kilobytes of JSON, and paging it would complicate the layout for no
    /// benefit at the scale a person's own thinking reaches.
    pub fn graph(&self, folder: Option<i64>) -> Result<Graph> {
        let mut g = Graph::default();

        // Fetched in two queries rather than per node, so a map with hundreds of
        // nodes is still two round trips to SQLite instead of hundreds.
        let session_nudges = self.grouped_nudges("session_nudges", "session_id")?;
        let idea_nudges = self.grouped_nudges("nudges", "idea_id")?;

        let mut sessions = self.conn.prepare(
            "SELECT s.id, s.started_at,
                    COALESCE((SELECT t.text FROM turns t
                              WHERE t.session_id = s.id AND t.role = 'user'
                              ORDER BY t.ord LIMIT 1), ''),
                    (SELECT COUNT(DISTINCT e.idea_id) FROM evidence e WHERE e.session_id = s.id),
                    s.title
             FROM sessions s
             WHERE s.archived = 0
               AND (?1 IS NULL OR s.folder_id = ?1)
               AND EXISTS (SELECT 1 FROM evidence e WHERE e.session_id = s.id)",
        )?;
        for row in sessions.query_map([folder], |r| {
            let id: i64 = r.get(0)?;
            let started: String = r.get(1)?;
            let opening: String = r.get(2)?;
            let title: String = r.get(4)?;
            let (strong, weak) = session_nudges.get(&id).cloned().unwrap_or_default();
            Ok(GraphNode {
                id: format!("s{id}"),
                kind: "conversation",
                label: conversation_label(&title, &opening, &started),
                weight: r.get(3)?,
                session_id: Some(id),
                idea_id: None,
                category: String::new(),
                date: started.get(..10).unwrap_or(&started).to_string(),
                just_revised: false,
                shared: false,
                strong,
                weak,
            })
        })? {
            g.nodes.push(row?);
        }

        let mut ideas = self.conn.prepare(
            "SELECT i.id, i.claim,
                    (SELECT COUNT(DISTINCT e.session_id) FROM evidence e WHERE e.idea_id = i.id),
                    i.category,
                    (i.revision > 0 AND i.updated_at > datetime('now', '-10 minutes')),
                    i.title
             FROM ideas i
             WHERE EXISTS (
               SELECT 1 FROM evidence e JOIN sessions s ON s.id = e.session_id
               WHERE e.idea_id = i.id AND s.archived = 0
                 AND (?1 IS NULL OR s.folder_id = ?1)
             )",
        )?;
        for row in ideas.query_map([folder], |r| {
            let id: i64 = r.get(0)?;
            let claim: String = r.get(1)?;
            let sessions: i64 = r.get(2)?;
            let title: String = r.get(5)?;
            let (strong, weak) = idea_nudges.get(&id).cloned().unwrap_or_default();
            Ok(GraphNode {
                id: format!("i{id}"),
                kind: "idea",
                label: if title.is_empty() { claim } else { title },
                weight: sessions,
                session_id: None,
                idea_id: Some(id),
                category: r.get(3)?,
                date: String::new(),
                just_revised: r.get::<_, i64>(4)? != 0,
                shared: sessions > 1,
                strong,
                weak,
            })
        })? {
            g.nodes.push(row?);
        }

        // A conversation links to every idea it produced. An idea supported by
        // two conversations therefore joins them — which is the whole point of
        // the shape: shared ideas are the only thing connecting one stretch of
        // thinking to another.
        let mut from = self.conn.prepare("SELECT DISTINCT session_id, idea_id FROM evidence")?;
        for row in from.query_map([], |r| {
            let (s, i): (i64, i64) = (r.get(0)?, r.get(1)?);
            Ok(GraphEdge {
                source: format!("s{s}"),
                target: format!("i{i}"),
                kind: "from".into(),
                weight: 1.0,
                reasoning: None,
            })
        })? {
            g.edges.push(row?);
        }

        // Faint links between ideas judged related but not the same. Without
        // these a conservative merge threshold leaves the map with no structure
        // at all; with them it has structure without claiming false identity.
        let mut rel = self
            .conn
            .prepare("SELECT idea_a, idea_b, kind, confidence, reasoning FROM relations")?;
        for row in rel.query_map([], |r| {
            let (a, b): (i64, i64) = (r.get(0)?, r.get(1)?);
            Ok(GraphEdge {
                source: format!("i{a}"),
                target: format!("i{b}"),
                kind: r.get(2)?,
                weight: r.get(3)?,
                reasoning: r.get(4)?,
            })
        })? {
            g.edges.push(row?);
        }

        // Ideas sharing a category are chained together — idea 1 to idea 2,
        // idea 2 to idea 3, and so on — rather than fully connected pairwise.
        // Reconciliation's "related" edges require the model to judge two
        // claims as substantively connected, which is conservative by design
        // and often leaves a map with plenty of ideas but no lines between
        // most of them. A shared topic is a much weaker claim than "these two
        // thoughts are related", so it earns a fainter, cheaper line rather
        // than the one reconciliation draws.
        let mut cat_stmt = self
            .conn
            .prepare("SELECT id, category FROM ideas WHERE category <> '' ORDER BY category, id")?;
        let by_category: Vec<(i64, String)> = cat_stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut prev: Option<(i64, String)> = None;
        for (id, category) in by_category {
            if let Some((prev_id, prev_cat)) = &prev {
                if *prev_cat == category {
                    g.edges.push(GraphEdge {
                        source: format!("i{prev_id}"),
                        target: format!("i{id}"),
                        kind: "category".into(),
                        weight: 0.3,
                        reasoning: None,
                    });
                }
            }
            prev = Some((id, category));
        }

        Ok(g)
    }

    /// Record the ideas that could not be traced, and mark the session done.
    ///
    /// Split from `apply_decision` because reconciliation decides each idea
    /// individually, while rejections are a property of the session as a whole.
    pub fn save_rejections(&mut self, session_id: i64, extraction: &Extraction) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        let tx = self.conn.transaction()?;

        // Re-extraction of the same session should replace its notes, not
        // accumulate a second set.
        tx.execute("DELETE FROM session_nudges WHERE session_id = ?1", [session_id])?;
        for note in &extraction.conversation.notes {
            tx.execute(
                "INSERT INTO session_nudges (session_id, kind, text) VALUES (?1, ?2, ?3)",
                params![session_id, note.kind.column(), note.text],
            )?;
        }

        for r in &extraction.rejected {
            let reason = match r.reason {
                Rejection::NotFound => "not_found",
                Rejection::AttributedToAssistant => "attributed_to_assistant",
                Rejection::EmptyQuote => "empty_quote",
            };
            tx.execute(
                "INSERT INTO rejected_ideas (session_id, claim, quote, reason, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![session_id, r.raw.claim, r.raw.quote, reason, now],
            )?;
        }
        tx.execute(
            "UPDATE sessions SET extract_state = 'done', extract_error = NULL WHERE id = ?1",
            [session_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Answers in a session that have not been condensed yet.
    pub fn replies_needing_digest(&self, session_id: i64) -> Result<Vec<(i64, i64, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT t.id, t.ord, t.text FROM turns t
             WHERE t.session_id = ?1 AND t.role = 'assistant'
               AND NOT EXISTS (SELECT 1 FROM reply_digests d WHERE d.turn_id = t.id)
             ORDER BY t.ord",
        )?;
        let rows = stmt.query_map([session_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
    }

    pub fn set_reply_digest(&self, turn_id: i64, content: &str, model: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO reply_digests (turn_id, content, model, created_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(turn_id) DO UPDATE SET content = ?2, model = ?3, created_at = ?4",
            params![turn_id, content, model, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    /// The cached long-form argument about an idea, if one has been generated.
    pub fn deep_dive(&self, idea_id: i64) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT content FROM idea_deep_dives WHERE idea_id = ?1", [idea_id], |r| {
                r.get(0)
            })
            .optional()?)
    }

    pub fn set_deep_dive(&self, idea_id: i64, content: &str, model: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO idea_deep_dives (idea_id, content, model, created_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(idea_id) DO UPDATE SET content = ?2, model = ?3, created_at = ?4",
            params![idea_id, content, model, Utc::now().to_rfc3339()],
        )?;
        Ok(())
    }

    /// Everything needed to argue about one idea: the claim, its nudges, and the
    /// user's own words behind it.
    pub fn idea_context(&self, idea_id: i64) -> Result<IdeaForDeepDive> {
        let claim: String =
            self.conn
                .query_row("SELECT claim FROM ideas WHERE id = ?1", [idea_id], |r| r.get(0))?;
        let (strong, weak) = self.nudges_for("nudges", "idea_id", idea_id)?;
        let mut stmt = self
            .conn
            .prepare("SELECT quote FROM evidence WHERE idea_id = ?1 ORDER BY created_at")?;
        let quotes: Vec<String> =
            stmt.query_map([idea_id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        Ok((claim, strong, weak, quotes))
    }

    /// Categories already in use, most-used first.
    ///
    /// Offered to the model at extraction time so it reuses a subject it has met
    /// before rather than inventing a near-synonym.
    pub fn categories(&self) -> Result<Vec<String>> {
        self.categories_in(None)
    }

    /// The categories in one folder, or in all of them.
    ///
    /// Scoped, because this list is handed to the extractor as "reuse one of
    /// these exactly as written" — and a Polish conversation offered a list of
    /// English categories takes the invitation, files itself under "business
    /// planning", and the tags on that folder's map come out in a language
    /// nobody there is speaking. Folders already separate what belongs
    /// together; the vocabulary should follow them.
    pub fn categories_in(&self, folder: Option<i64>) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT i.category, COUNT(*) c FROM ideas i
             WHERE i.category <> ''
               AND (?1 IS NULL OR EXISTS (
                     SELECT 1 FROM evidence e JOIN sessions s ON s.id = e.session_id
                     WHERE e.idea_id = i.id AND s.folder_id = ?1))
             GROUP BY i.category ORDER BY c DESC, i.category
             LIMIT 40",
        )?;
        let rows = stmt.query_map([folder], |r| r.get(0))?;
        rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
    }

    /// Every idea with its stored vector, for shortlisting.
    ///
    /// Vectors from a different embedding model are skipped rather than
    /// compared — cosine between two models' spaces is meaningless, and would
    /// silently produce nonsense candidates.
    pub fn ideas_with_embeddings(&self) -> Result<Vec<(i64, String, Vec<f32>)>> {
        let mut stmt = self.conn.prepare(
            "SELECT i.id, i.claim, e.vec
             FROM ideas i JOIN embeddings e ON e.idea_id = i.id
             WHERE e.model = ?1",
        )?;
        let rows = stmt.query_map([embed::MODEL_ID], |r| {
            let blob: Vec<u8> = r.get(2)?;
            Ok((r.get(0)?, r.get(1)?, embed::unpack(&blob)))
        })?;
        rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
    }

    /// Ideas whose claim has no vector for the current embedding model.
    pub fn ideas_needing_embedding(&self) -> Result<Vec<(i64, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT i.id, i.claim FROM ideas i
             WHERE NOT EXISTS (
               SELECT 1 FROM embeddings e WHERE e.idea_id = i.id AND e.model = ?1
             )",
        )?;
        let rows = stmt.query_map([embed::MODEL_ID], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
    }

    pub fn set_embedding(&self, idea_id: i64, vec: &[f32]) -> Result<()> {
        self.conn.execute(
            "INSERT INTO embeddings (idea_id, dims, vec, model) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(idea_id) DO UPDATE SET dims = ?2, vec = ?3, model = ?4",
            params![idea_id, vec.len() as i64, embed::pack(vec), embed::MODEL_ID],
        )?;
        Ok(())
    }

    /// Apply one reconciliation decision, returning the idea it landed on.
    pub fn apply_decision(
        &mut self,
        session_id: i64,
        idea: &VerifiedIdea,
        decision: &Decision,
        provider: &str,
        model: &str,
    ) -> Result<i64> {
        let now = Utc::now().to_rfc3339();
        let tx = self.conn.transaction()?;

        let idea_id = match decision {
            Decision::New { .. } | Decision::Conflict { .. } => {
                tx.execute(
                    "INSERT INTO ideas (claim, title, category, revision, created_at, updated_at)
                     VALUES (?1, ?2, ?3, 0, ?4, ?4)",
                    params![
                        idea.raw.claim,
                        idea.raw.title,
                        normalize_category(&idea.raw.category),
                        now
                    ],
                )?;
                tx.last_insert_rowid()
            }
            Decision::Attach { idea_id, .. } => *idea_id,
            Decision::Rewrite { idea_id, new_claim, confidence } => {
                let prev: String =
                    tx.query_row("SELECT claim FROM ideas WHERE id = ?1", [idea_id], |r| r.get(0))?;
                tx.execute(
                    "UPDATE ideas SET claim = ?2, revision = revision + 1, updated_at = ?3
                     WHERE id = ?1",
                    params![idea_id, new_claim, now],
                )?;
                // A rewritten claim gets a fresh title too, when the model
                // extracting the new phrasing offered one.
                if !idea.raw.title.is_empty() {
                    tx.execute(
                        "UPDATE ideas SET title = ?2 WHERE id = ?1",
                        params![idea_id, idea.raw.title],
                    )?;
                }
                // History first, so a revert is always possible. A rewrite with
                // no recoverable previous claim would be destruction, not editing.
                tx.execute(
                    "INSERT INTO idea_revisions
                       (idea_id, prev_claim, new_claim, verdict, confidence, created_at)
                     VALUES (?1, ?2, ?3, 'refines', ?4, ?5)",
                    params![idea_id, prev, new_claim, confidence, now],
                )?;
                *idea_id
            }
        };

        tx.execute(
            "INSERT INTO evidence
               (idea_id, session_id, turn_id, quote, start_byte, end_byte,
                ambiguous, normalized, reasoning, provider, model, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                idea_id,
                session_id,
                idea.located.turn_id,
                idea.located.matched_text,
                idea.located.start_byte as i64,
                idea.located.end_byte as i64,
                idea.located.ambiguous as i64,
                idea.located.normalized_match as i64,
                idea.raw.reasoning,
                provider,
                model,
                now,
            ],
        )?;

        // Nudges belong to the new phrasing; only add them for a fresh bubble.
        if matches!(decision, Decision::New { .. } | Decision::Conflict { .. }) {
            for note in &idea.raw.notes {
                tx.execute(
                    "INSERT INTO nudges (idea_id, kind, text) VALUES (?1, ?2, ?3)",
                    params![idea_id, note.kind.column(), note.text],
                )?;
            }
        }

        match decision {
            Decision::New { related } => {
                for (other, sim, why) in related {
                    relate(&tx, idea_id, *other, "related", *sim, why.as_deref(), &now)?;
                }
            }
            Decision::Conflict { idea_id: other, confidence, reason } => {
                relate(&tx, idea_id, *other, "contradicts", *confidence, reason.as_deref(), &now)?;
            }
            _ => {}
        }

        tx.commit()?;
        Ok(idea_id)
    }

    /// Undo a rewrite, restoring the previous claim.
    pub fn revert_revision(&mut self, revision_id: i64) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        let tx = self.conn.transaction()?;
        let (idea_id, prev): (i64, String) = tx.query_row(
            "SELECT idea_id, prev_claim FROM idea_revisions
             WHERE id = ?1 AND reverted_at IS NULL",
            [revision_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        tx.execute(
            "UPDATE ideas SET claim = ?2, updated_at = ?3 WHERE id = ?1",
            params![idea_id, prev, now],
        )?;
        tx.execute(
            "UPDATE idea_revisions SET reverted_at = ?2 WHERE id = ?1",
            params![revision_id, now],
        )?;
        // The vector described the claim that has just been undone.
        tx.execute("DELETE FROM embeddings WHERE idea_id = ?1", [idea_id])?;
        tx.commit()?;
        Ok(())
    }

    /// Undo one session's extraction, so it can be run again.
    ///
    /// Needed whenever the extraction prompt changes — which it will, since
    /// prompt quality *is* product quality here — and to recover from a bad run.
    ///
    /// **Destructive, and deliberately narrow.** It removes only what this
    /// session contributed: its evidence, its notes, its rejections. An idea
    /// that other conversations also support survives, minus this session's
    /// quote. Only ideas left with no evidence at all are removed, because an
    /// idea with nothing behind it is exactly what the provenance rule forbids.
    ///
    /// Returns (evidence removed, ideas orphaned).
    pub fn clear_extraction(&mut self, session_id: i64) -> Result<(usize, usize)> {
        let tx = self.conn.transaction()?;

        let evidence = tx.execute("DELETE FROM evidence WHERE session_id = ?1", [session_id])?;
        tx.execute("DELETE FROM session_nudges WHERE session_id = ?1", [session_id])?;
        tx.execute("DELETE FROM rejected_ideas WHERE session_id = ?1", [session_id])?;

        // Cascades take the nudges, embeddings, positions and relations with them.
        let orphans = tx.execute(
            "DELETE FROM ideas WHERE NOT EXISTS (
               SELECT 1 FROM evidence e WHERE e.idea_id = ideas.id
             )",
            [],
        )?;

        tx.execute(
            "UPDATE sessions SET extract_state = 'pending', extract_error = NULL WHERE id = ?1",
            [session_id],
        )?;
        tx.commit()?;
        Ok((evidence, orphans))
    }

    /// Delete a conversation and everything derived from it.
    ///
    /// Someone's own thinking is theirs to remove. Ideas supported only by this
    /// conversation go with it; ideas other conversations also support stay.
    pub fn delete_session(&mut self, session_id: i64) -> Result<()> {
        let md_path: Option<String> = self
            .conn
            .query_row("SELECT md_path FROM sessions WHERE id = ?1", [session_id], |r| r.get(0))
            .optional()?
            .flatten();

        let tx = self.conn.transaction()?;
        // Turns, evidence, and notes go by cascade.
        tx.execute("DELETE FROM sessions WHERE id = ?1", [session_id])?;
        tx.execute(
            "DELETE FROM ideas WHERE NOT EXISTS (
               SELECT 1 FROM evidence e WHERE e.idea_id = ideas.id
             )",
            [],
        )?;
        tx.commit()?;

        // The markdown copy is the user's own file. Removed only after the
        // database change committed, so a failure here cannot orphan the row.
        if let Some(path) = md_path {
            std::fs::remove_file(path).ok();
        }
        Ok(())
    }

    /// Delete one idea and its evidence, leaving the conversations untouched.
    pub fn delete_idea(&mut self, idea_id: i64) -> Result<()> {
        self.conn.execute("DELETE FROM ideas WHERE id = ?1", [idea_id])?;
        Ok(())
    }

    /// Set the AI-generated title, unless someone has already named this
    /// conversation by hand — a re-extraction must never quietly rename it back.
    pub fn set_session_title_ai(&mut self, session_id: i64, title: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE sessions SET title = ?2 WHERE id = ?1 AND title_locked = 0",
            params![session_id, title],
        )?;
        Ok(())
    }

    /// A person's own name for the conversation. Locked in, so it survives
    /// re-extraction.
    pub fn rename_session(&mut self, session_id: i64, title: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE sessions SET title = ?2, title_locked = 1 WHERE id = ?1",
            params![session_id, title.trim()],
        )?;
        Ok(())
    }

    /// Every folder, Root first, then by name.
    pub fn folders(&self) -> Result<Vec<Folder>> {
        let mut stmt = self.conn.prepare(
            "SELECT f.id, f.name,
                    (SELECT COUNT(*) FROM sessions s WHERE s.folder_id = f.id)
             FROM folders f
             ORDER BY (f.id <> 1), f.name",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Folder { id: r.get(0)?, name: r.get(1)?, session_count: r.get(2)? })
        })?;
        rows.collect::<rusqlite::Result<_>>().map_err(Into::into)
    }

    /// Make a folder, or return the one already using that name.
    pub fn create_folder(&mut self, name: &str) -> Result<i64> {
        let name = name.trim();
        if let Some(id) = self
            .conn
            .query_row("SELECT id FROM folders WHERE name = ?1", [name], |r| r.get::<_, i64>(0))
            .optional()?
        {
            return Ok(id);
        }
        self.conn.execute(
            "INSERT INTO folders (name, created_at) VALUES (?1, ?2)",
            params![name, Utc::now().to_rfc3339()],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn rename_folder(&mut self, folder_id: i64, name: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE folders SET name = ?2 WHERE id = ?1",
            params![folder_id, name.trim()],
        )?;
        Ok(())
    }

    /// Remove a folder, moving whatever was in it back to Root.
    ///
    /// Deleting the conversations too would make a tidy-up destructive, which
    /// is never what moving things between folders should mean.
    pub fn delete_folder(&mut self, folder_id: i64) -> Result<()> {
        if folder_id == ROOT_FOLDER {
            return Ok(());
        }
        let tx = self.conn.transaction()?;
        tx.execute(
            "UPDATE sessions SET folder_id = ?2 WHERE folder_id = ?1",
            params![folder_id, ROOT_FOLDER],
        )?;
        tx.execute("DELETE FROM folders WHERE id = ?1", [folder_id])?;
        tx.commit()?;
        Ok(())
    }

    /// Which folder a conversation is filed in.
    pub fn session_folder(&self, session_id: i64) -> Result<i64> {
        Ok(self.conn.query_row(
            "SELECT COALESCE(folder_id, 1) FROM sessions WHERE id = ?1",
            [session_id],
            |r| r.get(0),
        )?)
    }

    pub fn set_session_folder(&mut self, session_id: i64, folder_id: i64) -> Result<()> {
        self.conn.execute(
            "UPDATE sessions SET folder_id = ?2 WHERE id = ?1",
            params![session_id, folder_id],
        )?;
        Ok(())
    }

    pub fn set_session_archived(&mut self, session_id: i64, archived: bool) -> Result<()> {
        self.conn.execute(
            "UPDATE sessions SET archived = ?2 WHERE id = ?1",
            params![session_id, archived as i64],
        )?;
        Ok(())
    }

    /// Clear `extracting` marks left behind by a crash or a hard quit.
    ///
    /// Called at startup. Without it a session interrupted mid-extraction stays
    /// marked as in-progress forever, and the queue quietly skips it — the user
    /// loses that session's ideas with no error anywhere.
    pub fn reset_stale_extractions(&self) -> Result<usize> {
        Ok(self.conn.execute(
            "UPDATE sessions SET extract_state = 'pending'
             WHERE extract_state = 'extracting'",
            [],
        )?)
    }

    pub fn set_extract_state(
        &self,
        session_id: i64,
        state: &str,
        error: Option<&str>,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE sessions SET extract_state = ?2, extract_error = ?3 WHERE id = ?1",
            params![session_id, state, error],
        )?;
        Ok(())
    }
}

/// Trim a model-supplied category into something usable as a key.
///
/// Lowercased and squeezed so "Moral Philosophy" and "moral  philosophy" do not
/// become two colours on the map.
fn normalize_category(raw: &str) -> String {
    let cleaned: String =
        raw.trim().to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ");
    cleaned.chars().take(40).collect()
}

/// A conversation's name: what was said first.
///
/// The date used to lead, to keep this apart from an idea quoting the same
/// opening sentence — but it took over the label and pushed the words that
/// actually identify the conversation off the end. The date now lives in the
/// tooltip and in the weight of the node instead.
fn conversation_label(title: &str, opening: &str, started_at: &str) -> String {
    let title = title.trim();
    if !title.is_empty() {
        return title.to_string();
    }
    let trimmed = opening.trim();
    if trimmed.is_empty() {
        return started_at.get(..10).unwrap_or(started_at).to_string();
    }
    let mut words: String = trimmed.chars().take(64).collect();
    if trimmed.chars().count() > 64 {
        words.push('…');
    }
    words
}

fn relate(
    tx: &rusqlite::Transaction<'_>,
    a: i64,
    b: i64,
    kind: &str,
    confidence: f32,
    reasoning: Option<&str>,
    now: &str,
) -> Result<()> {
    if a == b {
        return Ok(());
    }
    // Stored with the lower id first so the pair is recorded once, not twice.
    let (lo, hi) = if a < b { (a, b) } else { (b, a) };
    tx.execute(
        "INSERT OR IGNORE INTO relations (idea_a, idea_b, kind, confidence, reasoning, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![lo, hi, kind, confidence, reasoning, now],
    )?;
    // A pair seen again with a reason this time keeps the reason. The insert
    // above is IGNORE, so without this the first sighting wins forever — and
    // the first sighting is usually the one from a bare similarity score.
    if reasoning.is_some() {
        tx.execute(
            "UPDATE relations SET reasoning = ?4
             WHERE idea_a = ?1 AND idea_b = ?2 AND kind = ?3 AND reasoning IS NULL",
            params![lo, hi, kind, reasoning],
        )?;
    }
    Ok(())
}

/// Write the human-readable copy.
///
/// Plain markdown in a folder the user picked, so their thinking is never
/// trapped in our database — readable by Obsidian, grep, or anything else, and
/// still there if this project is abandoned.
fn write_markdown(
    dir: &Path,
    rendered: &Rendered,
    model: &str,
    started_at: DateTime<Utc>,
    ended_at: DateTime<Utc>,
) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let stamp = started_at.format("%Y-%m-%d-%H%M%S");
    let path = dir.join(format!("{stamp}.md"));

    let body = format!(
        "---\nstarted: {}\nended: {}\nmodel: {}\n---\n\n{}\n",
        started_at.to_rfc3339(),
        ended_at.to_rfc3339(),
        model,
        rendered.text,
    );
    std::fs::write(&path, body)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::types::Message;
    use crate::session::transcript;

    fn convo() -> Vec<Message> {
        vec![
            Message { role: Role::User, content: "latency is the problem".into() },
            Message { role: Role::Assistant, content: "say more".into() },
            Message { role: Role::User, content: "caf\u{e9} \u{1F600} it compounds".into() },
        ]
    }

    #[test]
    fn archived_turns_index_the_stored_transcript() {
        let mut store = Store::open_in_memory().unwrap();
        let rendered = transcript::render(&convo());
        let id = store.archive_session(&rendered, "test-model", Utc::now(), None).unwrap();

        let stored = store.transcript(id).unwrap().unwrap();
        assert_eq!(stored, rendered.text);

        // The guarantee that matters: every stored offset still selects the
        // stored turn text, after a full round trip through the database.
        for turn in store.turns(id).unwrap() {
            let (s, e) = (turn.start_byte as usize, turn.end_byte as usize);
            assert_eq!(&stored[s..e], turn.text, "turn {} offsets drifted", turn.ord);
        }
    }

    #[test]
    fn markdown_copy_contains_the_transcript() {
        let dir = std::env::temp_dir().join(format!("aigraph-test-{}", std::process::id()));
        let mut store = Store::open_in_memory().unwrap();
        let rendered = transcript::render(&convo());
        let id = store.archive_session(&rendered, "m", Utc::now(), Some(&dir)).unwrap();

        let summary = &store.list_sessions(10, None).unwrap()[0];
        assert_eq!(summary.id, id);
        let path = summary.md_path.clone().expect("markdown path recorded");
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.contains("latency is the problem"));
        assert!(body.contains("model: m"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn summary_shows_the_opening_user_line() {
        let mut store = Store::open_in_memory().unwrap();
        store.archive_session(&transcript::render(&convo()), "m", Utc::now(), None).unwrap();
        let s = &store.list_sessions(10, None).unwrap()[0];
        assert_eq!(s.opening, "latency is the problem");
        assert_eq!(s.turn_count, 3);
        assert_eq!(s.extract_state, "pending");
    }

    #[test]
    fn extraction_queue_tracks_state() {
        let mut store = Store::open_in_memory().unwrap();
        let id =
            store.archive_session(&transcript::render(&convo()), "m", Utc::now(), None).unwrap();
        assert_eq!(store.pending_extraction().unwrap(), vec![id]);

        store.set_extract_state(id, "done", None).unwrap();
        assert!(store.pending_extraction().unwrap().is_empty());
    }

    /// The full chain: extract → verify → store → read back → highlight.
    ///
    /// Deliberately stuffed with emoji and accents *before* the quote, so any
    /// byte/char confusion anywhere in the chain shifts the highlight and fails
    /// here rather than in front of a user.
    #[test]
    fn source_view_highlights_the_real_words_through_multibyte_text() {
        use crate::extract::verify::{self, Turn};
        use crate::extract::{Extraction, VerifiedIdea};
        use crate::llm::types::RawIdea;

        let messages = vec![
            Message {
                role: Role::User,
                content: "caf\u{e9} \u{1F600} \u{1F680} na\u{ef}ve — latency is the real problem"
                    .into(),
            },
            Message { role: Role::Assistant, content: "\u{1F914} say more".into() },
            Message { role: Role::User, content: "\u{e9}verything compounds".into() },
        ];

        let mut store = Store::open_in_memory().unwrap();
        let rendered = transcript::render(&messages);
        let session_id = store.archive_session(&rendered, "m", Utc::now(), None).unwrap();

        let turns: Vec<Turn> = store.verify_turns(session_id).unwrap();
        let raw = RawIdea {
            claim: "Latency is the real problem".into(),
            title: String::new(),
            quote: "latency is the real problem".into(),
            reasoning: String::new(),
            category: String::new(),
            notes: vec![],
        };
        let located = verify::verify(&raw, &turns).expect("quote should verify");

        let extraction = Extraction {
            ideas: vec![VerifiedIdea { raw, located }],
            rejected: vec![],
            retried: false,
            conversation: Default::default(),
            title: String::new(),
        };
        store.save_extraction(session_id, &extraction, "test", "m").unwrap();

        let idea = &store.ideas(None).unwrap()[0];
        let view = store.source_view(idea.evidence[0].id).unwrap();

        assert_eq!(view.highlight, "latency is the real problem");
        // And it must sit in the right place, not merely contain the right text.
        assert_eq!(
            format!("{}{}{}", view.before, view.highlight, view.after),
            store.transcript(session_id).unwrap().unwrap()
        );
        assert!(view.before.contains("caf\u{e9}"));
        assert!(view.after.contains("compounds"));
    }

    #[test]
    fn source_view_refuses_to_highlight_drifted_offsets() {
        use crate::extract::verify::{self, Turn};
        use crate::extract::{Extraction, VerifiedIdea};
        use crate::llm::types::RawIdea;

        let mut store = Store::open_in_memory().unwrap();
        let rendered = transcript::render(&[Message {
            role: Role::User,
            content: "latency is the real problem".into(),
        }]);
        let session_id = store.archive_session(&rendered, "m", Utc::now(), None).unwrap();
        let turns: Vec<Turn> = store.verify_turns(session_id).unwrap();
        let raw = RawIdea {
            claim: "c".into(),
            title: String::new(),
            quote: "latency".into(),
            reasoning: String::new(),
            category: String::new(),
            notes: vec![],
        };
        let located = verify::verify(&raw, &turns).unwrap();
        store
            .save_extraction(
                session_id,
                &Extraction {
                    ideas: vec![VerifiedIdea { raw, located }],
                    rejected: vec![],
                    retried: false,
                    conversation: Default::default(),
                    title: String::new(),
                },
                "t",
                "m",
            )
            .unwrap();

        // Corrupt the stored offsets, as a bad migration might.
        store.conn.execute("UPDATE evidence SET start_byte = start_byte + 3", []).unwrap();

        let id = store.ideas(None).unwrap()[0].evidence[0].id;
        assert!(
            matches!(store.source_view(id), Err(StoreError::Provenance { .. })),
            "a drifted highlight must error, never render"
        );
    }

    fn verified(claim: &str, quote: &str, turns: &[crate::extract::verify::Turn]) -> VerifiedIdea {
        use crate::llm::types::RawIdea;
        let raw = RawIdea {
            claim: claim.into(),
            title: String::new(),
            quote: quote.into(),
            reasoning: "because they said so".into(),
            category: "testing".into(),
            notes: vec![crate::llm::types::Note {
                text: "s".into(),
                kind: crate::llm::types::NoteKind::Supports,
            }],
        };
        let located = crate::extract::verify::verify(&raw, turns).expect("verify");
        VerifiedIdea { raw, located }
    }

    fn session_with(store: &mut Store, text: &str) -> (i64, Vec<crate::extract::verify::Turn>) {
        let rendered = transcript::render(&[Message { role: Role::User, content: text.into() }]);
        let id = store.archive_session(&rendered, "m", Utc::now(), None).unwrap();
        let turns = store.verify_turns(id).unwrap();
        (id, turns)
    }

    /// The plan's worked example, end to end through the database.
    #[test]
    fn a_refinement_rewrites_the_bubble_and_keeps_both_quotes() {
        let mut store = Store::open_in_memory().unwrap();

        let (s1, t1) = session_with(&mut store, "Trump is a bad man");
        let first = verified("Trump is a bad man", "Trump is a bad man", &t1);
        let idea_id =
            store.apply_decision(s1, &first, &Decision::New { related: vec![] }, "t", "m").unwrap();

        let (s2, t2) =
            session_with(&mut store, "he acts like a bad person in certain circumstances");
        let second = verified(
            "He acts badly in certain circumstances",
            "he acts like a bad person in certain circumstances",
            &t2,
        );
        let same = store
            .apply_decision(
                s2,
                &second,
                &Decision::Rewrite {
                    idea_id,
                    new_claim: "He acts badly in certain circumstances".into(),
                    confidence: 0.9,
                },
                "t",
                "m",
            )
            .unwrap();

        assert_eq!(same, idea_id, "a refinement must not create a second bubble");

        let ideas = store.ideas(None).unwrap();
        assert_eq!(ideas.len(), 1, "one idea, not two");
        assert_eq!(ideas[0].claim, "He acts badly in certain circumstances");
        assert_eq!(ideas[0].evidence.len(), 2, "both moments support it");
        assert_eq!(ideas[0].evidence[0].session_id, s1, "the original quote survives the rewrite");
    }

    #[test]
    fn a_rewrite_can_always_be_undone() {
        let mut store = Store::open_in_memory().unwrap();
        let (s1, t1) = session_with(&mut store, "Trump is a bad man");
        let first = verified("Trump is a bad man", "Trump is a bad man", &t1);
        let idea_id =
            store.apply_decision(s1, &first, &Decision::New { related: vec![] }, "t", "m").unwrap();

        let (s2, t2) = session_with(&mut store, "he acts like a bad person sometimes");
        let second = verified("Nuanced", "he acts like a bad person sometimes", &t2);
        store
            .apply_decision(
                s2,
                &second,
                &Decision::Rewrite { idea_id, new_claim: "Nuanced".into(), confidence: 0.9 },
                "t",
                "m",
            )
            .unwrap();

        let revision: i64 = store
            .conn
            .query_row("SELECT id FROM idea_revisions WHERE idea_id = ?1", [idea_id], |r| r.get(0))
            .unwrap();
        store.revert_revision(revision).unwrap();

        assert_eq!(store.ideas(None).unwrap()[0].claim, "Trump is a bad man");
        // Reverting twice must not silently re-apply anything.
        assert!(store.revert_revision(revision).is_err());
    }

    #[test]
    fn attaching_adds_evidence_without_duplicating_nudges() {
        let mut store = Store::open_in_memory().unwrap();
        let (s1, t1) = session_with(&mut store, "latency is the problem");
        let first = verified("Latency is the problem", "latency is the problem", &t1);
        let idea_id =
            store.apply_decision(s1, &first, &Decision::New { related: vec![] }, "t", "m").unwrap();

        let (s2, t2) = session_with(&mut store, "latency is the problem");
        let again = verified("Latency is the problem", "latency is the problem", &t2);
        store
            .apply_decision(s2, &again, &Decision::Attach { idea_id, confidence: 0.9 }, "t", "m")
            .unwrap();

        let ideas = store.ideas(None).unwrap();
        assert_eq!(ideas.len(), 1);
        assert_eq!(ideas[0].evidence.len(), 2);
        assert_eq!(ideas[0].strong.len(), 1, "notes belong to the bubble, not each quote");
    }

    #[test]
    fn embeddings_from_another_model_are_not_offered_for_comparison() {
        let mut store = Store::open_in_memory().unwrap();
        let (s1, t1) = session_with(&mut store, "latency is the problem");
        let idea = verified("Latency", "latency is the problem", &t1);
        let id =
            store.apply_decision(s1, &idea, &Decision::New { related: vec![] }, "t", "m").unwrap();

        store.set_embedding(id, &[0.1; 384]).unwrap();
        assert_eq!(store.ideas_with_embeddings().unwrap().len(), 1);
        assert!(store.ideas_needing_embedding().unwrap().is_empty());

        store.conn.execute("UPDATE embeddings SET model = 'some-other-model'", []).unwrap();
        assert!(
            store.ideas_with_embeddings().unwrap().is_empty(),
            "cosine across two models' spaces is meaningless"
        );
        assert_eq!(store.ideas_needing_embedding().unwrap().len(), 1, "so it is re-embedded");
    }

    #[test]
    fn a_shared_idea_joins_two_conversations() {
        let mut store = Store::open_in_memory().unwrap();

        let (s1, t1) = session_with(&mut store, "latency is the problem");
        let a = verified("Latency is the problem", "latency is the problem", &t1);
        let idea_id =
            store.apply_decision(s1, &a, &Decision::New { related: vec![] }, "t", "m").unwrap();

        let (s2, t2) = session_with(&mut store, "latency is the problem");
        let b = verified("Latency is the problem", "latency is the problem", &t2);
        store
            .apply_decision(s2, &b, &Decision::Attach { idea_id, confidence: 0.9 }, "t", "m")
            .unwrap();

        let g = store.graph(None).unwrap();

        let idea = g.nodes.iter().find(|n| n.idea_id == Some(idea_id)).unwrap();
        assert!(idea.shared, "an idea in two conversations is shared");
        assert_eq!(idea.weight, 2);

        // The structural claim: both conversations reach the same idea node, so
        // the map is connected rather than two separate stars.
        let to_idea: Vec<_> = g
            .edges
            .iter()
            .filter(|e| e.target == format!("i{idea_id}") && e.kind == "from")
            .map(|e| e.source.clone())
            .collect();
        assert_eq!(to_idea.len(), 2);
        assert!(to_idea.contains(&format!("s{s1}")));
        assert!(to_idea.contains(&format!("s{s2}")));
    }

    #[test]
    fn a_conversation_with_no_ideas_is_not_drawn() {
        // An empty star would be noise: nothing came out of it, so it says
        // nothing about the person's thinking.
        let mut store = Store::open_in_memory().unwrap();
        session_with(&mut store, "just saying hello");
        assert!(store.graph(None).unwrap().nodes.is_empty());
    }

    #[test]
    fn related_ideas_are_linked_without_being_merged() {
        let mut store = Store::open_in_memory().unwrap();
        let (s1, t1) = session_with(&mut store, "latency is the problem");
        let first = verified("Latency is the problem", "latency is the problem", &t1);
        let a =
            store.apply_decision(s1, &first, &Decision::New { related: vec![] }, "t", "m").unwrap();

        let (s2, t2) = session_with(&mut store, "speed matters most of all");
        let second = verified("Speed matters most", "speed matters most of all", &t2);
        let b = store
            .apply_decision(
                s2,
                &second,
                &Decision::New {
                    related: vec![(
                        a,
                        0.7,
                        Some("both treat latency as the binding constraint".into()),
                    )],
                },
                "t",
                "m",
            )
            .unwrap();

        assert_ne!(a, b, "related is not the same as merged");
        let g = store.graph(None).unwrap();
        assert_eq!(
            g.edges.iter().filter(|e| e.kind == "related").count(),
            1,
            "one faint link between two distinct ideas"
        );
    }

    #[test]
    fn conversations_are_labelled_by_their_opening_words() {
        assert_eq!(
            conversation_label("", "Trump is a bad man", "2026-08-22T10:00:00Z"),
            "Trump is a bad man",
            "the words identify the conversation; the date is shown elsewhere"
        );
        assert_eq!(conversation_label("", "   ", "2026-08-22T10:00:00Z"), "2026-08-22");
        let long = "x".repeat(100);
        assert!(
            conversation_label("", &long, "2026-08-22").ends_with('…'),
            "long openings are truncated"
        );
    }

    #[test]
    fn a_folder_hides_everything_outside_it() {
        let mut store = Store::open_in_memory().unwrap();
        let (kept, turns_a) = session_with(&mut store, "latency is the real problem");
        let (other, turns_b) = session_with(&mut store, "the garden needs weeding");

        store
            .apply_decision(
                kept,
                &verified("Latency is the problem", "latency is the real problem", &turns_a),
                &Decision::New { related: vec![] },
                "t",
                "m",
            )
            .unwrap();
        store
            .apply_decision(
                other,
                &verified("The garden needs weeding", "the garden needs weeding", &turns_b),
                &Decision::New { related: vec![] },
                "t",
                "m",
            )
            .unwrap();

        let work = store.create_folder("Work").unwrap();
        store.set_session_folder(kept, work).unwrap();

        // Unscoped sees both; scoped to Work sees only what was said there.
        assert_eq!(store.ideas(None).unwrap().len(), 2);
        assert_eq!(store.list_sessions(10, None).unwrap().len(), 2);

        let scoped = store.ideas(Some(work)).unwrap();
        assert_eq!(scoped.len(), 1, "a folder must hide ideas from outside it");
        assert!(scoped[0].claim.contains("Latency"));
        assert_eq!(store.list_sessions(10, Some(work)).unwrap().len(), 1);

        // And the map, or the folders are labels rather than separations.
        let g = store.graph(Some(work)).unwrap();
        assert_eq!(g.nodes.iter().filter(|n| n.kind == "conversation").count(), 1);
        assert_eq!(g.nodes.iter().filter(|n| n.kind == "idea").count(), 1);
    }

    #[test]
    fn a_short_ai_title_wins_over_the_opening_words() {
        assert_eq!(
            conversation_label(
                "American Economic Empire",
                "so today I wanted to talk about",
                "2026-08-22"
            ),
            "American Economic Empire"
        );
    }

    #[test]
    fn deleting_a_session_takes_its_turns_with_it() {
        let mut store = Store::open_in_memory().unwrap();
        let id =
            store.archive_session(&transcript::render(&convo()), "m", Utc::now(), None).unwrap();
        store.conn.execute("DELETE FROM sessions WHERE id = ?1", [id]).unwrap();
        assert!(store.turns(id).unwrap().is_empty(), "cascade did not fire");
    }
}
