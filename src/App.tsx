import { Suspense, lazy, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { KanbanBoard } from './components/KanbanBoard';
import { JobDrawer } from './components/JobDrawer';
import { Dashboard } from './components/Dashboard';
import { ResumesView } from './components/ResumesView';
import { IndustriesView } from './components/IndustriesView';
import { Settings } from './components/Settings';
import { AddJobModal } from './components/AddJobModal';
import { Button } from './components/ui';

// SheetJS is heavy — split it into its own chunk, loaded only when the import dialog opens.
const Importer = lazy(() => import('./components/Importer').then((m) => ({ default: m.Importer })));

type View = 'dashboard' | 'pipeline' | 'industries' | 'resumes' | 'settings';

const NAV: { id: View; label: string; icon: ReactNode }[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="2" y="2" width="6" height="9" rx="1.5" />
        <rect x="10" y="2" width="6" height="5" rx="1.5" />
        <rect x="10" y="9" width="6" height="7" rx="1.5" />
        <rect x="2" y="13" width="6" height="3" rx="1.5" />
      </svg>
    ),
  },
  {
    id: 'pipeline',
    label: 'Pipeline',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M2 4h4v10H2zM7 4h4v6H7zM12 4h4v3h-4z" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: 'industries',
    label: 'Industries',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M2 16V8l4 2.4V8l4 2.4V4h6v12z" strokeLinejoin="round" />
        <path d="M5.5 13.5h.01M9 13.5h.01M12.5 13.5h.01" strokeLinecap="round" strokeWidth="2" />
      </svg>
    ),
  },
  {
    id: 'resumes',
    label: 'Resumes',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M5 2h9l3 3v11H5z" strokeLinejoin="round" />
        <path d="M14 2v3h3M8 10h5M8 13h5M8 7h2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="9" cy="9" r="2.4" />
        <path d="M9 1.8v2.4M9 13.8v2.4M1.8 9h2.4M13.8 9h2.4M4 4l1.7 1.7M12.3 12.3L14 14M14 4l-1.7 1.7M5.7 12.3L4 14" strokeLinecap="round" />
      </svg>
    ),
  },
];

function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-accent-500 to-accent-700 shadow-lg shadow-accent-600/30">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 17l4-8 3.5 5 2-2.5L18 17" />
          <path d="M4 21h16" />
        </svg>
      </div>
      <span className="text-[17px] font-bold tracking-tight text-zinc-100">
        Job<span className="text-accent-500">board</span>
      </span>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<View>('pipeline');
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-zinc-950">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col bg-[#0d3b3e] px-4 py-6 lg:flex">
        <div className="rounded-2xl bg-[#faf5ec] px-3 py-2.5">
          <Logo />
        </div>
        <nav className="mt-8 flex-1 space-y-1">
          {NAV.map((n) => (
            <button
              key={n.id}
              onClick={() => setView(n.id)}
              className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                view === n.id
                  ? 'bg-amber-400 font-semibold text-[#0b3235] shadow-md shadow-black/25'
                  : 'text-[#a8ccc4] hover:bg-white/10 hover:text-white'
              }`}
            >
              {n.icon}
              {n.label}
            </button>
          ))}
        </nav>
        <div className="space-y-2 px-1">
          <Button variant="secondary" size="sm" className="w-full" onClick={() => setImportOpen(true)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 16V4m0 0l-4 4m4-4l4 4" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3" strokeLinecap="round" />
            </svg>
            Import
          </Button>
          <Button variant="primary" size="sm" className="w-full" onClick={() => setAddOpen(true)}>
            + Add job
          </Button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="sticky top-0 z-30 border-b border-white/[0.07] bg-zinc-950/85 px-4 py-3 backdrop-blur-lg lg:hidden">
          <div className="flex items-center justify-between">
            <Logo />
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => setImportOpen(true)}>
                Import
              </Button>
              <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}>
                + Add
              </Button>
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 pb-28 pt-6 sm:px-6 lg:pb-12">
          <AnimatePresence mode="wait">
            <motion.div
              key={view}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.18 }}
            >
              {view === 'dashboard' && <Dashboard />}
              {view === 'pipeline' && <KanbanBoard onAddJob={() => setAddOpen(true)} />}
              {view === 'industries' && <IndustriesView />}
              {view === 'resumes' && <ResumesView />}
              {view === 'settings' && <Settings />}
            </motion.div>
          </AnimatePresence>
        </main>

        {/* Mobile bottom nav */}
        <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-white/[0.07] bg-zinc-950/90 backdrop-blur-lg lg:hidden">
          <div className="grid grid-cols-5">
            {NAV.map((n) => (
              <button
                key={n.id}
                onClick={() => setView(n.id)}
                className={`relative flex flex-col items-center gap-1 py-2.5 text-[10px] font-medium ${
                  view === n.id ? 'text-accent-600' : 'text-zinc-500'
                }`}
              >
                {n.icon}
                {n.label}
              </button>
            ))}
          </div>
        </nav>
      </div>

      <JobDrawer />
      <AddJobModal open={addOpen} onClose={() => setAddOpen(false)} />
      <Suspense fallback={null}>
        {importOpen && <Importer open={importOpen} onClose={() => setImportOpen(false)} />}
      </Suspense>
    </div>
  );
}
