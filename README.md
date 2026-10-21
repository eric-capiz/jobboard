# JobBoard

**Live app:** https://eric-capiz.github.io/dealboard/

A sales-pipeline CRM built for one job: turning local-business lead lists into paying website clients. Import a spreadsheet of leads, drag them through a pipeline, never miss a follow-up, and watch your projected revenue grow.

100% client-side. No backend, no account, no cost. Your data lives in your browser's localStorage.

## How to use it

### 1. Import your leads
- Go to **Leads → Import** and upload your `.xlsx` or `.csv` sweep file.
- DealBoard auto-detects the columns (Business Name, Category, Address, Phone, Email, Facebook, Instagram, Notes). If your headers differ, the column-mapping screen lets you match them up.
- Duplicates (same name + address) are skipped automatically.
- Prefer to start small? Use **Add lead** to enter one manually.
- The app ships with 12 clearly-labeled SAMPLE leads so you can explore. Purge them anytime from **Settings → Purge sample leads**.

### 2. Work the pipeline
- The **Pipeline** board has six stages: New → Contacted → Replied → Meeting → Proposal → Won, plus a Lost column.
- Drag cards between stages (touch-friendly on mobile). Every move is logged in the lead's activity history.
- Set a **deal value** and **expected close date** per lead — each column shows its count and total pipeline value.
- Marking a lead Lost prompts for a reason (no budget, no response, bad fit…), so your data stays honest.

### 3. Never miss a follow-up
- Open any lead and set a **follow-up date**, or use the quick actions (tomorrow / next week).
- The **Follow-ups** view groups everything into Overdue, Due today, Upcoming, and No date. Overdue leads are highlighted — clear them daily.
- Optional: enable daily browser notifications in Follow-ups so the app nudges you.

### 4. Send outreach faster with templates
- **Templates** ships with six starters: cold email, cold DM, follow-up bump, proposal, and two breakup emails.
- Merge fields auto-fill per lead: `{name}`, `{firstName}`, `{category}`, `{city}`, `{phone}`.
- Preview any template against a real lead, then one-click copy and paste into your email or DMs.
- Create, edit, and delete your own templates — they persist with everything else.

### 5. Read the dashboard
- **Dashboard** shows your conversion funnel (what % moves stage to stage), leads by category, pipeline value by stage, win rate, average deal size, projected monthly revenue, and a live activity feed.

### 6. Find anything instantly
- Global search across name, category, city, and notes. Filter by category, stage, follow-up status, or "has email". Four sort orders.

### 7. Your data, your control
- **Settings → Export backup** downloads your entire database as JSON. Import it back anytime — moving browsers or machines loses nothing.
- **Danger zone** resets everything. There's a confirmation; there's no undo.

## Suggested daily workflow

1. Open **Follow-ups** — work every Overdue and Due-today lead first.
2. Pull 10–20 fresh leads from **New**, send the cold email template, move them to **Contacted** with a follow-up in 3 days.
3. Bump unanswered Contacted leads after 3–4 days with the follow-up template.
4. Log every reply as a note, move to **Replied**, book the meeting.
5. After the call: proposal template → **Proposal** stage → close → **Won**. 🎉

## Local development

```bash
npm ci
npm run dev      # dev server
npm run build    # type-check + production build (tsc --noEmit && vite build)
```

## Deploying

Pushing to `main` deploys automatically via the GitHub Actions workflow in `.github/workflows/deploy.yml` (builds the Vite app and publishes to GitHub Pages). First-time setup: add that workflow file to the repo, then set **Settings → Pages → Source: GitHub Actions**.

> Note: GitHub Pages requires a paid plan for private repos. On a free plan, either make the repo public or connect it to Vercel instead.

## Project layout

- `src/domain/` — pure types + pipeline logic (stages, funnel math, dedupe, import mapping, template rendering). UI-free and unit-testable.
- `src/store/` — versioned localStorage persistence, migrations, backup/restore, app actions.
- `src/components/` — Pipeline kanban, lead drawer, dashboard, follow-ups, templates, importer, settings.
- `src/data/seed.ts` — sample leads + starter outreach templates (purgeable from Settings).

## Tech

Vite + React 18 + TypeScript (strict) + Tailwind CSS · dnd-kit (drag-and-drop) · SheetJS (import) · Framer Motion · hand-rolled SVG charts · localStorage persistence with versioned migrations.

## Environment variables (Vercel)

- `MONGODB_URI` — MongoDB Atlas connection string for cloud sync storage
- `SYNC_KEY` — shared secret the API checks on every state read/write
- `VITE_SYNC_KEY` — same value as `SYNC_KEY` (used by the web client)
