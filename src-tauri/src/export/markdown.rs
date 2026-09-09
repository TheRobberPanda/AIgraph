//! What a model wrote, read as a document rather than as a string.
//!
//! Every format below starts here. The model is asked for markdown whatever
//! was chosen — it is the one shape every model writes well, and asking a
//! language model to emit a zip archive it has only ever read about is not a
//! feature. So this is the narrow place where "what it wrote" becomes
//! "headings, paragraphs and bullets", and each writer works from that.
//!
//! Deliberately a small subset. Headings, paragraphs and bullets are what the
//! instructions ask for; tables, footnotes and nested lists are not, and half
//! a markdown parser that silently mangles the other half is worse than one
//! that only claims to do three things.

/// One piece of a document, in the order it was written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Block {
    /// `level` is 1 for `#`, 2 for `##`, and so on, capped at 3 — past that a
    /// heading is not doing anything a paragraph would not.
    Heading { level: u8, text: String },
    Paragraph(String),
    Bullet(String),
}

/// Strip the inline marks a writer cannot use.
///
/// Bold and italic runs would have to survive as spans through three
/// different writers to be worth keeping; carrying the asterisks through
/// instead would put them on the page. So they come off, and the words stay.
fn plain(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            // `**bold**`, `*italic*`, `_italic_`, `` `code` ``.
            '*' | '_' | '`' => i += 1,
            // `[label](url)` keeps the label: the url is not readable on a
            // printed page and the label is what was being said.
            '[' => {
                let close = chars[i..].iter().position(|c| *c == ']');
                let Some(close) = close else {
                    out.push('[');
                    i += 1;
                    continue;
                };
                let label: String = chars[i + 1..i + close].iter().collect();
                out.push_str(&label);
                i += close + 1;
                // Drop the target, if one follows.
                if chars.get(i) == Some(&'(') {
                    if let Some(end) = chars[i..].iter().position(|c| *c == ')') {
                        i += end + 1;
                    }
                }
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    out.trim().to_string()
}

/// Read markdown into blocks.
pub fn parse(text: &str) -> Vec<Block> {
    let mut out: Vec<Block> = Vec::new();
    // Paragraph lines are gathered until a blank line or a different kind of
    // line ends them: a paragraph broken across three source lines is one
    // paragraph, and setting it as three would put ragged breaks mid-sentence.
    let mut para: Vec<String> = Vec::new();

    /// Close whatever paragraph was being gathered.
    fn flush(para: &mut Vec<String>, out: &mut Vec<Block>) {
        if para.is_empty() {
            return;
        }
        let joined = para.join(" ");
        para.clear();
        let text = plain(&joined);
        if !text.is_empty() {
            out.push(Block::Paragraph(text));
        }
    }

    let mut fenced = false;
    for raw in text.lines() {
        let line = raw.trim_end();
        let trimmed = line.trim_start();

        // A fenced block is not prose. Its contents go in as paragraphs
        // rather than being dropped — a model that put the answer in a fence
        // has still answered — but the fence markers themselves do not.
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            flush(&mut para, &mut out);
            fenced = !fenced;
            continue;
        }
        if fenced {
            if !trimmed.is_empty() {
                out.push(Block::Paragraph(trimmed.to_string()));
            }
            continue;
        }

        if trimmed.is_empty() {
            flush(&mut para, &mut out);
            continue;
        }

        if let Some(rest) = heading(trimmed) {
            flush(&mut para, &mut out);
            let (level, body) = rest;
            let body = plain(body);
            if !body.is_empty() {
                out.push(Block::Heading { level, text: body });
            }
            continue;
        }

        if let Some(item) = bullet(trimmed) {
            flush(&mut para, &mut out);
            let item = plain(item);
            if !item.is_empty() {
                out.push(Block::Bullet(item));
            }
            continue;
        }

        // A horizontal rule is a break, not a word.
        if trimmed.chars().all(|c| c == '-' || c == '*' || c == '_') && trimmed.len() >= 3 {
            flush(&mut para, &mut out);
            continue;
        }

        para.push(trimmed.to_string());
    }
    flush(&mut para, &mut out);
    out
}

/// `#`, `##`, `###` — and the text after it.
fn heading(line: &str) -> Option<(u8, &str)> {
    let hashes = line.chars().take_while(|c| *c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = line[hashes..].strip_prefix(' ')?;
    Some((hashes.min(3) as u8, rest))
}

/// `- `, `* `, `1. ` — and the text after it.
fn bullet(line: &str) -> Option<&str> {
    for mark in ["- ", "* ", "+ "] {
        if let Some(rest) = line.strip_prefix(mark) {
            return Some(rest.trim_start());
        }
    }
    // A numbered item is still an item; the number is regenerated by whoever
    // sets it, and keeping the model's own numbering means keeping its
    // mistakes in it.
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 && digits <= 3 {
        for mark in [". ", ") "] {
            if let Some(rest) = line[digits..].strip_prefix(mark) {
                return Some(rest.trim_start());
            }
        }
    }
    None
}

/// The document's title, and everything after it.
///
/// The instructions ask for a `# Title` on the first line. When one is there
/// it names the file and the deck rather than becoming the first heading of
/// the body; when it is not, the caller's own name for the thing is used and
/// nothing is thrown away.
pub fn split_title(blocks: &[Block], fallback: &str) -> (String, Vec<Block>) {
    if let Some(Block::Heading { level: 1, text }) = blocks.first() {
        return (text.clone(), blocks[1..].to_vec());
    }
    (fallback.trim().to_string(), blocks.to_vec())
}

/// Blocks grouped into slides: a heading and whatever follows it.
///
/// Anything written before the first heading is its own opening slide rather
/// than being dropped — a model that opened with a sentence has still said
/// something, and losing it silently is the worse failure.
pub fn slides(blocks: &[Block]) -> Vec<(String, Vec<String>)> {
    let mut out: Vec<(String, Vec<String>)> = Vec::new();
    for block in blocks {
        match block {
            Block::Heading { text, .. } => out.push((text.clone(), Vec::new())),
            Block::Bullet(text) | Block::Paragraph(text) => {
                if let Some(last) = out.last_mut() {
                    last.1.push(text.clone());
                } else {
                    out.push((String::new(), vec![text.clone()]));
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headings_paragraphs_and_bullets_are_told_apart() {
        let b = parse("# Title\n\nSome prose.\n\n## Next\n\n- one\n- two\n");
        assert_eq!(
            b,
            vec![
                Block::Heading { level: 1, text: "Title".into() },
                Block::Paragraph("Some prose.".into()),
                Block::Heading { level: 2, text: "Next".into() },
                Block::Bullet("one".into()),
                Block::Bullet("two".into()),
            ]
        );
    }

    #[test]
    fn a_paragraph_split_across_lines_is_one_paragraph() {
        let b = parse("the thought went\non for a while\n\nand then stopped");
        assert_eq!(
            b,
            vec![
                Block::Paragraph("the thought went on for a while".into()),
                Block::Paragraph("and then stopped".into()),
            ]
        );
    }

    #[test]
    fn inline_marks_come_off_rather_than_onto_the_page() {
        assert_eq!(plain("**bold** and *thin* and `code`"), "bold and thin and code");
        assert_eq!(plain("see [the note](https://example.com) for it"), "see the note for it");
        // An unclosed bracket is text, not a parse error.
        assert_eq!(plain("a [ b"), "a [ b");
    }

    #[test]
    fn numbered_items_keep_their_words_and_lose_their_numbers() {
        let b = parse("1. first\n2. second");
        assert_eq!(b, vec![Block::Bullet("first".into()), Block::Bullet("second".into())]);
    }

    #[test]
    fn a_fenced_block_keeps_its_contents_and_drops_its_fence() {
        let b = parse("```\nkept\n```");
        assert_eq!(b, vec![Block::Paragraph("kept".into())]);
    }

    #[test]
    fn the_title_is_taken_off_the_front_when_there_is_one() {
        let b = parse("# Real title\n\nbody");
        let (title, rest) = split_title(&b, "fallback");
        assert_eq!(title, "Real title");
        assert_eq!(rest, vec![Block::Paragraph("body".into())]);
    }

    #[test]
    fn without_a_title_nothing_is_taken_off_the_front() {
        let b = parse("body only");
        let (title, rest) = split_title(&b, "fallback");
        assert_eq!(title, "fallback");
        assert_eq!(rest.len(), 1);
    }

    #[test]
    fn slides_gather_what_follows_each_heading() {
        let b = parse("## One\n\n- a\n- b\n\n## Two\n\n- c");
        assert_eq!(
            slides(&b),
            vec![
                ("One".to_string(), vec!["a".to_string(), "b".to_string()]),
                ("Two".to_string(), vec!["c".to_string()]),
            ]
        );
    }

    #[test]
    fn words_before_the_first_heading_get_a_slide_rather_than_being_lost() {
        let s = slides(&parse("an opening line\n\n## One\n\n- a"));
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].0, "");
        assert_eq!(s[0].1, vec!["an opening line".to_string()]);
    }
}
