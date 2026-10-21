import { useRef, useState } from 'react';
import { formatDateTime, wordCount } from '../domain';
import { useStore } from '../store';
import { extractResumeText } from '../lib/resume';
import { Badge, Button, EmptyState, Input, Textarea } from './ui';

export function ResumesView() {
  const { masterResumes, settings, addMasterResume, deleteMasterResume, setDefaultMasterResume } = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pasteLabel, setPasteLabel] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  async function handleFile(file: File) {
    setError('');
    setBusy(true);
    try {
      const text = await extractResumeText(file);
      if (!text) throw new Error('No text could be extracted from that file.');
      const base = file.name.replace(/\.[^.]+$/, '');
      addMasterResume({
        label: label.trim() || base,
        fileName: file.name,
        text,
      });
      setLabel('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read that file.');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  function handlePaste() {
    const text = pasteText.trim();
    if (!text) return;
    addMasterResume({
      label: pasteLabel.trim() || 'Pasted resume',
      fileName: 'Pasted text',
      text,
    });
    setPasteLabel('');
    setPasteText('');
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-zinc-100">Master resumes</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Searches key off the master you pick. Every tailored resume on a job card is reworked
          from the master that search used — the masters themselves never change.
        </p>
      </div>

      {/* Upload */}
      <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
        <h2 className="mb-4 text-sm font-semibold text-zinc-100">Add a master resume</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-56">
            <Input
              label="Label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Frontend, Customer Support"
            />
          </div>
          <Button variant="primary" size="sm" onClick={() => fileRef.current?.click()} disabled={busy}>
            {busy ? 'Reading file…' : 'Upload .pdf, .docx, or .txt'}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.docx,.txt,.md"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
            }}
          />
        </div>
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        <div className="mt-5 border-t border-white/[0.07] pt-4">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-400">
            …or paste the text
          </p>
          <div className="space-y-3">
            <Input
              label="Label"
              value={pasteLabel}
              onChange={(e) => setPasteLabel(e.target.value)}
              placeholder="e.g. Frontend"
              className="!w-56"
            />
            <Textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder="Paste the full resume text…"
              rows={6}
            />
            <div className="flex justify-end">
              <Button variant="secondary" size="sm" onClick={handlePaste} disabled={!pasteText.trim()}>
                Add pasted resume
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* List */}
      {masterResumes.length === 0 ? (
        <EmptyState
          title="No master resumes yet"
          description="Add a master resume to get started — searches key off the resume you pick. Upload a PDF or Word file, or paste the text."
        />
      ) : (
        <ul className="space-y-3">
          {masterResumes.map((r) => {
            const isDefault = settings.defaultMasterResumeId === r.id;
            const expanded = expandedId === r.id;
            return (
              <li key={r.id} className="rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-zinc-100">{r.label}</p>
                      {isDefault && <Badge tone="green">Default</Badge>}
                    </div>
                    <p className="mt-1 text-xs text-zinc-500">
                      {r.fileName} · {wordCount(r.text).toLocaleString()} words · added {formatDateTime(r.uploadedAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setExpandedId(expanded ? null : r.id)}>
                      {expanded ? 'Hide text' : 'View text'}
                    </Button>
                    {!isDefault && (
                      <Button variant="secondary" size="sm" onClick={() => setDefaultMasterResume(r.id)}>
                        Set as default
                      </Button>
                    )}
                    {confirmDeleteId === r.id ? (
                      <>
                        <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteId(null)}>
                          Keep
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => {
                            deleteMasterResume(r.id);
                            setConfirmDeleteId(null);
                          }}
                        >
                          Delete
                        </Button>
                      </>
                    ) : (
                      <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteId(r.id)}>
                        Delete
                      </Button>
                    )}
                  </div>
                </div>
                {expanded && (
                  <pre className="mt-4 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-lg border border-white/[0.07] bg-zinc-950/60 p-3 font-sans text-xs leading-relaxed text-zinc-300">
                    {r.text}
                  </pre>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
