import { jsPDF } from 'jspdf';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Job, deriveTailoredFileName } from '../domain';

/** Render a job's tailored resume as a clean ATS-style PDF (single column,
 *  plain text lines, standard margins) and download it as
 *  `<tailoredFileName>.pdf`. */
export function downloadTailoredResumePdf(job: Job): void {
  const text = (job.tailoredResumeText ?? '').replace(/\r\n/g, '\n');
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 54; // 0.75 inch
  const lineHeight = 15;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);

  let y = margin;
  const ensureSpace = () => {
    if (y > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }
  };

  for (const rawLine of text.split('\n')) {
    if (rawLine.trim() === '') {
      y += lineHeight * 0.6;
      ensureSpace();
      continue;
    }
    const wrapped = doc.splitTextToSize(rawLine, pageWidth - margin * 2) as string[];
    for (const line of wrapped) {
      ensureSpace();
      doc.text(line, margin, y);
      y += lineHeight;
    }
  }

  const fileName = job.tailoredFileName?.trim() || deriveTailoredFileName(job.company);
  doc.save(`${fileName}.pdf`);
}

/** Extract plain text from an uploaded master resume file:
 *  .pdf via pdfjs-dist, .docx via mammoth, .txt/.md read directly. */
export async function extractResumeText(file: File): Promise<string> {
  const name = file.name.toLowerCase();

  if (name.endsWith('.txt') || name.endsWith('.md')) {
    return (await file.text()).trim();
  }

  if (name.endsWith('.docx')) {
    const mammoth = await import('mammoth');
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    return result.value.trim();
  }

  if (name.endsWith('.pdf')) {
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    const data = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const line = content.items
        .map((item) => ('str' in item ? (item as { str: string }).str : ''))
        .join(' ');
      pages.push(line);
    }
    return pages.join('\n').trim();
  }

  throw new Error('Unsupported file type — upload a .pdf, .docx, .txt, or .md file.');
}
