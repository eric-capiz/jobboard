import { useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { AnimatePresence, motion } from 'framer-motion';
import {
  IMPORT_FIELD_LABELS,
  ImportField,
  ImportRow,
  autoMapHeaders,
  dedupeImportRows,
} from '../domain';
import { useStore } from '../store';
import { Button, Modal, Select } from './ui';

interface ParsedSheet {
  headers: string[];
  rows: string[][];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseSpreadsheet(file: File): Promise<ParsedSheet> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = reader.result as ArrayBuffer;
        const wb = XLSX.read(data, { type: 'array' });
        // Prefer a sheet named "Jobs"; otherwise fall back to the first sheet.
        const sheetName =
          wb.SheetNames.find((n) => n.trim().toLowerCase() === 'jobs') ?? wb.SheetNames[0];
        if (!sheetName) throw new Error('empty');
        const ws = wb.Sheets[sheetName];
        const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1');
        const aoa: string[][] = [];
        for (let r = range.s.r; r <= range.e.r; r++) {
          const row: string[] = [];
          for (let c = range.s.c; c <= range.e.c; c++) {
            const addr = XLSX.utils.encode_cell({ r, c });
            const cell = ws[addr] as { v?: unknown; l?: { Target?: string } } | undefined;
            // Cells with "link" text hyperlinked to the real URL resolve to the URL.
            const raw = cell?.l?.Target
              ? decodeEntities(String(cell.l.Target))
              : String(cell?.v ?? '').trim();
            row.push(raw);
          }
          aoa.push(row);
        }
        const nonEmpty = aoa.filter((r) => r.some((c) => String(c).trim() !== ''));
        if (nonEmpty.length === 0) throw new Error('empty');
        const headers = nonEmpty[0].map((h) => String(h).trim());
        const rows = nonEmpty.slice(1).map((r) => headers.map((_, i) => String(r[i] ?? '').trim()));
        resolve({ headers, rows });
      } catch {
        reject(new Error('Could not read that file. Try .xlsx or .csv with a header row.'));
      }
    };
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsArrayBuffer(file);
  });
}

/** Keys accepted on each object of a JSON job import (the Job field names,
 *  plus a few friendly aliases). */
const JSON_KEYS: Record<ImportField, string[]> = {
  title: ['title', 'jobTitle', 'position', 'role'],
  company: ['company', 'companyName', 'employer'],
  location: ['location'],
  salaryText: ['salaryText', 'salary', 'pay', 'compensation'],
  source: ['source', 'board'],
  postedDate: ['postedDate', 'posted', 'datePosted', 'date'],
  applyUrl: ['applyUrl', 'applyLink', 'applicationLink', 'link', 'url', 'jobUrl'],
  description: ['description', 'jobDescription', 'details'],
  matchScore: ['matchScore', 'match', 'score', 'fit'],
  strengths: ['strengths'],
  gaps: ['gaps'],
  masterResumeName: ['masterResumeName', 'masterResume'],
  tailoredResumeText: ['tailoredResumeText', 'tailoredResume'],
  tailoredFileName: ['tailoredFileName', 'fileName'],
  notes: ['notes', 'note'],
};

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean).join('; ');
  return String(value);
}

/** Convert a JSON array of job objects into the same sheet shape the
 *  spreadsheet path produces, so both share the mapping UI. Also returns
 *  any per-object stageId, carried alongside the rows. */
function parseJsonJobs(text: string): { sheet: ParsedSheet; stageIds: (string | undefined)[] } {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error('That JSON file is not an array of job objects.');
  }
  const fields = Object.keys(IMPORT_FIELD_LABELS) as ImportField[];
  const headers = fields.map((f) => IMPORT_FIELD_LABELS[f]);
  const rows: string[][] = [];
  const stageIds: (string | undefined)[] = [];
  for (const item of parsed) {
    const obj = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    rows.push(
      fields.map((f) => {
        for (const key of JSON_KEYS[f]) {
          if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return cellText(obj[key]);
        }
        return '';
      }),
    );
    stageIds.push(typeof obj.stageId === 'string' ? obj.stageId : undefined);
  }
  return { sheet: { headers, rows }, stageIds };
}

const FIELD_OPTIONS: (ImportField | 'ignore')[] = [
  'ignore',
  'title',
  'company',
  'location',
  'salaryText',
  'source',
  'postedDate',
  'applyUrl',
  'description',
  'matchScore',
  'strengths',
  'gaps',
  'masterResumeName',
  'tailoredResumeText',
  'tailoredFileName',
  'notes',
];

export function Importer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { jobs, dispatch, settings } = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [sheet, setSheet] = useState<ParsedSheet | null>(null);
  const [stageIds, setStageIds] = useState<(string | undefined)[]>([]);
  const [fileName, setFileName] = useState('');
  const [mapping, setMapping] = useState<Record<number, ImportField | null>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ added: number; skipped: number } | null>(null);

  function reset() {
    setSheet(null);
    setStageIds([]);
    setFileName('');
    setMapping({});
    setError('');
    setBusy(false);
    setDone(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  function applySheet(parsed: ParsedSheet, name: string, stages: (string | undefined)[]) {
    setSheet(parsed);
    setStageIds(stages);
    setFileName(name);
    const auto = autoMapHeaders(parsed.headers);
    // Avoid double-mapping the same field: keep first occurrence.
    const used = new Set<ImportField>();
    const deduped: Record<number, ImportField | null> = {};
    parsed.headers.forEach((_, idx) => {
      const m = auto[idx];
      if (m && !used.has(m)) {
        used.add(m);
        deduped[idx] = m;
      } else {
        deduped[idx] = null;
      }
    });
    setMapping(deduped);
  }

  async function handleFile(file: File) {
    setError('');
    setDone(null);
    try {
      if (file.name.toLowerCase().endsWith('.json')) {
        const text = await file.text();
        const { sheet: parsed, stageIds: stages } = parseJsonJobs(text);
        applySheet(parsed, file.name, stages);
      } else {
        const parsed = await parseSpreadsheet(file);
        applySheet(parsed, file.name, []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read that file.');
      setSheet(null);
    }
  }

  const importRows: ImportRow[] = useMemo(() => {
    if (!sheet) return [];
    return sheet.rows.map((cells, rowIdx) => {
      const values = {} as Record<ImportField, string>;
      (Object.keys(IMPORT_FIELD_LABELS) as ImportField[]).forEach((f) => {
        values[f] = '';
      });
      cells.forEach((cell, idx) => {
        const field = mapping[idx];
        if (field) values[field] = cell;
      });
      return { values, stageId: stageIds[rowIdx] };
    });
  }, [sheet, mapping, stageIds]);

  const { unique, skipped } = useMemo(() => dedupeImportRows(importRows, jobs), [importRows, jobs]);

  const hasTitleMapped = Object.values(mapping).includes('title');
  const previewRows = importRows.slice(0, 6);
  const mappedFields = (Object.keys(IMPORT_FIELD_LABELS) as ImportField[]).filter((f) =>
    Object.values(mapping).includes(f),
  );

  function doImport() {
    setBusy(true);
    // Batch through the reducer so dedupe happens against existing jobs.
    dispatch({ type: 'IMPORT_JOBS', rows: importRows });
    const result = { added: unique.length, skipped };
    setBusy(false);
    setDone(result);
  }

  return (
    <Modal open={open} onClose={() => { onClose(); reset(); }} title="Import jobs" wide>
      <AnimatePresence mode="wait">
        {!sheet ? (
          <motion.div key="pick" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <button
              onClick={() => fileRef.current?.click()}
              className="flex w-full flex-col items-center justify-center rounded-2xl border-2 border-dashed border-white/15 bg-zinc-900/50 px-6 py-14 transition-colors hover:border-accent-500/60 hover:bg-zinc-900"
            >
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3 text-zinc-500">
                <path d="M12 16V4m0 0l-4 4m4-4l4 4" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3" strokeLinecap="round" />
              </svg>
              <p className="text-sm font-semibold text-zinc-100">Choose a file</p>
              <p className="mt-1 text-xs text-zinc-500">.json array of jobs, or .xlsx / .csv with a header row</p>
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv,.json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
              }}
            />
            {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
            <div className="mt-5 rounded-xl border border-white/10 bg-zinc-900/50 p-4 text-xs text-zinc-400">
              <p className="mb-1.5 font-semibold text-zinc-300">Expected columns</p>
              <p>Title · Company · Location · Salary · Source · Posted · Apply Link · Description · Match · Strengths (; separated) · Gaps (; separated) · Master Resume · Tailored Resume · Tailored File Name</p>
              <p className="mt-1.5">New jobs land in “{settings.stages[0]?.name ?? 'New'}” unless the file gives them a stage.</p>
            </div>
          </motion.div>
        ) : done ? (
          <motion.div key="done" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="py-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-300">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-zinc-100">Import complete</h3>
            <p className="mt-1 text-sm text-zinc-400">
              {done.added} job{done.added === 1 ? '' : 's'} added
              {done.skipped > 0 && ` · ${done.skipped} duplicate${done.skipped === 1 ? '' : 's'} skipped`}
            </p>
            <Button variant="primary" className="mt-5" onClick={() => { onClose(); reset(); }}>
              Back to pipeline
            </Button>
          </motion.div>
        ) : (
          <motion.div key="map" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <p className="mb-4 text-sm text-zinc-400">
              <span className="font-medium text-zinc-100">{fileName}</span> · {sheet.rows.length} rows
              {skipped > 0 && (
                <span className="ml-2 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-300">
                  {skipped} duplicate{skipped === 1 ? '' : 's'} will be skipped
                </span>
              )}
            </p>

            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Map columns</h3>
            <div className="mb-5 grid gap-2 sm:grid-cols-2">
              {sheet.headers.map((h, idx) => (
                <div key={idx} className="flex items-center gap-2 rounded-lg border border-white/[0.07] bg-zinc-900/60 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-xs text-zinc-300" title={h}>
                    {h || <span className="italic text-zinc-600">(blank header)</span>}
                  </span>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="shrink-0 text-zinc-600">
                    <path d="M3 7h8M8 4l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <Select
                    value={mapping[idx] ?? 'ignore'}
                    onChange={(e) => {
                      const v = e.target.value as ImportField | 'ignore';
                      const next: Record<number, ImportField | null> = { ...mapping, [idx]: v === 'ignore' ? null : v };
                      // Keep each field mapped to at most one column.
                      if (v !== 'ignore') {
                        for (const k of Object.keys(next)) {
                          const ki = Number(k);
                          if (ki !== idx && next[ki] === v) next[ki] = null;
                        }
                      }
                      setMapping(next);
                    }}
                    className="!w-36 !py-1.5 !text-xs"
                    aria-label={`Map column ${h}`}
                  >
                    {FIELD_OPTIONS.map((f) => (
                      <option key={f} value={f}>
                        {f === 'ignore' ? 'Ignore' : IMPORT_FIELD_LABELS[f]}
                      </option>
                    ))}
                  </Select>
                </div>
              ))}
            </div>

            {!hasTitleMapped && (
              <p className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                Map a column to “Title” — rows without a job title can't be imported.
              </p>
            )}

            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
              Preview ({unique.length} new)
            </h3>
            <div className="mb-5 overflow-x-auto rounded-xl border border-white/10">
              <table className="w-full min-w-[560px] text-left text-xs">
                <thead>
                  <tr className="border-b border-white/10 bg-zinc-900">
                    {mappedFields.map((f) => (
                      <th key={f} className="px-3 py-2 font-semibold uppercase tracking-wide text-zinc-500">
                        {IMPORT_FIELD_LABELS[f]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((row, i) => (
                    <tr key={i} className="border-b border-white/5 last:border-0">
                      {mappedFields.map((f) => (
                        <td key={f} className="max-w-[180px] truncate px-3 py-2 text-zinc-300" title={row.values[f]}>
                          {row.values[f] || <span className="text-zinc-600">—</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between">
              <button onClick={reset} className="text-xs font-medium text-zinc-400 hover:text-zinc-100">
                ← Choose a different file
              </button>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => { onClose(); reset(); }}>
                  Cancel
                </Button>
                <Button variant="primary" disabled={!hasTitleMapped || unique.length === 0 || busy} onClick={doImport}>
                  {busy ? 'Importing…' : `Import ${unique.length} job${unique.length === 1 ? '' : 's'}`}
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Modal>
  );
}
