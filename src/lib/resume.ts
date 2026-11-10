import { jsPDF } from 'jspdf';
import type { Paragraph as DocxParagraph } from 'docx';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Job, MasterResume, deriveTailoredFileName } from '../domain';

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

/* ------------------------------------------------------------------ */
/* Master resume downloads (Resumes view)                              */
/* ------------------------------------------------------------------ */

/** File-safe slug from a master resume's label, e.g. "demo-frontend". */
export function masterResumeSlug(label: string): string {
  return (
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'resume'
  );
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

type ResumeBlock =
  | { kind: 'title'; text: string }
  | { kind: 'subtitle'; text: string }
  | { kind: 'contact'; text: string }
  | { kind: 'heading'; text: string }
  | { kind: 'job'; text: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'text'; text: string };

const SECTION_HEADERS = [
  'SUMMARY',
  'SKILLS',
  'WORK EXPERIENCE',
  'EDUCATION',
  'INDEPENDENT PROJECTS',
];

function isHeading(line: string): boolean {
  if (line.length > 60 || line.includes('@')) return false;
  if (SECTION_HEADERS.includes(line)) return true;
  return /^[A-Z0-9][A-Z0-9 &|().,/-]{2,}$/.test(line);
}

function isJobHeader(line: string): boolean {
  return line.includes(' | ') && (/\b(19|20)\d\d\b/.test(line) || line.includes('Present') || line.includes('Remote'));
}

/** Split stored resume text into logical lines. Uploaded PDFs often extract
 *  as one flat run with double spaces standing in for line breaks, so section
 *  headers and bullets are also split out before classifying. */
export function parseResumeLines(raw: string): ResumeBlock[] {
  let text = (raw ?? '').replace(/\r\n/g, '\n');
  text = text.replace(/ {2,}/g, '\n');
  text = text.replace(/●/g, '\n●');
  for (const h of SECTION_HEADERS) {
    text = text.replace(new RegExp(`(?<!\\n)${h}(?=\\s)`, 'g'), `\n${h}`);
  }
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.map((line, i): ResumeBlock => {
    if (i === 0) return { kind: 'title', text: line };
    if (line.startsWith('●')) return { kind: 'bullet', text: line.replace(/^●\s*/, '') };
    if (isHeading(line)) return { kind: 'heading', text: line };
    if (line.includes('@')) return { kind: 'contact', text: line };
    if (isJobHeader(line)) return { kind: 'job', text: line };
    if (i === 1) return { kind: 'subtitle', text: line };
    return { kind: 'text', text: line };
  });
}

/** Download a master resume as the stored text in a .txt file. */
export function downloadMasterResumeTxt(resume: MasterResume): void {
  saveBlob(
    new Blob([resume.text], { type: 'text/plain;charset=utf-8' }),
    `${masterResumeSlug(resume.label)}.txt`,
  );
}

/** Download a master resume as a clean ATS-style PDF (same letter layout
 *  as the tailored-resume PDF). Sized to fit a one-page resume: 10.5pt body,
 *  tight leading, 0.625in margins. */
export function downloadMasterResumePdf(resume: MasterResume): void {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 45; // 0.625 inch
  const lineHeight = 13.5;

  let y = margin;
  const ensureSpace = () => {
    if (y > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }
  };
  const write = (
    line: string,
    opts: { size?: number; bold?: boolean; indent?: number; gapBefore?: number } = {},
  ) => {
    if (opts.gapBefore) y += opts.gapBefore;
    doc.setFont('helvetica', opts.bold ? 'bold' : 'normal');
    doc.setFontSize(opts.size ?? 10.5);
    const wrapped = doc.splitTextToSize(line, pageWidth - margin * 2 - (opts.indent ?? 0)) as string[];
    for (const w of wrapped) {
      ensureSpace();
      doc.text(w, margin + (opts.indent ?? 0), y);
      y += lineHeight;
    }
  };

  for (const block of parseResumeLines(resume.text)) {
    switch (block.kind) {
      case 'title':
        write(block.text, { size: 15, bold: true });
        break;
      case 'subtitle':
        write(block.text, { size: 11.5, bold: true });
        y += 2;
        break;
      case 'contact':
        write(block.text, {});
        y += 3;
        break;
      case 'heading':
        write(block.text, { size: 11.5, bold: true, gapBefore: 6 });
        break;
      case 'job':
        write(block.text, { bold: true, gapBefore: 3 });
        break;
      case 'bullet':
        write(`•  ${block.text}`, { indent: 18 });
        break;
      default:
        write(block.text, {});
    }
  }

  doc.save(`${masterResumeSlug(resume.label)}.pdf`);
}

/** Download a master resume as a real .docx (Word) document with headings,
 *  bold job lines and bullets rebuilt from the stored text. Sized to fit a
 *  one-page resume: 10.5pt body, tight spacing, 0.5in margins. */
export async function downloadMasterResumeDocx(resume: MasterResume): Promise<void> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = await import('docx');
  const children: DocxParagraph[] = [];
  for (const block of parseResumeLines(resume.text)) {
    switch (block.kind) {
      case 'title':
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 40 },
            children: [new TextRun({ text: block.text, bold: true, size: 26 })],
          }),
        );
        break;
      case 'subtitle':
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 80 },
            children: [new TextRun({ text: block.text, bold: true, size: 22 })],
          }),
        );
        break;
      case 'contact':
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 180 },
            children: [new TextRun({ text: block.text, size: 19 })],
          }),
        );
        break;
      case 'heading':
        children.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 180, after: 60 },
            children: [new TextRun({ text: block.text, bold: true, size: 22 })],
          }),
        );
        break;
      case 'job':
        children.push(
          new Paragraph({
            spacing: { before: 80, after: 20 },
            children: [new TextRun({ text: block.text, bold: true, size: 21 })],
          }),
        );
        break;
      case 'bullet':
        children.push(
          new Paragraph({
            bullet: { level: 0 },
            spacing: { after: 20 },
            children: [new TextRun({ text: block.text, size: 21 })],
          }),
        );
        break;
      default:
        children.push(
          new Paragraph({
            spacing: { after: 40 },
            children: [new TextRun({ text: block.text, size: 21 })],
          }),
        );
    }
  }
  const doc = new Document({
    sections: [
      {
        properties: {
          page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } },
        },
        children,
      },
    ],
  });
  saveBlob(await Packer.toBlob(doc), `${masterResumeSlug(resume.label)}.docx`);
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
