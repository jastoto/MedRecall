// Builds a simple, paginated PDF version of a visit using jsPDF (loaded via
// CDN in index.html). Mirrors the same fields as docx-builder.js.
const PdfBuilder = (() => {
  function build({ doctorName, visitType, reason, date, title, transcript }) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const marginLeft = 14;
    const maxWidth = 182;
    const pageHeight = doc.internal.pageSize.getHeight();
    const bottomMargin = 20;
    let y = 20;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.text(title, marginLeft, y);
    y += 10;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text(`Doctor: ${doctorName}`, marginLeft, y);
    y += 7;

    doc.setFont("helvetica", "normal");
    doc.text(`Visit type: ${visitType}`, marginLeft, y);
    y += 7;
    if (reason) {
      doc.text(`Reason: ${reason}`, marginLeft, y);
      y += 7;
    }

    const dateString = date.toLocaleString("en-US", {
      year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit"
    });
    doc.text(`Date: ${dateString}`, marginLeft, y);
    y += 12;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text("Transcript", marginLeft, y);
    y += 8;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    const body = transcript && transcript.trim() ? transcript : "(No transcript captured.)";
    const paragraphs = body.split(/\r?\n/).filter((p) => p.length > 0);

    for (const para of paragraphs) {
      const lines = doc.splitTextToSize(para, maxWidth);
      for (const line of lines) {
        if (y > pageHeight - bottomMargin) {
          doc.addPage();
          y = 20;
        }
        doc.text(line, marginLeft, y);
        y += 6;
      }
      y += 3;
    }

    return doc.output("blob");
  }

  return { build };
})();

if (typeof module !== "undefined") module.exports = PdfBuilder;
