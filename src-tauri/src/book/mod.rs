//! A folder's ideas, set as a book and written out as a PDF.
//!
//! The map is for finding your way around what you think; this is for handing
//! it to someone. Same material, opposite reading posture — so it is typeset
//! rather than rendered: one column at a readable measure, a chapter per
//! subject, and the words you actually said set as quotations underneath the
//! thought they produced.
//!
//! Laid out here rather than by printing a web page. The app has no browser to
//! print from that would behave the same on three platforms, and a PDF that
//! comes out differently depending on the machine is not a document you can
//! give anyone. Everything below — the measure, the leading, the page breaks —
//! is decided in this file and nowhere else.

use printpdf::{Color, IndirectFontRef, Mm, PdfDocumentReference, PdfLayerReference, Rgb};

use crate::store::BookRow;

/// Bundled rather than looked up on the system: a book that renders with
/// different metrics on a machine without the font is a different book, and
/// on a machine with no serif at all it is an unreadable one.
///
/// Noto Serif covers Latin, Latin Extended-A, Greek and Cyrillic, which is
/// what carries Polish and Spanish through with their diacritics intact.
/// A character the font has no glyph for is dropped silently by the PDF
/// writer, so the coverage is the guarantee — see `LICENSE.md` beside them.
pub(crate) const REGULAR: &[u8] = include_bytes!("../../assets/fonts/NotoSerif-Regular.ttf");
pub(crate) const BOLD: &[u8] = include_bytes!("../../assets/fonts/NotoSerif-Bold.ttf");

// A5. A book rather than a report: at this size the measure below lands near
// sixty-five characters, which is where prose is easiest to read, and two of
// them print on one A4 sheet.
const PAGE_W: f32 = 148.0;
const PAGE_H: f32 = 210.0;
const MARGIN_X: f32 = 17.0;
const MARGIN_TOP: f32 = 21.0;
const MARGIN_BOTTOM: f32 = 20.0;
/// The width text is set to.
const MEASURE: f32 = PAGE_W - MARGIN_X * 2.0;
/// Where the last line of a page may end.
const FLOOR: f32 = PAGE_H - MARGIN_BOTTOM;

const BODY_PT: f32 = 10.5;
const BODY_LEAD: f32 = 5.4;
const STATEMENT_PT: f32 = 12.0;
const STATEMENT_LEAD: f32 = 6.0;
const QUOTE_PT: f32 = 9.5;
const QUOTE_LEAD: f32 = 4.9;
const QUOTE_INDENT: f32 = 7.0;
const SMALL_PT: f32 = 8.0;
const CHAPTER_PT: f32 = 19.0;

pub(crate) const MM_PER_PT: f32 = 25.4 / 72.0;

fn ink() -> Color {
    Color::Rgb(Rgb::new(0.09, 0.09, 0.10, None))
}
fn grey() -> Color {
    Color::Rgb(Rgb::new(0.42, 0.40, 0.39, None))
}
fn faint() -> Color {
    Color::Rgb(Rgb::new(0.58, 0.56, 0.55, None))
}
/// The app's own accent, in its light-theme value — the one that holds up on
/// white paper rather than on a dark screen.
fn accent() -> Color {
    Color::Rgb(Rgb::new(0.757, 0.373, 0.192, None))
}

#[derive(Debug, thiserror::Error)]
pub enum BookError {
    #[error("nothing to make a book from — this folder has no recorded ideas yet")]
    Empty,
    #[error("the bundled book font could not be read: {0}")]
    Font(String),
    #[error("writing the pdf: {0}")]
    Pdf(String),
}

/// A book, ready to be set.
pub struct Book {
    pub title: String,
    pub chapters: Vec<Chapter>,
    pub ideas: usize,
    /// What this thinking is about, at the front. Written by the model from
    /// the ideas — see `extract::closing` — and absent when no model was
    /// loaded, which is a book without a foreword rather than no book.
    pub opening: Option<String>,
    /// What it amounts to, at the back. Same provenance, same caveat.
    pub conclusion: Option<String>,
}

/// A line in the contents, and the page it points at.
struct Mark {
    text: String,
    folio: usize,
    /// Chapters sit flush; the ideas under them are indented and set smaller,
    /// so the shape of the book is legible from the contents alone.
    chapter: bool,
}

impl Book {
    /// The ideas by subject, as the closing prompt wants them.
    pub fn outline(&self) -> Vec<(String, Vec<String>)> {
        self.chapters
            .iter()
            .map(|c| (c.name.clone(), c.entries.iter().map(|e| e.statement.clone()).collect()))
            .collect()
    }
}

pub struct Chapter {
    pub name: String,
    pub entries: Vec<Entry>,
}

/// One idea as it appears on the page.
pub struct Entry {
    /// The idea stated — the heading it is filed under and the claim itself,
    /// which since the titles became statements are the same sentence.
    pub statement: String,
    /// The claim in the words as spoken, when that says something the
    /// statement does not. Dropped when the two have converged.
    pub claim: Option<String>,
    /// Why it is held, on the evidence of the transcript.
    pub why: String,
    pub quotes: Vec<Quote>,
}

pub struct Quote {
    pub text: String,
    pub said_on: String,
}

/// Group the flat rows into chapters.
///
/// The rows arrive ordered by subject and then by when the thought was first
/// had, so grouping is a walk rather than a sort — except for the chapters
/// themselves, which are ordered by weight: the subject you have thought about
/// most opens the book, and whatever was never filed under anything closes it.
pub fn assemble(folder_name: &str, rows: Vec<BookRow>) -> Book {
    let mut chapters: Vec<Chapter> = Vec::new();

    for row in rows {
        let subject = if row.category.trim().is_empty() {
            "Unsorted".to_string()
        } else {
            capitalise(row.category.trim())
        };

        if chapters.last().map(|c| c.name != subject).unwrap_or(true) {
            chapters.push(Chapter { name: subject, entries: Vec::new() });
        }
        let chapter = chapters.last_mut().expect("just pushed");

        let quote = Quote { text: tidy(&row.quote), said_on: row.said_on.clone() };

        // Rows are one per quote, so consecutive rows for the same idea are
        // further evidence for it rather than a second entry.
        match chapter.entries.last_mut() {
            Some(last) if last.statement == tidy(&row.title) => {
                if !last.quotes.iter().any(|q| q.text == quote.text) {
                    last.quotes.push(quote);
                }
                if last.why.is_empty() {
                    last.why = tidy(&row.reasoning);
                }
            }
            _ => {
                let statement = tidy(&row.title);
                let claim = tidy(&row.claim);
                chapter.entries.push(Entry {
                    claim: (!same_sentence(&statement, &claim)).then_some(claim),
                    statement,
                    why: tidy(&row.reasoning),
                    quotes: vec![quote],
                });
            }
        }
    }

    chapters.sort_by(|a, b| {
        let last = |c: &Chapter| c.name == "Unsorted";
        last(a).cmp(&last(b)).then(b.entries.len().cmp(&a.entries.len())).then(a.name.cmp(&b.name))
    });

    // The claim is the sentence as spoken and the quote is the span it was
    // spoken in, which very often makes them the same words — and the quote
    // is the one worth keeping, because it is the verbatim one and it carries
    // the date. Decided here rather than above because the quotes for an idea
    // are only all in once its rows have all been read.
    for chapter in &mut chapters {
        for entry in &mut chapter.entries {
            let covered = entry
                .claim
                .as_ref()
                .is_some_and(|claim| entry.quotes.iter().any(|q| overlaps(&q.text, claim)));
            if covered {
                entry.claim = None;
            }
        }
    }

    let ideas = chapters.iter().map(|c| c.entries.len()).sum();
    Book { title: folder_name.to_string(), chapters, ideas, opening: None, conclusion: None }
}

/// Collapse the whitespace a transcript carries into running text.
fn tidy(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn capitalise(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Whether two sentences say the same thing, allowing for a full stop and a
/// capital. Titles are statements now, so a title and its claim are usually
/// the same words — printing both would be printing it twice.
///
/// Equality only, deliberately. Treating a prefix as a match looked like the
/// same rule and was not: a claim that continues past the title — "…because
/// it is paid for by the hour" — is precisely the case worth keeping, and a
/// prefix test throws away the half that says something.
fn same_sentence(a: &str, b: &str) -> bool {
    flatten(a) == flatten(b)
}

fn flatten(s: &str) -> String {
    s.to_lowercase().chars().filter(|c| c.is_alphanumeric() || c.is_whitespace()).collect()
}

/// Whether one of these contains the other — the test for a claim that the
/// quote beneath it is about to say again, word for word.
fn overlaps(a: &str, b: &str) -> bool {
    let (a, b) = (flatten(a), flatten(b));
    if a.is_empty() || b.is_empty() {
        return false;
    }
    a.contains(&b) || b.contains(&a)
}

/// A date as a reader wants it, from what the database stores.
fn on_day(rfc3339: &str) -> String {
    match chrono::DateTime::parse_from_rfc3339(rfc3339) {
        Ok(d) => d.format("%-d %B %Y").to_string(),
        // Better the raw value than nothing: this is a caption, not a
        // calculation, and a malformed date should not lose the page.
        Err(_) => rfc3339.split('T').next().unwrap_or(rfc3339).to_string(),
    }
}

/// Glyph advances, for deciding where a line ends.
///
/// The PDF writer will happily set a line that runs off the page — nothing in
/// it measures text — so wrapping is ours to do, and doing it needs the same
/// font the page is set in.
/// Measuring text in a font, which is what makes wrapping possible.
///
/// Shared with `crate::export`: a document and a book are set differently,
/// but "how wide is this at this size" is the same question and the fiddly
/// part of answering it is the same code.
pub(crate) struct Metrics {
    face: ttf_parser::Face<'static>,
    upem: f32,
}

impl Metrics {
    pub(crate) fn new(data: &'static [u8]) -> Result<Self, BookError> {
        let face =
            ttf_parser::Face::parse(data, 0).map_err(|e| BookError::Font(format!("{e:?}")))?;
        let upem = f32::from(face.units_per_em());
        Ok(Self { face, upem })
    }

    /// Width of `text` at `pt`, in millimetres.
    pub(crate) fn width(&self, text: &str, pt: f32) -> f32 {
        let em: f32 = text
            .chars()
            .map(|c| {
                self.face
                    .glyph_index(c)
                    .and_then(|g| self.face.glyph_hor_advance(g))
                    .map(f32::from)
                    .unwrap_or(0.0)
            })
            .sum::<f32>()
            / self.upem;
        em * pt * MM_PER_PT
    }

    /// Break `text` into lines that fit `width`.
    pub(crate) fn wrap(&self, text: &str, pt: f32, width: f32) -> Vec<String> {
        let mut lines: Vec<String> = Vec::new();
        let mut line = String::new();

        for word in text.split_whitespace() {
            let candidate =
                if line.is_empty() { word.to_string() } else { format!("{line} {word}") };
            if self.width(&candidate, pt) <= width || line.is_empty() {
                // A single word wider than the measure still goes on its own
                // line rather than looping forever; it overhangs, which is
                // rarer and less wrong than an empty page.
                line = candidate;
            } else {
                lines.push(std::mem::take(&mut line));
                line = word.to_string();
            }
        }
        if !line.is_empty() {
            lines.push(line);
        }
        if lines.is_empty() {
            lines.push(String::new());
        }
        lines
    }
}

/// The pen: which page is being written on, and how far down it.
struct Pen<'a> {
    doc: &'a PdfDocumentReference,
    layer: PdfLayerReference,
    regular: IndirectFontRef,
    bold: IndirectFontRef,
    rm: Metrics,
    bm: Metrics,
    /// Millimetres from the top of the page.
    y: f32,
    /// What the reader sees at the foot of the page. Front matter is not
    /// numbered, so this starts once the first chapter does.
    folio: usize,
    /// Printed at the head of every page of a chapter.
    running: String,
    /// Which page the entry being set began on, so the contents can point at
    /// where an idea starts rather than where it happened to end.
    entry_started_on: usize,
}

impl<'a> Pen<'a> {
    /// Put text down with its *top* at `y` millimetres from the page top,
    /// which is how the rest of this file thinks about position — PDF itself
    /// measures up from the bottom left, and converting once here means
    /// nothing else has to.
    fn text(&self, s: &str, pt: f32, x: f32, y: f32, bold: bool, color: Color) {
        if s.is_empty() {
            return;
        }
        self.layer.set_fill_color(color);
        let baseline = y + pt * MM_PER_PT * 0.78;
        self.layer.use_text(
            s,
            pt,
            Mm(x),
            Mm(PAGE_H - baseline),
            if bold { &self.bold } else { &self.regular },
        );
    }

    fn metrics(&self, bold: bool) -> &Metrics {
        if bold {
            &self.bm
        } else {
            &self.rm
        }
    }

    /// Start a page, carrying the running head and the folio onto it.
    fn page_break(&mut self) {
        let (page, layer) = self.doc.add_page(Mm(PAGE_W), Mm(PAGE_H), "Page");
        self.layer = self.doc.get_page(page).get_layer(layer);
        self.folio += 1;
        self.y = MARGIN_TOP;

        if !self.running.is_empty() {
            self.text(&self.running, SMALL_PT, MARGIN_X, MARGIN_TOP - 9.0, false, faint());
        }
        let folio = self.folio.to_string();
        let w = self.rm.width(&folio, SMALL_PT);
        self.text(
            &folio,
            SMALL_PT,
            (PAGE_W - w) / 2.0,
            PAGE_H - MARGIN_BOTTOM + 8.0,
            false,
            faint(),
        );
    }

    /// Make room for something `needed` millimetres tall, breaking the page if
    /// it will not fit.
    fn room_for(&mut self, needed: f32) {
        if self.y + needed > FLOOR {
            self.page_break();
        }
    }

    /// Set a wrapped block of text, breaking pages as it goes.
    fn block(&mut self, text: &str, pt: f32, lead: f32, indent: f32, bold: bool, color: Color) {
        let width = MEASURE - indent;
        for line in self.metrics(bold).wrap(text, pt, width) {
            self.room_for(lead);
            self.text(&line, pt, MARGIN_X + indent, self.y, bold, color.clone());
            self.y += lead;
        }
    }
}

/// The same book as Markdown.
///
/// Not a lesser PDF — a different thing to want. Markdown goes into whatever
/// someone already writes in, keeps the quotations as quotations, and stays
/// readable in a terminal in twenty years. The typesetting is what the PDF is
/// for; this is for the words.
pub fn markdown(book: &Book) -> String {
    let mut out = String::new();
    out.push_str(&format!("# {}\n\n", book.title));
    out.push_str(&format!(
        "{} idea{} across {} subject{}.\n\n",
        book.ideas,
        if book.ideas == 1 { "" } else { "s" },
        book.chapters.len(),
        if book.chapters.len() == 1 { "" } else { "s" },
    ));

    if let Some(opening) = book.opening.as_deref().filter(|o| !o.trim().is_empty()) {
        out.push_str(&format!("{opening}\n\n"));
        out.push_str(&format!("*{WRITTEN_HERE}*\n\n"));
    }

    out.push_str("## Contents\n\n");
    for chapter in &book.chapters {
        out.push_str(&format!("- **{}**\n", chapter.name));
        for entry in &chapter.entries {
            out.push_str(&format!("  - {}\n", entry.statement));
        }
    }
    out.push('\n');

    for chapter in &book.chapters {
        out.push_str(&format!("## {}\n\n", chapter.name));
        for entry in &chapter.entries {
            out.push_str(&format!("### {}\n\n", entry.statement));
            if let Some(claim) = &entry.claim {
                out.push_str(&format!("{claim}\n\n"));
            }
            if !entry.why.is_empty() {
                out.push_str(&format!("{}\n\n", entry.why));
            }
            for quote in &entry.quotes {
                // Blockquote, with the date on its own line inside it, so the
                // attribution cannot drift away from what it attributes.
                out.push_str(&format!("> {}\n>\n> — {}\n\n", quote.text, on_day(&quote.said_on)));
            }
        }
    }

    if let Some(conclusion) = book.conclusion.as_deref().filter(|c| !c.trim().is_empty()) {
        out.push_str(&format!("## In conclusion\n\n{conclusion}\n\n"));
        out.push_str(&format!("*{WRITTEN_HERE}*\n"));
    }

    out
}

/// Said on both the typeset page and the Markdown one, in the same words.
const WRITTEN_HERE: &str = "Written by the model from the ideas recorded here. \
     It is the only part of this book that is not drawn from the conversations.";

/// Set the book and hand back the PDF.
pub fn render(book: &Book) -> Result<Vec<u8>, BookError> {
    if book.chapters.is_empty() {
        return Err(BookError::Empty);
    }

    let rm = Metrics::new(REGULAR)?;
    let bm = Metrics::new(BOLD)?;

    let (doc, cover_page, cover_layer) =
        printpdf::PdfDocument::new(&book.title, Mm(PAGE_W), Mm(PAGE_H), "Cover");
    let regular = doc.add_external_font(REGULAR).map_err(|e| BookError::Font(e.to_string()))?;
    let bold = doc.add_external_font(BOLD).map_err(|e| BookError::Font(e.to_string()))?;

    let mut pen = Pen {
        doc: &doc,
        layer: doc.get_page(cover_page).get_layer(cover_layer),
        regular,
        bold,
        rm,
        bm,
        y: MARGIN_TOP,
        folio: 0,
        running: String::new(),
        entry_started_on: 0,
    };

    cover(&mut pen, book);

    // Reserved now and written last: the contents needs page numbers that only
    // exist once the book has been set, and a page cannot be pushed in front
    // of pages that already follow it. A line per chapter and a line per idea
    // under it, so the reserve has to account for both.
    // Sized on the *tallest* line a contents can hold — a chapter — rather
    // than the average. These pages cannot break when they fill up: they were
    // reserved before there was anything to put on them, so the count has to
    // be one that cannot overflow rather than one that usually doesn't.
    let per_page = ((FLOOR - MARGIN_TOP - 18.0) / (BODY_LEAD + 1.0)).floor().max(1.0) as usize;
    let lines = book.chapters.len() + book.ideas + usize::from(book.conclusion.is_some());
    let sheets = lines.div_ceil(per_page).max(1);
    let contents: Vec<PdfLayerReference> = (0..sheets)
        .map(|_| {
            let (p, l) = doc.add_page(Mm(PAGE_W), Mm(PAGE_H), "Contents");
            doc.get_page(p).get_layer(l)
        })
        .collect();

    // The foreword, if a model wrote one. Before the first chapter and after
    // the contents, where a foreword goes.
    if let Some(opening) = book.opening.as_deref().filter(|o| !o.trim().is_empty()) {
        pen.running = String::new();
        pen.page_break();
        pen.y = MARGIN_TOP + 14.0;
        pen.block(opening, BODY_PT + 0.7, BODY_LEAD + 0.6, 0.0, false, ink());
        pen.y += 3.0;
        written_here(&mut pen);
    }

    let mut marks: Vec<Mark> = Vec::new();
    for chapter in &book.chapters {
        // Chapters open a page of their own — the one place the layout spends
        // paper rather than saving it, because it is what tells a reader they
        // have arrived somewhere new.
        //
        // No running head on that page: the title is right there, and a book
        // that prints the chapter name twice on the page where it starts
        // looks like it lost track of itself. It resumes on the page after.
        pen.running = String::new();
        pen.page_break();
        pen.running = chapter.name.clone();
        marks.push(Mark { text: chapter.name.clone(), folio: pen.folio, chapter: true });

        pen.y = MARGIN_TOP + 14.0;
        pen.block(&chapter.name, CHAPTER_PT, CHAPTER_PT * MM_PER_PT * 1.25, 0.0, true, ink());
        rule(&pen, pen.y + 1.5, 26.0, accent());
        pen.y += 12.0;

        for entry in &chapter.entries {
            // Recorded before the entry is set, not after: `set_entry` may
            // break the page part-way through, and the contents should point
            // at where the idea starts rather than where it ended up.
            set_entry(&mut pen, entry);
            marks.push(Mark {
                text: entry.statement.clone(),
                folio: pen.entry_started_on,
                chapter: false,
            });
        }
    }

    if let Some(conclusion) = book.conclusion.as_deref().filter(|c| !c.trim().is_empty()) {
        pen.running = String::new();
        pen.page_break();
        pen.running = "In conclusion".into();
        marks.push(Mark { text: "In conclusion".into(), folio: pen.folio, chapter: true });

        pen.y = MARGIN_TOP + 14.0;
        pen.block("In conclusion", CHAPTER_PT, CHAPTER_PT * MM_PER_PT * 1.25, 0.0, true, ink());
        rule(&pen, pen.y + 1.5, 26.0, accent());
        pen.y += 12.0;
        pen.block(conclusion, BODY_PT + 0.7, BODY_LEAD + 0.6, 0.0, false, ink());
        pen.y += 3.0;
        written_here(&mut pen);
    }

    write_contents(&doc, &pen, &contents, &marks, per_page);

    doc.save_to_bytes().map_err(|e| BookError::Pdf(e.to_string()))
}

/// The title page: what this is, whose thinking it holds, and how much.
fn cover(pen: &mut Pen, book: &Book) {
    pen.y = 74.0;
    pen.block(&book.title, 26.0, 26.0 * MM_PER_PT * 1.2, 0.0, true, ink());

    pen.y += 5.0;
    rule(pen, pen.y, 30.0, accent());
    pen.y += 9.0;

    let chapters = book.chapters.len();
    let count = format!(
        "{} idea{} across {} subject{}",
        book.ideas,
        if book.ideas == 1 { "" } else { "s" },
        chapters,
        if chapters == 1 { "" } else { "s" },
    );
    pen.block(&count, BODY_PT, BODY_LEAD, 0.0, false, grey());

    let mark = "Recorded in AIgraph. Every quotation is verbatim.";
    pen.text(mark, SMALL_PT, MARGIN_X, PAGE_H - MARGIN_BOTTOM, false, faint());
}

/// Say plainly that this page is the machine's and not theirs.
///
/// Every other word in the book is either something the person said or a
/// reading of something they said, traceable to a quotation on the same page.
/// These two sections are not, and a book that blurred that line would be
/// putting words in someone's mouth in a form they might hand to somebody
/// else.
fn written_here(pen: &mut Pen) {
    pen.room_for(6.0);
    pen.block(WRITTEN_HERE, SMALL_PT, SMALL_PT * MM_PER_PT * 1.5, 0.0, false, faint());
}

/// A short rule, used where a page needs a break rather than a heading.
fn rule(pen: &Pen, y: f32, width: f32, color: Color) {
    pen.layer.set_outline_color(color);
    pen.layer.set_outline_thickness(1.1);
    pen.layer.add_line(printpdf::Line {
        points: vec![
            (printpdf::Point::new(Mm(MARGIN_X), Mm(PAGE_H - y)), false),
            (printpdf::Point::new(Mm(MARGIN_X + width), Mm(PAGE_H - y)), false),
        ],
        is_closed: false,
    });
}

/// One idea: what is thought, why, and the words it came from.
fn set_entry(pen: &mut Pen, entry: &Entry) {
    // A heading stranded at the foot of a page with nothing under it reads as
    // a mistake, so it takes its first couple of lines with it or moves on.
    pen.room_for(STATEMENT_LEAD * 2.0 + BODY_LEAD * 2.0);
    pen.entry_started_on = pen.folio;
    pen.y += 3.0;
    pen.block(&entry.statement, STATEMENT_PT, STATEMENT_LEAD, 0.0, true, ink());
    pen.y += 1.6;

    if let Some(claim) = &entry.claim {
        pen.block(claim, BODY_PT, BODY_LEAD, 0.0, false, grey());
        pen.y += 1.4;
    }

    if !entry.why.is_empty() {
        pen.block(&entry.why, BODY_PT, BODY_LEAD, 0.0, false, ink());
    }

    for quote in &entry.quotes {
        pen.y += 2.6;
        // Indented and set smaller, the way a book sets a quotation — and
        // dated, because when something was said is part of what it is.
        pen.room_for(QUOTE_LEAD * 2.0);
        let start = pen.y;
        pen.block(
            &format!("\u{201c}{}\u{201d}", quote.text),
            QUOTE_PT,
            QUOTE_LEAD,
            QUOTE_INDENT,
            false,
            grey(),
        );
        pen.block(
            &on_day(&quote.said_on),
            SMALL_PT,
            SMALL_PT * MM_PER_PT * 1.5,
            QUOTE_INDENT,
            false,
            faint(),
        );
        // Drawn after the text so its height is known. Only when the quote did
        // not straddle a page — a rule down the margin of the wrong page is
        // worse than no rule.
        if pen.y > start {
            quote_rule(pen, start, pen.y - 1.0);
        }
    }

    pen.y += 5.0;
}

/// The vertical rule beside a quotation.
fn quote_rule(pen: &Pen, from: f32, to: f32) {
    pen.layer.set_outline_color(faint());
    pen.layer.set_outline_thickness(0.7);
    pen.layer.add_line(printpdf::Line {
        points: vec![
            (printpdf::Point::new(Mm(MARGIN_X + 2.5), Mm(PAGE_H - from)), false),
            (printpdf::Point::new(Mm(MARGIN_X + 2.5), Mm(PAGE_H - to)), false),
        ],
        is_closed: false,
    });
}

/// Fill in the pages held back at the front.
fn write_contents(
    doc: &PdfDocumentReference,
    pen: &Pen,
    pages: &[PdfLayerReference],
    marks: &[Mark],
    per_page: usize,
) {
    let _ = doc;
    for (sheet, layer) in pages.iter().enumerate() {
        // A borrowed pen: same fonts and metrics, pointed at a page from the
        // front of the book instead of wherever the last chapter ended.
        let mut here = Pen {
            doc: pen.doc,
            layer: layer.clone(),
            regular: pen.regular.clone(),
            bold: pen.bold.clone(),
            rm: Metrics::new(REGULAR).expect("already parsed once"),
            bm: Metrics::new(BOLD).expect("already parsed once"),
            y: MARGIN_TOP,
            folio: 0,
            running: String::new(),
            entry_started_on: 0,
        };

        if sheet == 0 {
            here.block("Contents", 14.0, 8.0, 0.0, true, ink());
            here.y += 6.0;
        }

        for mark in marks.iter().skip(sheet * per_page).take(per_page) {
            let (pt, indent, color) =
                if mark.chapter { (BODY_PT, 0.0, ink()) } else { (BODY_PT - 1.2, 5.0, grey()) };
            let folio = mark.folio.to_string();
            let w = here.rm.width(&folio, pt);
            // Truncated rather than wrapped: a contents line that runs to two
            // lines stops being scannable, which is the only thing a contents
            // page is for.
            let room = MEASURE - indent - w - 3.0;
            let mut line = mark.text.clone();
            while here.metrics(mark.chapter).width(&line, pt) > room && line.len() > 1 {
                line.truncate(line.len() - 1);
                while !line.is_char_boundary(line.len()) {
                    line.truncate(line.len() - 1);
                }
            }
            if line != mark.text {
                line.push('\u{2026}');
            }
            here.text(&line, pt, MARGIN_X + indent, here.y, mark.chapter, color);
            here.text(&folio, pt, PAGE_W - MARGIN_X - w, here.y, false, faint());
            here.y += if mark.chapter { BODY_LEAD + 1.0 } else { BODY_LEAD - 0.6 };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(idea: i64, category: &str, title: &str, quote: &str) -> BookRow {
        BookRow {
            idea_id: idea,
            title: title.into(),
            claim: title.into(),
            category: category.into(),
            quote: quote.into(),
            reasoning: "because of what was said".into(),
            said_on: "2026-08-27T17:11:00+00:00".into(),
        }
    }

    #[test]
    fn quotes_for_one_idea_stay_with_it() {
        let book = assemble(
            "Root",
            vec![
                row(1, "work", "Teaching does not scale", "one"),
                row(1, "work", "Teaching does not scale", "two"),
                row(2, "work", "Recording does", "three"),
            ],
        );
        assert_eq!(book.ideas, 2);
        assert_eq!(book.chapters[0].entries[0].quotes.len(), 2);
        assert_eq!(book.chapters[0].entries[1].quotes.len(), 1);
    }

    /// The claim is only worth printing when it is not the title again.
    #[test]
    fn a_claim_that_repeats_the_title_is_not_printed_twice() {
        let mut r = row(1, "work", "Teaching does not scale", "q");
        r.claim = "Teaching does not scale.".into();
        let book = assemble("Root", vec![r]);
        assert_eq!(book.chapters[0].entries[0].claim, None);
    }

    #[test]
    fn a_claim_that_says_more_is_kept() {
        let mut r = row(1, "work", "Teaching does not scale", "an unrelated quote");
        r.claim = "Teaching does not scale because it is paid for by the hour".into();
        let book = assemble("Root", vec![r]);
        assert!(book.chapters[0].entries[0].claim.is_some());
    }

    /// The quote says it verbatim and dates it; the claim saying the same
    /// thing two lines above is the page repeating itself.
    #[test]
    fn a_claim_the_quote_already_carries_is_dropped() {
        let mut r = row(
            1,
            "work",
            "Teaching does not scale",
            "teaching does not scale because it is paid for by the hour, and I only have so many",
        );
        r.claim = "Teaching does not scale because it is paid for by the hour".into();
        let book = assemble("Root", vec![r]);
        assert_eq!(book.chapters[0].entries[0].claim, None);
    }

    /// The biggest subject opens the book; what was never filed closes it.
    #[test]
    fn chapters_are_ordered_by_weight_with_the_unsorted_last() {
        let book = assemble(
            "Root",
            vec![
                row(1, "", "Unfiled thought", "a"),
                row(2, "ethics", "One about ethics", "b"),
                row(3, "work", "One about work", "c"),
                row(4, "work", "Another about work", "d"),
            ],
        );
        let names: Vec<_> = book.chapters.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["Work", "Ethics", "Unsorted"]);
    }

    #[test]
    fn an_empty_folder_is_not_a_book() {
        let book = assemble("Root", vec![]);
        assert!(matches!(render(&book), Err(BookError::Empty)));
    }

    /// The whole point of bundling a font with Latin Extended-A in it.
    #[test]
    fn polish_survives_being_measured_and_set() {
        let book = assemble(
            "Testing for wife",
            vec![row(
                1,
                "biznes",
                "Nauczanie nie skaluje się",
                "jestem muzykiem z Polski i chciałabym założyć własną działalność",
            )],
        );
        let pdf = render(&book).expect("renders");
        assert!(pdf.len() > 1_000, "a real document came out");

        let metrics = Metrics::new(REGULAR).unwrap();
        // Every character has a glyph, so nothing is dropped on the way to the
        // page — a zero-width run here would mean silent holes in the text.
        for c in "ąćęłńóśźżĄŚŻ".chars() {
            assert!(metrics.width(&c.to_string(), BODY_PT) > 0.0, "no glyph for {c}");
        }
    }

    /// Not part of the suite: sets a real database so the typesetting can be
    /// looked at, which is the only way to judge it. Point it at a copy.
    ///
    /// ```text
    /// AIGRAPH_BOOK_DB=~/.local/share/app.aigraph/aigraph.db \
    /// AIGRAPH_BOOK_OUT=/tmp/book.pdf \
    ///   cargo test --no-default-features -- --ignored --nocapture real_database
    /// ```
    #[test]
    #[ignore = "needs a real database; writes a file"]
    fn real_database() {
        let db = std::env::var("AIGRAPH_BOOK_DB").expect("AIGRAPH_BOOK_DB");
        let out = std::env::var("AIGRAPH_BOOK_OUT").unwrap_or("/tmp/book.pdf".into());
        let folder: Option<i64> =
            std::env::var("AIGRAPH_BOOK_FOLDER").ok().and_then(|f| f.parse().ok());

        let store = crate::store::Store::open(std::path::Path::new(&db)).expect("open");
        let name = folder
            .and_then(|id| store.folders().ok()?.into_iter().find(|f| f.id == id).map(|f| f.name))
            .unwrap_or_else(|| "Everything".into());
        let mut book = assemble(&name, store.book_rows(folder).expect("rows"));
        // Stood in rather than generated: this is for looking at the layout,
        // and the layout does not care who wrote the words.
        if std::env::var("AIGRAPH_BOOK_CLOSING").is_ok() {
            book.opening = Some(
                "This is a stretch of thinking about where obligation comes from, and \
                 whether any of it was ever agreed to. It runs from theology into \
                 economics without changing the question."
                    .into(),
            );
            book.conclusion = Some(
                "The positions here converge on one move: taking a debt that is assumed \
                 to be owed and asking who agreed to it. Gratitude for existence, \
                 maintenance as inheritance, and the entitlement of a generation are the \
                 same argument at three scales. Where they pull apart is on whether the \
                 absence of an agreement makes the obligation void or merely unchosen, \
                 and nothing here settles that. What is still open is what replaces the \
                 debt once it is refused."
                    .into(),
            );
        }
        println!("{}: {} ideas in {} chapters", name, book.ideas, book.chapters.len());
        for c in &book.chapters {
            println!("  {} — {} entries", c.name, c.entries.len());
        }
        std::fs::write(&out, render(&book).expect("render")).expect("write");
        println!("wrote {out}");
    }

    /// The written sections have to be marked as written, in both formats —
    /// it is the one place the book is not quoting anybody.
    #[test]
    fn the_generated_sections_say_they_were_generated() {
        let mut book = assemble("Root", vec![row(1, "work", "Teaching does not scale", "q")]);
        book.opening = Some("An opening.".into());
        book.conclusion = Some("A conclusion.".into());

        let md = markdown(&book);
        assert_eq!(md.matches(WRITTEN_HERE).count(), 2, "once under each");
        assert!(md.contains("## In conclusion"));
        assert!(md.contains("## Contents"));
        assert!(md.contains("> q"), "the quote stays a quote");

        assert!(render(&book).is_ok());
    }

    /// A folder exported with no model loaded is still a book.
    #[test]
    fn no_closing_is_a_book_without_one_rather_than_an_error() {
        let book = assemble("Root", vec![row(1, "work", "Teaching does not scale", "q")]);
        assert!(book.opening.is_none());
        let md = markdown(&book);
        assert!(!md.contains(WRITTEN_HERE));
        assert!(!md.contains("In conclusion"));
        assert!(render(&book).is_ok());
    }

    #[test]
    fn long_text_wraps_to_the_measure() {
        let metrics = Metrics::new(REGULAR).unwrap();
        let text = "the same short word ".repeat(60);
        let lines = metrics.wrap(&text, BODY_PT, MEASURE);
        assert!(lines.len() > 1, "wrapped at all");
        for line in &lines {
            assert!(metrics.width(line, BODY_PT) <= MEASURE, "over the measure: {line}");
        }
    }

    /// A word longer than the line has nowhere to break; it must still
    /// terminate rather than loop looking for a fit that cannot happen.
    #[test]
    fn one_enormous_word_does_not_hang() {
        let metrics = Metrics::new(REGULAR).unwrap();
        let lines = metrics.wrap(&"x".repeat(400), BODY_PT, MEASURE);
        assert_eq!(lines.len(), 1);
    }
}
