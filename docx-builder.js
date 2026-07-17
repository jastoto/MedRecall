// Builds a minimal, valid .docx file client-side using JSZip (loaded via CDN
// in index.html). Produces plain paragraphs — a title, a small metadata
// block (doctor / visit type / reason / date), a "Transcript" heading, and
// the transcript itself split into paragraphs on line breaks.
const DocxBuilder = (() => {
  function escapeXml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function paragraph(text, { bold = false, size = 22 } = {}) {
    const runProps = `<w:rPr>${bold ? "<w:b/>" : ""}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>`;
    const safe = escapeXml(text);
    return `<w:p><w:r>${runProps}<w:t xml:space="preserve">${safe}</w:t></w:r></w:p>`;
  }

  function emptyParagraph() {
    return `<w:p/>`;
  }

  async function build({ doctorName, visitType, reason, date, title, transcript }) {
    const dateString = date.toLocaleString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });

    const bodyParts = [];
    bodyParts.push(paragraph(title, { bold: true, size: 36 }));
    bodyParts.push(emptyParagraph());
    bodyParts.push(paragraph(`Doctor: ${doctorName}`, { bold: true }));
    bodyParts.push(paragraph(`Visit type: ${visitType}`));
    if (reason) {
      bodyParts.push(paragraph(`Reason: ${reason}`));
    }
    bodyParts.push(paragraph(`Date: ${dateString}`));
    bodyParts.push(emptyParagraph());
    bodyParts.push(paragraph("Transcript", { bold: true, size: 26 }));
    bodyParts.push(emptyParagraph());

    const body = transcript && transcript.trim() ? transcript : "(No transcript captured.)";
    const paragraphs = body.split(/\r?\n/);
    for (const line of paragraphs) {
      if (line.trim().length === 0) {
        bodyParts.push(emptyParagraph());
      } else {
        bodyParts.push(paragraph(line));
      }
    }

    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${bodyParts.join("\n    ")}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;

    const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

    const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

    const docRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`;

    const zip = new JSZip();
    zip.file("[Content_Types].xml", contentTypesXml);
    zip.folder("_rels").file(".rels", rootRelsXml);
    const wordFolder = zip.folder("word");
    wordFolder.file("document.xml", documentXml);
    wordFolder.folder("_rels").file("document.xml.rels", docRelsXml);

    return zip.generateAsync({
      type: "blob",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    });
  }

  return { build };
})();

if (typeof module !== "undefined") module.exports = DocxBuilder;
