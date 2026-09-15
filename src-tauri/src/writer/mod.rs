//! The book writer (beta): a folder's ideas written up as a book, in the
//! person's own voice, one chapter at a time.
//!
//! One reply cannot hold a book — output limits end it a few thousand words
//! in — so it is written the way a person writes one: an outline first, agreed
//! before anything else, then a chapter at a time. Each chapter call carries
//! what it needs to sound like the same book: the whole outline, a short
//! summary of every chapter already written (much cheaper than their text, and
//! what actually carries the thread), the ideas and quotes recall finds for
//! this chapter, what earlier chapters have already used, and samples of how
//! the person talks.
//!
//! Everything here is pure — prompts, schemas, the file the project lives in.
//! The model calls are in `commands`, where the models are.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::store::{BookRow, Recorded};

/// A book in progress. Saved whole after every change.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Project {
    pub title: String,
    /// What the person wants the book to be, in their words.
    pub brief: String,
    /// The language the outline came back in; chapters are written in it.
    pub language: String,
    pub chapters: Vec<Chapter>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Chapter {
    pub title: String,
    /// What the chapter argues — the outline's line for it, editable.
    pub plan: String,
    /// Ideas the outline gave it.
    pub ideas: Vec<i64>,
    /// The chapter, as markdown. Empty until written.
    pub text: String,
    /// Written after the chapter; what later chapters are given of it.
    pub summary: String,
    /// Ideas it actually made use of, so later chapters refer back rather
    /// than argue them again.
    pub used: Vec<i64>,
}

/// Something the final check found.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Note {
    pub chapter: usize,
    pub note: String,
}

/// Where a folder's book is kept: one JSON file per folder, beside the
/// database. A file rather than tables because it is a draft edited as one
/// document, and a beta that may still change shape should not need a
/// migration to do it.
pub fn path_for(data_dir: &Path, folder: Option<i64>) -> PathBuf {
    let name = match folder {
        Some(id) => format!("folder-{id}.json"),
        None => "all.json".to_string(),
    };
    data_dir.join("books").join(name)
}

/// The saved project, or an empty one. A file that will not parse is treated
/// as no book rather than an error: it is a draft, and the screen has to open.
pub fn load(path: &Path) -> Project {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Written to a temporary file and moved into place, so a crash mid-write
/// leaves the previous draft rather than half of this one.
pub fn save(path: &Path, project: &Project) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(project).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// One idea with the words it came from.
#[derive(Debug, Clone, PartialEq)]
pub struct Material {
    pub id: i64,
    pub title: String,
    pub claim: String,
    pub category: String,
    pub quotes: Vec<String>,
}

/// Enough of what was said to write from, without one much-quoted idea
/// taking the whole context.
const QUOTES_PER_IDEA: usize = 3;

/// The folder's ideas, one each, with up to a few of their quotes.
pub fn gather(rows: Vec<BookRow>) -> Vec<Material> {
    let mut out: Vec<Material> = Vec::new();
    let mut at: HashMap<i64, usize> = HashMap::new();
    for r in rows {
        let quote = r.quote.trim().to_string();
        match at.get(&r.idea_id) {
            Some(&i) => {
                let m = &mut out[i];
                if !quote.is_empty()
                    && m.quotes.len() < QUOTES_PER_IDEA
                    && !m.quotes.contains(&quote)
                {
                    m.quotes.push(quote);
                }
            }
            None => {
                at.insert(r.idea_id, out.len());
                out.push(Material {
                    id: r.idea_id,
                    title: r.title,
                    claim: r.claim,
                    category: r.category,
                    quotes: if quote.is_empty() { vec![] } else { vec![quote] },
                });
            }
        }
    }
    out
}

/// Stretches of the person talking, to write like.
///
/// Their own turns only — the assistant's replies are exactly the voice to
/// stay away from — and middling ones: a one-word "yes" says nothing about a
/// voice, and one long paste may not be theirs at all. Spread across the
/// folder rather than the first conversation's worth.
pub fn voice_samples(recorded: &[Recorded], budget: usize) -> Vec<String> {
    let candidates: Vec<&str> = recorded
        .iter()
        .flat_map(|r| r.turns.iter())
        .filter(|(role, _)| role == "user")
        .map(|(_, text)| text.trim())
        .filter(|t| (120..=1200).contains(&t.chars().count()))
        .collect();
    let step = (candidates.len() / 12).max(1);
    let mut out = Vec::new();
    let mut used = 0;
    for t in candidates.into_iter().step_by(step) {
        if used + t.len() > budget {
            break;
        }
        used += t.len();
        out.push(t.to_string());
    }
    out
}

/// Parse a model's JSON reply, forgiving the fences and preamble a model not
/// held to a schema likes to add around it.
pub fn parse_json<T: serde::de::DeserializeOwned>(raw: &str) -> Result<T, String> {
    let raw = raw.trim();
    if let Ok(v) = serde_json::from_str(raw) {
        return Ok(v);
    }
    match (raw.find('{'), raw.rfind('}')) {
        (Some(a), Some(b)) if b > a => serde_json::from_str(&raw[a..=b]).map_err(|e| e.to_string()),
        _ => Err("no JSON object in the reply".into()),
    }
}

fn idea_line(m: &Material) -> String {
    let cat = if m.category.is_empty() { String::new() } else { format!(" ({})", m.category) };
    format!("[{}]{cat} {} — {}", m.id, m.title, m.claim)
}

fn with_quotes(m: &Material) -> String {
    let mut s = idea_line(m);
    for q in &m.quotes {
        s.push_str(&format!("\n    said: \"{}\"", q.replace('\n', " ")));
    }
    s
}

fn style() -> String {
    format!("{}{}", crate::extract::style::RULES, crate::settings::language_instruction())
}

// ------------------------------------------------------------------ outline

pub fn outline_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        // `language` first: see `extract::prompt` — a model that names the
        // language before writing keeps to it.
        "required": ["language", "title", "chapters"],
        "properties": {
            "language": { "type": "string" },
            "title": { "type": "string" },
            "chapters": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["title", "plan", "ideas"],
                    "properties": {
                        "title": { "type": "string" },
                        "plan": { "type": "string" },
                        "ideas": { "type": "array", "items": { "type": "integer" } }
                    }
                }
            }
        }
    })
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct OutlineReply {
    pub language: String,
    pub title: String,
    pub chapters: Vec<OutlineChapter>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct OutlineChapter {
    pub title: String,
    pub plan: String,
    pub ideas: Vec<i64>,
}

pub fn outline_prompt(folder: &str, brief: &str, chapters: usize, material: &[Material]) -> String {
    let ideas = material.iter().map(idea_line).collect::<Vec<_>>().join("\n");
    let brief = if brief.trim().is_empty() {
        "(none given — find the book the ideas themselves add up to)".to_string()
    } else {
        brief.trim().to_string()
    };
    format!(
        r#"One person's recorded thinking, from a folder called "{folder}", is to be
written up as a book in their own voice. Below is every idea in it: an id in
brackets, the subject it was filed under, a short title, and the position.

What they want the book to be:
{brief}

Plan the book. About {chapters} chapters, in the order a reader should meet
them — each one building on what came before, not a list of subjects in
alphabetical order.

For each chapter give:
- "title": a real chapter title, not a label ("Why teaching doesn't scale",
  not "Teaching").
- "plan": two or three sentences on what the chapter argues and how it moves —
  the point it makes, not the topic it covers.
- "ideas": the ids of the ideas it draws on. Every idea should land in the
  chapter it fits best; an idea may appear in two only where both genuinely
  need it. Leave out ideas that do not belong in this book at all.

Also give "title", a title for the whole book.

Do not invent positions: plans must be traceable to the ideas below.

{style}

First return "language": the language the ideas are written in, named in
English. Write the titles and plans in that language.

--- THE IDEAS ---
{ideas}
--- END ---"#,
        style = style(),
    )
}

/// Put a returned outline into the project.
///
/// Ids the model made up are dropped. A chapter whose title is unchanged keeps
/// what was already written for it, so redrafting the outline around a
/// finished chapter does not throw the chapter away.
pub fn apply_outline(
    old: Project,
    brief: &str,
    reply: OutlineReply,
    material: &[Material],
) -> Project {
    let known: std::collections::HashSet<i64> = material.iter().map(|m| m.id).collect();
    let chapters = reply
        .chapters
        .into_iter()
        .filter(|c| !c.title.trim().is_empty())
        .map(|c| {
            let title = c.title.trim().to_string();
            let mut ideas: Vec<i64> = Vec::new();
            for id in c.ideas {
                if known.contains(&id) && !ideas.contains(&id) {
                    ideas.push(id);
                }
            }
            let kept = old.chapters.iter().find(|o| o.title == title && !o.text.is_empty());
            Chapter {
                title,
                plan: c.plan.trim().to_string(),
                ideas,
                text: kept.map(|k| k.text.clone()).unwrap_or_default(),
                summary: kept.map(|k| k.summary.clone()).unwrap_or_default(),
                used: kept.map(|k| k.used.clone()).unwrap_or_default(),
            }
        })
        .collect();
    Project {
        title: if reply.title.trim().is_empty() {
            old.title
        } else {
            reply.title.trim().to_string()
        },
        brief: brief.trim().to_string(),
        language: reply.language,
        chapters,
    }
}

// ------------------------------------------------------------------ chapters

/// Who is writing, and how they sound. The system prompt, the same for every
/// chapter, so the voice does not drift from one to the next.
pub fn chapter_system(voice: &[String]) -> String {
    let samples = if voice.is_empty() {
        "(no samples — write plainly, in the first person, as someone thinking aloud \
         on the page)"
            .to_string()
    } else {
        voice
            .iter()
            .map(|v| format!("> {}", v.replace('\n', "\n> ")))
            .collect::<Vec<_>>()
            .join("\n\n")
    };
    format!(
        r#"You are writing one chapter of a book for a person, out of their own
recorded thinking. Write as them — first person, their words, their rhythm.
It must read like they wrote it, not like an assistant summarising them.

How they actually talk — match this voice: its sentence length, its
directness, the words they reach for, how they build an argument. Do not
copy these passages; write the way the person who said them writes.

{samples}

Rules:
- Their positions only. Every claim must come from the material you are
  given; do not add arguments, facts or examples they never made. Where the
  material is thin, the chapter is short — never padded.
- Their own words are the strongest material. Work their quotes into the
  prose where they fit, as their own sentences, not as quotations of
  somebody else.
- No filler: no "in this chapter", no "as we have seen", no closing summary
  of what the chapter just said, no motivational ending.
- Markdown. The chapter's title as `## Title` on the first line, then prose.
  `###` subheadings only if the chapter is long enough to need them.

{style}"#,
        style = style(),
    )
}

/// What this one chapter is given: the book around it, and its material.
pub fn chapter_prompt(
    project: &Project,
    index: usize,
    material: &[&Material],
    used_before: &[&Material],
) -> String {
    let ch = &project.chapters[index];
    let outline = project
        .chapters
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let mark = if i == index { "  ← this chapter" } else { "" };
            format!("{}. {}{mark}\n   {}", i + 1, c.title, c.plan)
        })
        .collect::<Vec<_>>()
        .join("\n");
    let earlier = project.chapters[..index]
        .iter()
        .enumerate()
        .filter(|(_, c)| !c.summary.is_empty())
        .map(|(i, c)| format!("{}. {} — {}", i + 1, c.title, c.summary))
        .collect::<Vec<_>>();
    let earlier = if earlier.is_empty() {
        "(this is the first chapter written)".to_string()
    } else {
        earlier.join("\n")
    };
    let covered = if used_before.is_empty() {
        "(none yet)".to_string()
    } else {
        used_before.iter().map(|m| format!("- {}", m.title)).collect::<Vec<_>>().join("\n")
    };
    let material = if material.is_empty() {
        "(nothing specific was found — write only what the plan and the earlier \
         chapters support, and keep it short)"
            .to_string()
    } else {
        material.iter().map(|m| with_quotes(m)).collect::<Vec<_>>().join("\n")
    };
    let brief = if project.brief.trim().is_empty() { "(none)" } else { project.brief.trim() };
    format!(
        r#"The book: "{title}"
What it is meant to be: {brief}

The whole outline:
{outline}

What the chapters before this one said:
{earlier}

Ideas earlier chapters already made — refer back to them where this chapter
builds on them ("as I said about …"), but do not argue them again:
{covered}

Write chapter {n}: "{ch_title}".
Its plan: {plan}

The material for it — ideas with their ids, and what was actually said:
{material}

Aim for 1,200–2,500 words, fewer if the material is thin. Write only this
chapter; the next one is written separately. Do not mention ids."#,
        title = project.title,
        n = index + 1,
        ch_title = ch.title,
        plan = ch.plan,
    )
}

pub fn summary_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "required": ["summary", "used"],
        "properties": {
            "summary": { "type": "string" },
            "used": { "type": "array", "items": { "type": "integer" } }
        }
    })
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct SummaryReply {
    pub summary: String,
    pub used: Vec<i64>,
}

/// After a chapter: what it said, short, for the chapters after it.
pub fn summary_prompt(title: &str, text: &str, material: &[&Material]) -> String {
    let ideas = material.iter().map(|m| idea_line(m)).collect::<Vec<_>>().join("\n");
    format!(
        r#"Below is a finished chapter, "{title}", and the ideas it was given.

Return:
- "summary": three to five sentences on what the chapter argues and where it
  ends up — its actual points, so a later chapter can build on them without
  reading it. In the chapter's language.
- "used": the ids of the ideas the chapter actually made.

--- THE IDEAS ---
{ideas}
--- THE CHAPTER ---
{text}
--- END ---"#
    )
}

/// Keep only ids the chapter was given; fall back to all of them when the
/// model named none, since the chapter was written from them either way.
pub fn used_ids(reply: &[i64], given: &[i64]) -> Vec<i64> {
    let used: Vec<i64> = reply.iter().copied().filter(|id| given.contains(id)).collect();
    if used.is_empty() {
        given.to_vec()
    } else {
        used
    }
}

/// When no summary can be had from a model: the chapter's opening, cut at a
/// sentence. Worse than a summary, better than nothing carried forward.
pub fn rough_summary(text: &str) -> String {
    let body: String =
        text.lines().filter(|l| !l.trim_start().starts_with('#')).collect::<Vec<_>>().join(" ");
    let body = body.trim();
    if body.chars().count() <= 500 {
        return body.to_string();
    }
    let cut: String = body.chars().take(500).collect();
    match cut.rfind(". ") {
        Some(i) => cut[..=i].to_string(),
        None => format!("{cut}…"),
    }
}

// ------------------------------------------------------------------ check

pub fn check_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "required": ["notes"],
        "properties": {
            "notes": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["chapter", "note"],
                    "properties": {
                        "chapter": { "type": "integer" },
                        "note": { "type": "string" }
                    }
                }
            }
        }
    })
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct CheckReply {
    pub notes: Vec<Note>,
}

/// The last pass: read the book against its outline and say where it drifted.
/// It only points; nothing is rewritten on its say-so.
pub fn check_prompt(project: &Project) -> String {
    let body = project
        .chapters
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let written = if c.text.is_empty() {
                "(not written yet)".to_string()
            } else if c.summary.is_empty() {
                rough_summary(&c.text)
            } else {
                c.summary.clone()
            };
            format!("{}. {}\n   planned: {}\n   written: {}", i + 1, c.title, c.plan, written)
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        r#"A book, "{title}", chapter by chapter: what each was planned to argue,
and what the written chapter actually says.

Point out, briefly, only real problems:
- a chapter that does not do what its plan says;
- two chapters that make the same argument;
- something an early chapter sets up that no later chapter pays off;
- a later chapter that contradicts an earlier one without saying so.

"chapter" is the chapter's number. No praise, no general advice, and no notes
at all if there is nothing wrong. Write the notes in the book's language.

{body}"#,
        title = project.title,
    )
}

/// The book as one markdown document.
pub fn markdown(project: &Project) -> String {
    let mut out =
        format!("# {}\n", if project.title.is_empty() { "Untitled" } else { &project.title });
    for c in project.chapters.iter().filter(|c| !c.text.trim().is_empty()) {
        out.push('\n');
        let text = c.text.trim();
        if !text.starts_with("## ") {
            out.push_str(&format!("## {}\n\n", c.title));
        }
        out.push_str(text);
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: i64, quote: &str) -> BookRow {
        BookRow {
            idea_id: id,
            title: format!("Idea {id}"),
            claim: format!("Claim {id}"),
            category: "work".into(),
            quote: quote.into(),
            reasoning: String::new(),
            said_on: String::new(),
        }
    }

    fn material() -> Vec<Material> {
        gather(vec![row(1, "first"), row(2, "second")])
    }

    #[test]
    fn gather_keeps_one_entry_per_idea_with_its_quotes() {
        let got = gather(vec![
            row(1, "a"),
            row(2, "b"),
            row(1, "c"),
            row(1, "a"),
            row(1, "d"),
            row(1, "e"),
        ]);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].quotes, vec!["a", "c", "d"], "no repeats, at most three");
    }

    #[test]
    fn a_folder_book_and_the_all_book_live_in_different_files() {
        let dir = Path::new("/data");
        assert_ne!(path_for(dir, Some(3)), path_for(dir, None));
        assert!(path_for(dir, Some(3)).starts_with("/data/books"));
    }

    #[test]
    fn a_project_survives_being_saved_and_loaded() {
        let dir = std::env::temp_dir().join(format!("aigraph-writer-{}", std::process::id()));
        let path = path_for(&dir, Some(1));
        let p = Project {
            title: "T".into(),
            chapters: vec![Chapter {
                title: "One".into(),
                text: "## One\n\nHi".into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        save(&path, &p).unwrap();
        assert_eq!(load(&path), p);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(load(&path), Project::default(), "missing is an empty book, not an error");
    }

    #[test]
    fn an_outline_drops_invented_ids_and_keeps_written_chapters() {
        let old = Project {
            chapters: vec![Chapter {
                title: "Kept".into(),
                text: "done".into(),
                summary: "s".into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        let reply = OutlineReply {
            language: "English".into(),
            title: "Book".into(),
            chapters: vec![
                OutlineChapter { title: "Kept".into(), plan: "p".into(), ideas: vec![1, 99, 1] },
                OutlineChapter { title: "New".into(), plan: "q".into(), ideas: vec![2] },
                OutlineChapter { title: " ".into(), plan: "".into(), ideas: vec![] },
            ],
        };
        let p = apply_outline(old, "brief", reply, &material());
        assert_eq!(p.chapters.len(), 2);
        assert_eq!(p.chapters[0].ideas, vec![1]);
        assert_eq!(p.chapters[0].text, "done");
        assert!(p.chapters[1].text.is_empty());
        assert_eq!(p.title, "Book");
    }

    #[test]
    fn voice_samples_are_the_persons_own_middling_turns() {
        let long = "x".repeat(300);
        let rec = vec![Recorded {
            session_id: 1,
            title: String::new(),
            started_at: String::new(),
            turns: vec![
                ("user".into(), "yes".into()),
                ("assistant".into(), long.clone()),
                ("user".into(), long.clone()),
            ],
        }];
        assert_eq!(voice_samples(&rec, 10_000), vec![long]);
    }

    #[test]
    fn a_chapter_is_told_what_came_before_and_what_it_has_to_work_with() {
        let m = material();
        let p = Project {
            title: "Book".into(),
            chapters: vec![
                Chapter {
                    title: "One".into(),
                    plan: "first".into(),
                    summary: "It said A.".into(),
                    ..Default::default()
                },
                Chapter { title: "Two".into(), plan: "second".into(), ..Default::default() },
            ],
            ..Default::default()
        };
        let prompt = chapter_prompt(&p, 1, &[&m[1]], &[&m[0]]);
        assert!(prompt.contains("It said A."));
        assert!(prompt.contains("Two\"."));
        assert!(prompt.contains("said: \"second\""));
        assert!(prompt.contains("- Idea 1"), "earlier ideas are listed as covered");
    }

    #[test]
    fn json_is_found_inside_a_chatty_reply() {
        let r: SummaryReply =
            parse_json("Sure!\n```json\n{\"summary\": \"s\", \"used\": [1]}\n```").unwrap();
        assert_eq!(r.summary, "s");
        assert_eq!(used_ids(&r.used, &[1, 2]), vec![1]);
        assert_eq!(
            used_ids(&[7], &[1, 2]),
            vec![1, 2],
            "none of the given ones named: all of them"
        );
    }

    #[test]
    fn the_markdown_has_every_written_chapter_under_the_title() {
        let p = Project {
            title: "Book".into(),
            chapters: vec![
                Chapter { title: "One".into(), text: "## One\n\nA".into(), ..Default::default() },
                Chapter { title: "Two".into(), text: String::new(), ..Default::default() },
                Chapter { title: "Three".into(), text: "B".into(), ..Default::default() },
            ],
            ..Default::default()
        };
        let md = markdown(&p);
        assert!(md.starts_with("# Book\n"));
        assert!(md.contains("## One\n\nA"));
        assert!(!md.contains("Two"));
        assert!(md.contains("## Three\n\nB"));
    }
}
