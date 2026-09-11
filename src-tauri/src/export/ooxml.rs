//! Word documents and slide decks, written by hand.
//!
//! Both formats are a zip of XML parts with a fixed skeleton around them, so
//! this writes the skeleton once and puts the document's own words in the two
//! or three parts that actually vary. No library: the crates that do this
//! bring a build's worth of dependencies to produce files whose interesting
//! half — headings, bullets, slides — is thirty lines of XML either way.
//!
//! Everything below is the minimum a reader will accept. Both Word and
//! PowerPoint are strict about the relationship graph and forgiving about
//! almost everything else, which is why the rels files are the fiddly part
//! and the content is not.

use std::io::Write;

use zip::{write::SimpleFileOptions, ZipWriter};

use super::markdown::Block;

#[derive(Debug, thiserror::Error)]
pub enum ExportError {
    #[error("writing the file: {0}")]
    Io(#[from] std::io::Error),
    #[error("packing the document: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("setting the page: {0}")]
    Pdf(String),
    #[error("there is nothing here to write out yet")]
    Empty,
}

/// XML text escaping.
///
/// Every string below is somebody's own words, so all five predefined
/// entities go — an unescaped `&` in a transcript is enough to make the whole
/// document unreadable, and it is exactly the character a person types.
fn esc(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // A control character is not text and will be rejected by the
            // reader rather than shown. Tabs and newlines are handled by the
            // markup around this, not inside a run.
            c if (c as u32) < 0x20 => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

/// One file inside the archive.
struct Part {
    name: &'static str,
    body: String,
}

fn pack(parts: Vec<Part>) -> Result<Vec<u8>, ExportError> {
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut buf);
        // Deflate: what every reader expects, and the only codec compiled in.
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for part in parts {
            zip.start_file(part.name, options)?;
            zip.write_all(part.body.as_bytes())?;
        }
        zip.finish()?;
    }
    Ok(buf.into_inner())
}

const DECL: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#;

// ---------------------------------------------------------------- Word

/// A Word document: a title, then headings, paragraphs and bullets.
pub fn docx(title: &str, blocks: &[Block]) -> Result<Vec<u8>, ExportError> {
    if blocks.is_empty() && title.trim().is_empty() {
        return Err(ExportError::Empty);
    }

    let mut body = String::new();
    body.push_str(&para(title, "Title", false));
    for block in blocks {
        match block {
            Block::Heading { level, text } => {
                let style = match level {
                    1 => "Heading1",
                    2 => "Heading2",
                    _ => "Heading3",
                };
                body.push_str(&para(text, style, false));
            }
            Block::Paragraph(text) => body.push_str(&para(text, "Normal", false)),
            Block::Bullet(text) => body.push_str(&para(text, "ListParagraph", true)),
        }
    }

    let document = format!(
        r#"{DECL}
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>{body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>
<w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1418" w:header="709" w:footer="709" w:gutter="0"/>
</w:sectPr></w:body></w:document>"#
    );

    pack(vec![
        Part {
            name: "[Content_Types].xml",
            body: format!(
                r#"{DECL}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>"#
            ),
        },
        Part {
            name: "_rels/.rels",
            body: format!(
                r#"{DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#
            ),
        },
        Part {
            name: "word/_rels/document.xml.rels",
            body: format!(
                r#"{DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>"#
            ),
        },
        Part { name: "word/document.xml", body: document },
        Part { name: "word/styles.xml", body: docx_styles() },
        Part { name: "word/numbering.xml", body: docx_numbering() },
    ])
}

/// One Word paragraph in a named style.
fn para(text: &str, style: &str, bullet: bool) -> String {
    // The list reference is what makes a bullet a bullet; the style alone
    // only indents it.
    let numbering =
        if bullet { r#"<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>"# } else { "" };
    format!(
        r#"<w:p><w:pPr><w:pStyle w:val="{style}"/>{numbering}</w:pPr><w:r><w:t xml:space="preserve">{}</w:t></w:r></w:p>"#,
        esc(text)
    )
}

fn docx_styles() -> String {
    // Sizes are half-points: 48 is 24pt. Only what the document uses is
    // defined — a reader supplies its own defaults for everything else.
    let heading = |id: &str, name: &str, size: u32, before: u32| {
        format!(
            r#"<w:style w:type="paragraph" w:styleId="{id}"><w:name w:val="{name}"/>
<w:pPr><w:keepNext/><w:spacing w:before="{before}" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="{size}"/><w:szCs w:val="{size}"/></w:rPr></w:style>"#
        )
    };
    format!(
        r#"{DECL}
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>
<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
{}{}{}
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/>
<w:pPr><w:spacing w:after="280"/></w:pPr>
<w:rPr><w:b/><w:sz w:val="56"/><w:szCs w:val="56"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/>
<w:pPr><w:ind w:left="720"/><w:contextualSpacing/><w:spacing w:after="80"/></w:pPr></w:style>
</w:styles>"#,
        heading("Heading1", "heading 1", 40, 360),
        heading("Heading2", "heading 2", 32, 280),
        heading("Heading3", "heading 3", 26, 240),
    )
}

fn docx_numbering() -> String {
    format!(
        r#"{DECL}
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#8226;"/>
<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr></w:lvl>
</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>"#
    )
}

// -------------------------------------------------------------- Slides

/// How many lines a slide will hold before the rest go to another one.
///
/// The instruction asks the model for at most five. It does not always
/// listen, and a slide with fourteen lines on it is not a slide — so a long
/// one is continued rather than set in type nobody can read from the back of
/// a room.
const LINES_PER_SLIDE: usize = 6;

/// A slide deck: a title slide, then one slide per heading.
pub fn pptx(title: &str, slides: &[(String, Vec<String>)]) -> Result<Vec<u8>, ExportError> {
    if slides.is_empty() && title.trim().is_empty() {
        return Err(ExportError::Empty);
    }

    // Split anything too long to be a slide before anything is numbered, so
    // the ids and the relationships are counted off the real list.
    let mut laid: Vec<(String, Vec<String>)> = Vec::new();
    for (head, lines) in slides {
        if lines.len() <= LINES_PER_SLIDE {
            laid.push((head.clone(), lines.clone()));
            continue;
        }
        for (n, chunk) in lines.chunks(LINES_PER_SLIDE).enumerate() {
            let head = if n == 0 { head.clone() } else { format!("{head} (cont.)") };
            laid.push((head, chunk.to_vec()));
        }
    }

    let mut parts: Vec<Part> = Vec::new();
    let mut slide_types = String::new();
    let mut slide_ids = String::new();
    let mut presentation_rels = String::new();

    // The title slide is slide 1; the rest follow. Leaking the deck's name
    // onto every slide would be a footer, which is not what a title is.
    let mut bodies: Vec<String> = vec![title_slide(title)];
    for (head, lines) in &laid {
        bodies.push(content_slide(head, lines));
    }

    for (i, body) in bodies.iter().enumerate() {
        let n = i + 1;
        // Ids 1 and 2 belong to the master and the theme, so slides start at 3.
        let rid = n + 2;
        parts.push(Part { name: leak(format!("ppt/slides/slide{n}.xml")), body: body.clone() });
        parts.push(Part {
            name: leak(format!("ppt/slides/_rels/slide{n}.xml.rels")),
            body: format!(
                r#"{DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>"#
            ),
        });
        slide_types.push_str(&format!(
            r#"<Override PartName="/ppt/slides/slide{n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>"#
        ));
        // The slide's own id must be at least 256; the relationship id is
        // separate and is what points at the part.
        slide_ids.push_str(&format!(r#"<p:sldId id="{}" r:id="rId{rid}"/>"#, 255 + n));
        presentation_rels.push_str(&format!(
            r#"<Relationship Id="rId{rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide{n}.xml"/>"#
        ));
    }

    parts.push(Part {
        name: "[Content_Types].xml",
        body: format!(
            r#"{DECL}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
{slide_types}</Types>"#
        ),
    });
    parts.push(Part {
        name: "_rels/.rels",
        body: format!(
            r#"{DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>"#
        ),
    });
    parts.push(Part {
        name: "ppt/presentation.xml",
        body: format!(
            r#"{DECL}
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst>{slide_ids}</p:sldIdLst>
<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>"#
        ),
    });
    parts.push(Part {
        name: "ppt/_rels/presentation.xml.rels",
        body: format!(
            r#"{DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
{presentation_rels}</Relationships>"#
        ),
    });
    parts.push(Part { name: "ppt/slideMasters/slideMaster1.xml", body: slide_master() });
    parts.push(Part {
        name: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
        body: format!(
            r#"{DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>"#
        ),
    });
    parts.push(Part { name: "ppt/slideLayouts/slideLayout1.xml", body: slide_layout() });
    parts.push(Part {
        name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
        body: format!(
            r#"{DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>"#
        ),
    });
    parts.push(Part { name: "ppt/theme/theme1.xml", body: theme() });

    pack(parts)
}

/// Part names are `&'static str` because the fixed ones are literals; the
/// slides' are built per deck. Leaking a handful of short strings per export
/// is cheaper than threading a lifetime through the whole part list for it.
fn leak(name: String) -> &'static str {
    Box::leak(name.into_boxed_str())
}

/// Where a shape sits on the slide, in EMU — the unit the format counts in.
///
/// A struct rather than four more arguments: the two frames every slide uses
/// are the same two every time, so they are named once below and passed
/// around as one thing. Not `Box` — that name is taken, and `Box::leak` is
/// used a few lines down.
#[derive(Clone, Copy)]
struct Frame {
    x: i64,
    y: i64,
    cx: i64,
    cy: i64,
}

/// The title's box, and the body's, on a 12192000 x 6858000 slide.
const TITLE_BOX: Frame = Frame { x: 838200, y: 457200, cx: 10515600, cy: 1143000 };
const BODY_BOX: Frame = Frame { x: 838200, y: 1825625, cx: 10515600, cy: 4351338 };
/// A title slide's one box, sitting on the middle of the slide instead.
const CENTRE_BOX: Frame = Frame { x: 838200, y: 2600325, cx: 10515600, cy: 1655762 };

/// The XML common to every shape on a slide.
fn shape(id: u32, name: &str, ph: &str, at: Frame, body: &str) -> String {
    let Frame { x, y, cx, cy } = at;
    format!(
        r#"<p:sp><p:nvSpPr><p:cNvPr id="{id}" name="{name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>
<p:nvPr>{ph}</p:nvPr></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm></p:spPr>
<p:txBody><a:bodyPr wrap="square"><a:normAutofit/></a:bodyPr><a:lstStyle/>{body}</p:txBody></p:sp>"#
    )
}

fn slide(shapes: &str) -> String {
    format!(
        r#"{DECL}
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
{shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"#
    )
}

fn title_slide(title: &str) -> String {
    let body = format!(
        r#"<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="en-US" sz="4400" b="1" dirty="0"/><a:t>{}</a:t></a:r></a:p>"#,
        esc(title)
    );
    slide(&shape(2, "Title", r#"<p:ph type="ctrTitle"/>"#, CENTRE_BOX, &body))
}

fn content_slide(head: &str, lines: &[String]) -> String {
    let title = format!(
        r#"<a:p><a:r><a:rPr lang="en-US" sz="3200" b="1" dirty="0"/><a:t>{}</a:t></a:r></a:p>"#,
        esc(head)
    );
    // An empty paragraph list is not valid; a slide with a heading and
    // nothing under it gets one blank line rather than a malformed part.
    let mut body = String::new();
    if lines.is_empty() {
        body.push_str(r#"<a:p><a:endParaRPr lang="en-US"/></a:p>"#);
    }
    for line in lines {
        body.push_str(&format!(
            r#"<a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US" sz="2000" dirty="0"/><a:t>{}</a:t></a:r></a:p>"#,
            esc(line)
        ));
    }
    slide(&format!(
        "{}{}",
        shape(2, "Title", r#"<p:ph type="title"/>"#, TITLE_BOX, &title),
        shape(3, "Content", r#"<p:ph idx="1"/>"#, BODY_BOX, &body),
    ))
}

fn placeholder(id: u32, name: &str, ph: &str, at: Frame) -> String {
    shape(id, name, ph, at, r#"<a:p><a:endParaRPr lang="en-US"/></a:p>"#)
}

fn slide_layout() -> String {
    format!(
        r#"{DECL}
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="obj" preserve="1">
<p:cSld name="Title and Content"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
{}{}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"#,
        placeholder(2, "Title", r#"<p:ph type="title"/>"#, TITLE_BOX),
        placeholder(3, "Content", r#"<p:ph idx="1"/>"#, BODY_BOX),
    )
}

fn slide_master() -> String {
    format!(
        r#"{DECL}
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
{}{}</p:spTree></p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle>
<p:bodyStyle><a:lvl1pPr marL="342900" indent="-342900"><a:buChar char="&#8226;"/><a:defRPr sz="2000"/></a:lvl1pPr></p:bodyStyle>
<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles>
</p:sldMaster>"#,
        placeholder(2, "Title", r#"<p:ph type="title"/>"#, TITLE_BOX),
        placeholder(3, "Content", r#"<p:ph type="body" idx="1"/>"#, BODY_BOX),
    )
}

/// The theme. Required by the format and almost entirely uninteresting: a
/// reader refuses a deck without one, and nothing here is chosen for how it
/// looks beyond "black text on white, in a font every machine has".
fn theme() -> String {
    let scheme = |n: &str, hex: &str| format!(r#"<a:{n}><a:srgbClr val="{hex}"/></a:{n}>"#);
    format!(
        r#"{DECL}
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Plain">
<a:themeElements>
<a:clrScheme name="Plain"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
{}{}{}{}{}{}{}{}{}{}
</a:clrScheme>
<a:fontScheme name="Plain">
<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
</a:fontScheme>
<a:fmtScheme name="Plain">
<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>
</a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>"#,
        scheme("dk2", "44546A"),
        scheme("lt2", "E7E6E6"),
        scheme("accent1", "4472C4"),
        scheme("accent2", "ED7D31"),
        scheme("accent3", "A5A5A5"),
        scheme("accent4", "FFC000"),
        scheme("accent5", "5B9BD5"),
        scheme("accent6", "70AD47"),
        scheme("hlink", "0563C1"),
        scheme("folHlink", "954F72"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_characters_a_person_actually_types_are_escaped() {
        assert_eq!(
            esc("R&D <one> \"two\" 'three'"),
            "R&amp;D &lt;one&gt; &quot;two&quot; &apos;three&apos;"
        );
    }

    #[test]
    fn a_control_character_becomes_a_space_rather_than_an_unreadable_file() {
        assert_eq!(esc("a\u{0}b"), "a b");
    }

    #[test]
    fn a_word_document_is_a_zip_with_the_parts_a_reader_looks_for() {
        let out = docx("A title", &[Block::Paragraph("some prose".into())]).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(out)).unwrap();
        let names: Vec<String> =
            (0..zip.len()).map(|i| zip.by_index(i).unwrap().name().to_string()).collect();
        for wanted in ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml"]
        {
            assert!(names.contains(&wanted.to_string()), "{wanted} missing from {names:?}");
        }
    }

    #[test]
    fn a_deck_has_one_part_per_slide_plus_the_title_slide() {
        let out =
            pptx("Deck", &[("One".into(), vec!["a".into()]), ("Two".into(), vec!["b".into()])])
                .unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(out)).unwrap();
        let names: Vec<String> =
            (0..zip.len()).map(|i| zip.by_index(i).unwrap().name().to_string()).collect();
        let slides = names.iter().filter(|n| n.starts_with("ppt/slides/slide")).count();
        assert_eq!(slides, 3, "title slide plus two: {names:?}");
        assert!(names.contains(&"ppt/presentation.xml".to_string()));
        assert!(names.contains(&"ppt/theme/theme1.xml".to_string()));
    }

    #[test]
    fn a_slide_with_too_many_lines_is_continued_rather_than_crammed() {
        let many: Vec<String> = (0..14).map(|i| format!("line {i}")).collect();
        let out = pptx("Deck", &[("Long".into(), many)]).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(out)).unwrap();
        let names: Vec<String> =
            (0..zip.len()).map(|i| zip.by_index(i).unwrap().name().to_string()).collect();
        let slides = names.iter().filter(|n| n.starts_with("ppt/slides/slide")).count();
        // Fourteen lines at six a slide is three, plus the title slide.
        assert_eq!(slides, 4, "{names:?}");
    }

    #[test]
    fn nothing_at_all_is_refused_rather_than_written_as_an_empty_file() {
        assert!(matches!(docx("", &[]), Err(ExportError::Empty)));
        assert!(matches!(pptx("  ", &[]), Err(ExportError::Empty)));
    }
}
