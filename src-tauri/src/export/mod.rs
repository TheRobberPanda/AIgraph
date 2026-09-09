//! Turning what a model wrote into the kind of file it was asked for.
//!
//! The Make tab's instructions carry a format — a deck, a document, a page to
//! print — and that format reaches the model, which writes markdown shaped
//! accordingly. This is the other half: the same markdown read back into
//! blocks and set as a PDF, a Word document or a slide deck.
//!
//! Deliberately one direction only. Nothing here is written back into the
//! record, for the same reason nothing in `crate::compose` is: a model asked
//! to write a deck is not producing something traceable to a sentence
//! somebody said, and only that kind of thing belongs in the map.

pub mod markdown;
pub mod ooxml;
pub mod pdf;

pub use ooxml::ExportError;

use crate::settings::OutputFormat;

/// Write an answer out in the format its instruction asked for.
///
/// `title` is what to call the thing when the model did not open with a
/// `# heading` of its own — the name of the button that was pressed, usually,
/// which is at least a description of what was wanted.
pub fn render(text: &str, format: OutputFormat, title: &str) -> Result<Vec<u8>, ExportError> {
    let blocks = markdown::parse(text);
    let (title, body) = markdown::split_title(&blocks, title);

    match format {
        // The model already wrote markdown. Re-emitting it from the parsed
        // blocks would throw away the emphasis and the exact line breaks for
        // nothing — the whole point of this format is that it is the text.
        OutputFormat::Markdown => Ok(text.as_bytes().to_vec()),
        OutputFormat::Pdf => pdf::render(&title, &body),
        OutputFormat::Docx => ooxml::docx(&title, &body),
        OutputFormat::Pptx => ooxml::pptx(&title, &markdown::slides(&body)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ANSWER: &str = "# What it is\n\n## First\n\n- one\n- two\n\n## Second\n\nSome prose.\n";

    #[test]
    fn markdown_comes_back_exactly_as_written() {
        let out = render(ANSWER, OutputFormat::Markdown, "unused").unwrap();
        assert_eq!(String::from_utf8(out).unwrap(), ANSWER);
    }

    #[test]
    fn every_other_format_produces_a_file_of_its_own_kind() {
        assert!(render(ANSWER, OutputFormat::Pdf, "x").unwrap().starts_with(b"%PDF"));
        // Both OOXML formats are zips, which start "PK".
        assert!(render(ANSWER, OutputFormat::Docx, "x").unwrap().starts_with(b"PK"));
        assert!(render(ANSWER, OutputFormat::Pptx, "x").unwrap().starts_with(b"PK"));
    }

    #[test]
    fn the_models_own_title_is_used_when_it_wrote_one() {
        // Reaching into the deck to check would mean unzipping it; that the
        // title is taken off the front is `split_title`'s own test. This only
        // checks the two paths agree that there is one.
        let (title, body) = markdown::split_title(&markdown::parse(ANSWER), "fallback");
        assert_eq!(title, "What it is");
        assert_eq!(markdown::slides(&body).len(), 2);
    }
}
