import { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes, forwardRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

/* Shared UI primitives — warm paper theme, coral accent, teal sidebar. */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const buttonStyles: Record<ButtonVariant, string> = {
  primary:
    'bg-accent-600 hover:bg-accent-500 text-white shadow-lg shadow-accent-600/25 focus-visible:ring-accent-400',
  secondary:
    'bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border border-white/10 focus-visible:ring-zinc-400',
  ghost: 'text-zinc-300 hover:text-zinc-100 hover:bg-white/5 focus-visible:ring-zinc-400',
  danger:
    'bg-red-600/90 hover:bg-red-500 text-white shadow-lg shadow-red-600/20 focus-visible:ring-red-400',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', className = '', ...props },
  ref,
) {
  const sizes = { sm: 'px-3 py-1.5 text-xs', md: 'px-4 py-2 text-sm', lg: 'px-5 py-2.5 text-sm' };
  return (
    <button
      ref={ref}
      className={`inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:cursor-not-allowed disabled:opacity-50 active:scale-[0.98] ${buttonStyles[variant]} ${sizes[size]} ${className}`}
      {...props}
    />
  );
});

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, className = '', id, ...props },
  ref,
) {
  const inputId = id ?? `input-${label?.replace(/\s+/g, '-').toLowerCase() ?? Math.random().toString(36).slice(2)}`;
  return (
    <label htmlFor={inputId} className="block">
      {label && <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-400">{label}</span>}
      <input
        ref={ref}
        id={inputId}
        className={`w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 transition-colors focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500 ${className}`}
        {...props}
      />
      {hint && <span className="mt-1 block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
});

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, className = '', id, ...props },
  ref,
) {
  const inputId = id ?? `ta-${label?.replace(/\s+/g, '-').toLowerCase() ?? Math.random().toString(36).slice(2)}`;
  return (
    <label htmlFor={inputId} className="block">
      {label && <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-400">{label}</span>}
      <textarea
        ref={ref}
        id={inputId}
        className={`w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 transition-colors focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500 ${className}`}
        {...props}
      />
    </label>
  );
});

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, className = '', children, id, ...props },
  ref,
) {
  const inputId = id ?? `sel-${label?.replace(/\s+/g, '-').toLowerCase() ?? Math.random().toString(36).slice(2)}`;
  return (
    <label htmlFor={inputId} className="block">
      {label && <span className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-zinc-400">{label}</span>}
      <select
        ref={ref}
        id={inputId}
        className={`w-full appearance-none rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 transition-colors focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500 ${className}`}
        {...props}
      >
        {children}
      </select>
    </label>
  );
});

const badgeStyles: Record<string, string> = {
  default: 'bg-zinc-800 text-zinc-300 border-white/10',
  accent: 'bg-accent-500/15 text-accent-300 border-accent-500/30',
  green: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  red: 'bg-red-500/15 text-red-300 border-red-500/30',
  amber: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  blue: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  violet: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
};

export function Badge({
  children,
  tone = 'default',
  className = '',
}: {
  children: ReactNode;
  tone?: keyof typeof badgeStyles;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 ${badgeStyles[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function Modal({
  open,
  onClose,
  children,
  title,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  title: string;
  wide?: boolean;
}) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ type: 'spring', damping: 28, stiffness: 320 }}
            className={`relative w-full ${wide ? 'max-w-3xl' : 'max-w-md'} max-h-[90vh] overflow-y-auto rounded-2xl border border-white/10 bg-zinc-950 p-6 shadow-2xl shadow-black/60`}
            role="dialog"
            aria-modal="true"
            aria-label={title}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-zinc-100">{title}</h2>
              <button
                onClick={onClose}
                className="rounded-lg p-1.5 text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100"
                aria-label="Close"
              >
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                  <path d="M4 4l10 10M14 4L4 14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-zinc-900/40 px-6 py-14 text-center">
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-800/80 text-zinc-500">
        {icon ?? (
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <rect x="3" y="4" width="18" height="16" rx="2.5" />
            <path d="M3 9h18M8 4v5" />
          </svg>
        )}
      </div>
      <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
      <p className="mt-1.5 max-w-sm text-sm text-zinc-400">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function FieldRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{children}</div>;
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${checked ? 'bg-accent-600' : 'bg-zinc-700'}`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`}
      />
    </button>
  );
}
