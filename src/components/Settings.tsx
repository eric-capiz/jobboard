import { useRef, useState } from 'react';
import { DEFAULT_STAGES, Stage, uid } from '../domain';
import { useStore } from '../store';
import { Badge, Button, Input, Modal } from './ui';

function StageEditor() {
  const { settings, dispatch, jobs } = useStore();
  const [stages, setStages] = useState<Stage[]>(settings.stages);
  const [dirty, setDirty] = useState(false);
  const [newName, setNewName] = useState('');

  function update(next: Stage[]) {
    setStages(next);
    setDirty(true);
  }

  function rename(id: string, name: string) {
    update(stages.map((s) => (s.id === id ? { ...s, name } : s)));
  }

  function move(id: string, dir: -1 | 1) {
    const idx = stages.findIndex((s) => s.id === id);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= stages.length) return;
    const next = [...stages];
    const [s] = next.splice(idx, 1);
    next.splice(j, 0, s);
    // Keep Offer/Lost pinned at the end.
    const pinned = next.filter((x) => x.kind === 'won' || x.kind === 'lost');
    const rest = next.filter((x) => x.kind !== 'won' && x.kind !== 'lost');
    update([...rest, ...pinned]);
  }

  function addStage() {
    const name = newName.trim();
    if (!name) return;
    const stage: Stage = { id: `stage-${uid().slice(0, 8)}`, name, kind: 'open' };
    const pinned = stages.filter((s) => s.kind === 'won' || s.kind === 'lost');
    const rest = stages.filter((s) => s.kind !== 'won' && s.kind !== 'lost');
    update([...rest, stage, ...pinned]);
    setNewName('');
  }

  function remove(id: string) {
    const stage = stages.find((s) => s.id === id);
    if (!stage || stage.kind !== 'open') return; // Only custom open stages are removable.
    const affected = jobs.filter((j) => j.stageId === id).length;
    if (affected > 0 && !window.confirm(`${affected} job${affected === 1 ? '' : 's'} in “${stage.name}” will move to the first stage. Continue?`)) {
      return;
    }
    update(stages.filter((s) => s.id !== id));
  }

  function save() {
    const cleaned = stages.map((s) => ({ ...s, name: s.name.trim() || s.id }));
    dispatch({ type: 'SET_STAGES', stages: cleaned });
    setDirty(false);
  }

  function resetDefaults() {
    if (!window.confirm('Reset stages to the default pipeline? Jobs in custom stages move to New.')) return;
    dispatch({ type: 'SET_STAGES', stages: DEFAULT_STAGES.map((s) => ({ ...s })) });
    setStages(DEFAULT_STAGES.map((s) => ({ ...s })));
    setDirty(false);
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">Pipeline stages</h2>
          <p className="mt-0.5 text-xs text-zinc-500">Rename, reorder, or add stages. Offer and Lost keep their meaning.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={resetDefaults}>
            Reset defaults
          </Button>
          <Button variant="primary" size="sm" onClick={save} disabled={!dirty}>
            Save stages
          </Button>
        </div>
      </div>
      <ul className="space-y-2">
        {stages.map((s, i) => (
          <li
            key={s.id}
            className="flex items-center gap-2 rounded-xl border border-white/[0.07] bg-zinc-900 px-3 py-2"
          >
            <span className="w-6 shrink-0 text-center text-xs font-bold text-zinc-600">{i + 1}</span>
            <input
              value={s.name}
              onChange={(e) => rename(s.id, e.target.value)}
              className="min-w-0 flex-1 rounded-md bg-transparent px-2 py-1 text-sm text-zinc-100 focus:bg-zinc-800 focus:outline-none"
              aria-label={`Stage ${i + 1} name`}
            />
            {s.kind === 'won' && <Badge tone="green">Won</Badge>}
            {s.kind === 'lost' && <Badge tone="red">Lost</Badge>}
            {s.kind === 'new' && <Badge tone="blue">Start</Badge>}
            <div className="flex shrink-0 gap-1">
              <button
                onClick={() => move(s.id, -1)}
                disabled={i === 0}
                className="rounded-md p-1.5 text-zinc-500 hover:bg-white/5 hover:text-zinc-100 disabled:opacity-30"
                aria-label="Move stage up"
              >
                ↑
              </button>
              <button
                onClick={() => move(s.id, 1)}
                disabled={i === stages.length - 1}
                className="rounded-md p-1.5 text-zinc-500 hover:bg-white/5 hover:text-zinc-100 disabled:opacity-30"
                aria-label="Move stage down"
              >
                ↓
              </button>
              {s.kind === 'open' && (
                <button
                  onClick={() => remove(s.id)}
                  className="rounded-md p-1.5 text-zinc-500 hover:bg-white/5 hover:text-red-400"
                  aria-label={`Remove stage ${s.name}`}
                >
                  ✕
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex gap-2">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New stage name, e.g. Phone Screen"
          className="!w-56"
          onKeyDown={(e) => e.key === 'Enter' && addStage()}
        />
        <Button variant="secondary" size="sm" onClick={addStage} disabled={!newName.trim()}>
          Add stage
        </Button>
      </div>
    </div>
  );
}

export function Settings() {
  const { jobs, masterResumes, dispatch, exportBackup, importBackup } = useStore();
  const [importError, setImportError] = useState('');
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [resetStep, setResetStep] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  function onBackupFile(file: File) {
    setPendingFile(file);
    setConfirmRestore(true);
    setImportError('');
  }

  async function doRestore() {
    if (!pendingFile) return;
    const res = await importBackup(pendingFile);
    setConfirmRestore(false);
    setPendingFile(null);
    if (fileRef.current) fileRef.current.value = '';
    if (!res.ok) setImportError(res.error ?? 'Restore failed.');
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <StageEditor />

      {/* Backup */}
      <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-5">
        <h2 className="mb-1 text-sm font-semibold text-zinc-100">Backup</h2>
        <p className="mb-4 text-xs text-zinc-500">
          Your data lives in this browser's local storage. Export a JSON backup before clearing site data.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={exportBackup}>
            ↓ Download backup (JSON)
          </Button>
          <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
            ↑ Restore from backup…
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onBackupFile(f);
            }}
          />
        </div>
        {importError && <p className="mt-3 text-sm text-red-400">{importError}</p>}
      </div>

      {/* Danger zone */}
      <div className="rounded-2xl border border-red-500/25 bg-red-500/[0.03] p-5">
        <h2 className="mb-1 text-sm font-semibold text-red-300">Danger zone</h2>
        <p className="mb-4 text-xs text-zinc-500">Destructive actions. There's no undo — export a backup first.</p>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.07] bg-zinc-900/70 px-4 py-3">
          <div>
            <p className="text-sm font-medium text-zinc-100">Reset all data</p>
            <p className="text-xs text-zinc-500">Wipes every job, master resume, and setting. Fresh start.</p>
          </div>
          {resetStep === 0 ? (
            <Button variant="danger" size="sm" onClick={() => setResetStep(1)}>
              Reset everything…
            </Button>
          ) : resetStep === 1 ? (
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setResetStep(0)}>
                Cancel
              </Button>
              <Button variant="danger" size="sm" onClick={() => setResetStep(2)}>
                I'm sure — continue
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-xs text-red-300">Really delete all {jobs.length} jobs?</span>
              <Button variant="ghost" size="sm" onClick={() => setResetStep(0)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  dispatch({ type: 'RESET_ALL' });
                  setResetStep(0);
                }}
              >
                Delete everything
              </Button>
            </div>
          )}
        </div>
      </div>

      <p className="text-center text-xs text-zinc-600">
        JobBoard keeps {jobs.length} job{jobs.length === 1 ? '' : 's'} and {masterResumes.length} master resume
        {masterResumes.length === 1 ? '' : 's'} on this device.
      </p>

      {/* Restore confirm */}
      <Modal open={confirmRestore} onClose={() => { setConfirmRestore(false); setPendingFile(null); }} title="Restore backup?">
        <p className="text-sm text-zinc-400">
          Restoring <span className="font-medium text-zinc-100">{pendingFile?.name}</span> will{' '}
          <span className="font-semibold text-red-300">replace all current data</span>. This can't be undone.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => { setConfirmRestore(false); setPendingFile(null); }}>
            Cancel
          </Button>
          <Button variant="danger" onClick={doRestore}>
            Replace and restore
          </Button>
        </div>
      </Modal>
    </div>
  );
}
