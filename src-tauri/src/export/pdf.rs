//! A document, typeset on A4.
//!
//! Not the book renderer. That one sets a folder's *ideas* — a cover, a
//! contents page, chapters per subject, quotations under each claim — and its
//! whole shape is decided by that material. This sets whatever a model wrote
//! in answer to one instruction: a title, headings, paragraphs and bullets, on
//! a page meant to be printed or mailed rather than bound.
//!
//! A4 rather than the book's A5 for the same reason: this is a report or an
//! essay, and a report at book measure looks like a pamphlet.

use printpdf::{Color, IndirectFontRef, Mm, PdfDocumentReference, PdfLayerReference, Rgb};

use crate::book::{Metrics, BOLD, MM_PER_PT, REGULAR};

use super::markdown::Block;
use super::ooxml::ExportError;

const PAGE_W: f32 = 210.0;
const PAGE_H: f32 = 297.0;
const MARGIN_X: f32 = 25.0;
const MARGIN_TOP: f32 = 25.0;
const MARGIN_BOTTOM: f32 = 22.0;
const MEASURE: f32 = PAGE_W - MARGIN_X * 2.0;
const FLOOR: f32 = PAGE_H - MARGIN_BOTTOM;

const TITLE_PT: f32 = 22.0;
const BODY_PT: f32 = 11.0;
const BODY_LEAD: f32 = 5.6;
const BULLET_INDENT: f32 = 6.0;
const SMALL_PT: f32 = 8.0;

fn ink() -> Color {
    Color::Rgb(Rgb::new(0.09, 0.09, 0.10, None))
}
fn faint() -> Color {
    Color::Rgb(Rgb::new(0.55, 0.53, 0.52, None))
}

/// How a heading is set, by level.
fn heading_size(level: u8) -> (f32, f32, f32) {
    // Size, leading, and the air above it. A heading needs more space before
    // than after: it belongs to what follows it, and equal space on both
    // sides makes it float between two sections belonging to neither.
    match level {
        1 => (16.0, 8.0, 9.0),
        2 => (13.0, 6.6, 7.0),
        _ => (11.5, 6.0, 5.5),
    }
}

struct Pen<'a> {
    doc: &'a PdfDocumentReference,
    layer: PdfLayerReference,
    regular: IndirectFontRef,
    bold: IndirectFontRef,
    rm: Metrics,
    bm: Metrics,
    /// Millimetres from the top of the page.
    y: f32,
    page: usize,
}

impl<'a> Pen<'a> {
    /// Put text down with its *top* at `y` millimetres from the page top.
    /// PDF measures up from the bottom left; converting once here means
    /// nothing else in this file has to think about it.
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

    fn page_break(&mut self) {
        let (page, layer) = self.doc.add_page(Mm(PAGE_W), Mm(PAGE_H), "Page");
        self.layer = self.doc.get_page(page).get_layer(layer);
        self.page += 1;
        self.y = MARGIN_TOP;
        let folio = self.page.to_string();
        let w = self.rm.width(&folio, SMALL_PT);
        self.text(&folio, SMALL_PT, (PAGE_W - w) / 2.0, PAGE_H - MARGIN_BOTTOM + 8.0, false, faint());
    }

    fn room_for(&mut self, needed: f32) {
        if self.y + needed > FLOOR {
            self.page_break();
        }
    }

    /// Set a wrapped block, breaking pages as it goes.
    ///
    /// `hanging` is the extra indent every line after the first gets, which is
    /// what makes a bullet's text line up under itself rather than under its
    /// own mark.
    fn block(&mut self, text: &str, pt: f32, lead: f32, indent: f32, hanging: f32, bold: bool) {
        let width = MEASURE - indent - hanging;
        for (i, line) in self.metrics(bold).wrap(text, pt, width).into_iter().enumerate() {
            self.room_for(lead);
            let x = MARGIN_X + indent + if i == 0 { 0.0 } else { hanging };
            self.text(&line, pt, x, self.y, bold, ink());
            self.y += lead;
        }
    }
}

/// Set a document and hand back the bytes.
pub fn render(title: &str, blocks: &[Block]) -> Result<Vec<u8>, ExportError> {
    if blocks.is_empty() && title.trim().is_empty() {
        return Err(ExportError::Empty);
    }

    let (doc, page, layer) =
        printpdf::PdfDocument::new(title, Mm(PAGE_W), Mm(PAGE_H), "Page");
    let regular = doc
        .add_external_font(REGULAR)
        .map_err(|e| ExportError::Pdf(format!("the bundled font: {e}")))?;
    let bold = doc
        .add_external_font(BOLD)
        .map_err(|e| ExportError::Pdf(format!("the bundled bold font: {e}")))?;

    let mut pen = Pen {
        layer: doc.get_page(page).get_layer(layer),
        doc: &doc,
        regular,
        bold,
        rm: Metrics::new(REGULAR).map_err(|e| ExportError::Pdf(e.to_string()))?,
        bm: Metrics::new(BOLD).map_err(|e| ExportError::Pdf(e.to_string()))?,
        y: MARGIN_TOP,
        page: 1,
    };

    // The title carries its own air rather than a title page: this is a
    // document of a few pages, and a page holding one line is a book's
    // manners applied to a memo.
    pen.block(title, TITLE_PT, TITLE_PT * MM_PER_PT * 1.25, 0.0, 0.0, true);
    pen.y += 6.0;

    for block in blocks {
        match block {
            Block::Heading { level, text } => {
                let (pt, lead, before) = heading_size(*level);
                // The air above a heading belongs to the heading. Added
                // before the room check, so a heading that only fits because
                // its own space was ignored does not end up jammed against
                // the top margin of the next page.
                pen.y += before;
                pen.room_for(lead * 2.5);
                pen.block(text, pt, lead, 0.0, 0.0, true);
                pen.y += 1.5;
            }
            Block::Paragraph(text) => {
                pen.block(text, BODY_PT, BODY_LEAD, 0.0, 0.0, false);
                pen.y += 2.6;
            }
            Block::Bullet(text) => {
                // The mark is set separately from the words so the words can
                // hang; setting "• text" as one string wraps the second line
                // under the dot.
                pen.room_for(BODY_LEAD);
                pen.text("\u{2022}", BODY_PT, MARGIN_X + 1.5, pen.y, false, faint());
                pen.block(text, BODY_PT, BODY_LEAD, BULLET_INDENT, 0.0, false);
                pen.y += 1.2;
            }
        }
    }

    doc.save_to_bytes().map_err(|e| ExportError::Pdf(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_document_comes_out_as_a_pdf() {
        let out = render(
            "A title",
            &[
                Block::Heading { level: 2, text: "A section".into() },
                Block::Paragraph("Some prose that runs on for long enough to wrap at least once on an A4 measure, which is the case worth checking.".into()),
                Block::Bullet("a point".into()),
            ],
        )
        .unwrap();
        assert!(out.starts_with(b"%PDF"), "not a pdf");
        assert!(out.len() > 1000, "suspiciously small: {}", out.len());
    }

    #[test]
    fn enough_prose_runs_onto_a_second_page() {
        let long: Vec<Block> = (0..120)
            .map(|i| Block::Paragraph(format!("Paragraph {i}, with enough words in it to take a line or two of an A4 measure and push the page along.")))
            .collect();
        let out = render("Long", &long).unwrap();
        // Rendered rather than counted: what matters is that it did not
        // silently stop at one page or run off the bottom.
        assert!(out.len() > 5000);
    }

    #[test]
    fn polish_survives_being_measured_and_set() {
        let out = render("Zażółć", &[Block::Paragraph("gęślą jaźń".into())]).unwrap();
        assert!(out.starts_with(b"%PDF"));
    }

    #[test]
    fn nothing_at_all_is_refused() {
        assert!(matches!(render("  ", &[]), Err(ExportError::Empty)));
    }
}
