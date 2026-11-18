// verifier.js — fail-closed deterministic verifier for JobBoard ingest.
// Pure functions, no dependencies. Input: { title, location, description, applyUrl }.
// Output: { verdict: 'ACCEPT' | 'REJECT', reason, evidence, field }.
// Rules merged from the 7 AI consults (Claude, DeepSeek, Genspark, ChatGPT,
// Mistral, Perplexity, Pollinations). Order: structural failures first,
// then hard rejects, then positive-evidence + US-signal requirements.
// Default is REJECT. A bare "Remote" label proves nothing; blank location
// is an automatic fail; structured ATS flags are never used here — only text.

'use strict';

const US_STATES = [
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
  'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho',
  'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana',
  'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota',
  'mississippi', 'missouri', 'montana', 'nebraska', 'nevada',
  'new hampshire', 'new jersey', 'new mexico', 'new york',
  'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon',
  'pennsylvania', 'rhode island', 'south carolina', 'south dakota',
  'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington',
  'west virginia', 'wisconsin', 'wyoming', 'district of columbia',
];
const US_STATE_ABBREV = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID',
  'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS',
  'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK',
  'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV',
  'WI', 'WY', 'DC',
];

// State-exclusion patterns are GENERATED from the full state arrays at
// module load (round 6, ChatGPT re-vote #3). The old hand-maintained
// 16-state subset let "except Idaho" through to ACCEPT. Full state NAMES
// are unambiguous; abbrevs are included too — EXCEPT "IN" (Indiana),
// because normalized text loses case and "except in ..." is ordinary
// English ("except in rare cases"). Indiana is still caught by its full
// name, and by list-mates in the usual "except CA, IN, OH" form. The
// exclusion trigger words (except/excluding/not available in) are the
// context gate, which is what keeps bare abbrevs from misfiring.
// Round 8 (ChatGPT re-vote #4) closes the remaining "except IN" gap for
// mixed-case documents: see findUppercaseInExclusion below — the
// ORIGINAL-CASE text distinguishes uppercase IN (Indiana) from lowercase
// in (ordinary English). All-caps sentences are disambiguated per
// sentence on what follows IN (round 9): bare IN or IN + an unlisted
// word rejects, IN + a known ordinary-English continuation accepts.
const STATE_NAME_ALT = US_STATES.map((s) => s.replace(/ /g, '\\s+')).join('|');
const STATE_ABBREV_ALT = US_STATE_ABBREV.filter((a) => a !== 'IN').map((a) => a.toLowerCase()).join('|');
const STATE_ALT = `${STATE_NAME_ALT}|${STATE_ABBREV_ALT}`;
const STATE_EXCLUSION_RE = new RegExp(`\\b(except|excluding|excludes?|not\\s+available\\s+in)\\b[^.]{0,60}\\b(${STATE_ALT})\\b`, 'g');
const STATE_ONLY_RE = new RegExp(`\\b(${STATE_ALT})\\s*-\\s*only\\b`, 'g');
const NON_US_COUNTRIES = [
  'canada', 'united kingdom', 'uk', 'england', 'scotland', 'wales',
  'ireland', 'germany', 'france', 'spain', 'italy', 'netherlands',
  'belgium', 'switzerland', 'austria', 'poland', 'sweden', 'norway',
  'denmark', 'finland', 'portugal', 'greece', 'turkey', 'india', 'china',
  'japan', 'korea', 'singapore', 'australia', 'new zealand', 'brazil',
  'mexico', 'argentina', 'chile', 'colombia', 'peru', 'philippines',
  'vietnam', 'thailand', 'malaysia', 'indonesia', 'pakistan', 'bangladesh',
  'nigeria', 'kenya', 'south africa', 'egypt', 'israel', 'uae',
  'saudi arabia', 'emea', 'latam', 'apac', 'europe',
];
const NON_US_METROS = [
  'london', 'toronto', 'vancouver', 'montreal', 'dublin', 'berlin',
  'munich', 'paris', 'madrid', 'barcelona', 'rome', 'milan', 'amsterdam',
  'zurich', 'vienna', 'stockholm', 'oslo', 'copenhagen', 'helsinki',
  'lisbon', 'athens', 'warsaw', 'prague', 'budapest', 'tokyo', 'seoul',
  'sydney', 'melbourne', 'auckland', 'mumbai', 'delhi', 'bangalore',
  'manila', 'jakarta', 'bangkok', 'sao paulo', 'mexico city', 'darmstadt',
  'bengaluru', 'hyderabad', 'chennai',
];

const NEGATION_WORDS = /\b(not|no|non|without|zero|never|n't)\b/;
const NEGATION_LOOKBACK = 45; // chars before a match to scan for negation

// Words that make "hybrid" a technical term, not a work arrangement.
const HYBRID_TECH = /\bhybrid\s+(cloud|environment|model|infrastructure|architecture|platform)\b/;
// Job-duty phrases where "onsite" describes the work performed, not where
// the employee sits (per Genspark: only count onsite adjacent to
// work|role|position|schedule|expectation|required).
const ONSITE_DUTY = /\bon[-\s]?site\s+(support|troubleshooting|visits?|installation|service|repair|maintenance)\b/;

// clean() is normalize() without the lowercase step: entity decoding,
// tag stripping and whitespace collapsing only. clean(x).toLowerCase()
// === normalize(x), so offsets in the cleaned (original-case) text align
// exactly with offsets in the normalized text — the case-sensitive
// "except IN" rule below relies on that alignment.
function clean(text) {
  return (text || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalize(text) {
  return clean(text).toLowerCase();
}

function sentenceOf(text, index) {
  // Start of the sentence containing `index`: after the previous '. ',
  // or 0 when the match is in the first sentence (lastIndexOf -1 must
  // map to 0, not 1 — the old `+ 2` on -1 silently dropped the first char).
  const prev = text.lastIndexOf('. ', index - 1);
  const start = prev === -1 ? 0 : prev + 2;
  let end = text.indexOf('.', index);
  if (end === -1) end = text.length;
  const sentence = text.slice(start, end + 1).trim();
  return sentence.length > 220 ? sentence.slice(0, 220) + '…' : sentence;
}

function isNegated(text, matchIndex) {
  const windowStart = Math.max(0, matchIndex - NEGATION_LOOKBACK);
  const before = text.slice(windowStart, matchIndex);
  // A sentence boundary between the negation and the match breaks the link.
  const lastBoundary = Math.max(before.lastIndexOf('. '), before.lastIndexOf('! '), before.lastIndexOf('? '));
  const clause = lastBoundary === -1 ? before : before.slice(lastBoundary + 2);
  return NEGATION_WORDS.test(clause);
}

// Returns the first non-negated, non-technical match of `re` in `text`,
// or null. `re` must have the global flag. `excludeRe`, when given, is
// tested against the text starting at the match (so multi-word exclusions
// like "hybrid cloud" can see the word after the match).
function findRealMatch(text, re, excludeRe) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (excludeRe && excludeRe.test(text.slice(m.index, m.index + 50))) continue;
    if (m[0].startsWith('non-') || m[0].startsWith('non ')) continue;
    if (isNegated(text, m.index)) continue;
    return { match: m[0], index: m.index };
  }
  return null;
}

function stateTokenPresent(text) {
  const lower = text.toLowerCase();
  for (const s of US_STATES) {
    if (new RegExp(`\\b${s.replace(/ /g, '\\s+')}\\b`).test(lower)) return s;
  }
  for (const a of US_STATE_ABBREV) {
    if (new RegExp(`\\b${a}\\b`, 'i').test(text)) return a;
  }
  return null;
}

// Case-sensitive "except IN" rule (round 8, ChatGPT re-vote #4; all-caps
// disambiguation round 9, ChatGPT re-vote #5). The normalized (lowercased)
// text cannot tell Indiana's abbreviation "IN" from the ordinary English
// word "in", so the abbrev alternation above deliberately excludes IN —
// which let "Remote throughout the US, except IN." ACCEPT. Fix: look at
// the ORIGINAL-CASE text. A standalone UPPERCASE "IN" within ~60 chars
// after an exclusion trigger (except/excluding/not available in) is
// Indiana's abbreviation and rejects as state_restricted; lowercase "in"
// is ordinary English and does not. The trigger match itself is
// case-insensitive (a sentence may start with "Except"), but the IN match
// is case-sensitive.
// CONTEXTUAL DISAMBIGUATION (round 9): case is judged PER SENTENCE, not
// per document — a mixed-case posting can contain an all-caps sentence
// ("EXCEPT IN RARE CASES.") and vice versa. In a MIXED-CASE sentence,
// any uppercase IN in exclusion context rejects (round-8 behaviour:
// "except IN residents" is Indiana). In an ALL-CAPS sentence, what
// follows IN decides:
//   - IN at the end of the sentence ("EXCEPT IN.") -> REJECT (bare IN is
//     the abbreviation; ordinary English never ends a sentence on "in").
//   - IN + a known ordinary-English continuation ("EXCEPT IN RARE CASES.",
//     "EXCEPT IN CERTAIN CIRCUMSTANCES.") -> ACCEPT (skip this trigger).
//   - IN + anything else ("EXCEPT IN RESIDENTS.", "EXCEPT IN
//     APPLICANTS.") -> REJECT, fail closed. Genuinely ambiguous contexts
//     reject: a false reject costs one posting, a false accept publishes
//     a state-restricted job as remote US-wide.
// The continuation list is deliberately narrow: only phrases that cannot
// plausibly be a state reference (generic nouns: cases, circumstances,
// event, addition). It is NOT a general English dictionary — anything
// not on it fails closed.
// Returns { index, triggerIndex } of the "IN" match in the raw text, or
// null. triggerIndex is the start of the exclusion trigger — the negation
// check must run there, NOT at the IN position: the trigger "not
// available in" itself contains "not", which the negation detector would
// otherwise read as negating the match.
const KNOWN_IN_CONTINUATIONS = [
  'RARE CASES', 'CERTAIN CIRCUMSTANCES', 'SOME CASES', 'SOME INSTANCES',
  'SPECIAL CIRCUMSTANCES', 'EXCEPTIONAL CIRCUMSTANCES',
  'EXTRAORDINARY CIRCUMSTANCES', 'LIMITED CIRCUMSTANCES',
  'PARTICULAR CASES', 'PARTICULAR CIRCUMSTANCES',
  'SPECIFIC CASES', 'SPECIFIC CIRCUMSTANCES', 'INDIVIDUAL CASES',
  'A FEW CASES', 'THE EVENT OF', 'THE EVENT THAT', 'ADDITION TO', 'GENERAL',
];
function findUppercaseInExclusion(rawText) {
  const triggerRe = /\b(except|excluding|excludes?|not\s+available\s+in)\b/gi;
  let m;
  while ((m = triggerRe.exec(rawText)) !== null) {
    const after = m.index + m[0].length;
    const windowEnd = Math.min(rawText.length, after + 60);
    let seg = rawText.slice(after, windowEnd);
    const dot = seg.indexOf('.');
    if (dot !== -1) seg = seg.slice(0, dot);
    const inMatch = /\bIN\b/.exec(seg);
    if (!inMatch) continue;
    // Case context is the SENTENCE holding the trigger (sentence boundary
    // = the previous ". " before the trigger), not the whole document.
    const prevBoundary = rawText.lastIndexOf('. ', m.index - 1);
    const sentStart = prevBoundary === -1 ? 0 : prevBoundary + 2;
    const sentEnd = rawText.indexOf('.', m.index);
    const sentence = rawText.slice(sentStart, sentEnd === -1 ? rawText.length : sentEnd);
    if (/[a-z]/.test(sentence)) {
      // Mixed-case sentence: any uppercase IN in exclusion context is
      // Indiana (round-8 behaviour, unchanged).
      return { index: after + inMatch.index, triggerIndex: m.index };
    }
    // All-caps sentence: disambiguate on what follows IN.
    const rest = seg.slice(inMatch.index + inMatch[0].length).trim().replace(/^[,\s]+/, '');
    if (rest === '') return { index: after + inMatch.index, triggerIndex: m.index }; // bare IN at sentence end
    const upper = rest.toUpperCase();
    const isContinuation = KNOWN_IN_CONTINUATIONS.some((p) => new RegExp(`^${p.replace(/ /g, '\\s+')}\\b`).test(upper));
    if (isContinuation) continue; // known ordinary-English continuation: not Indiana
    return { index: after + inMatch.index, triggerIndex: m.index }; // fail closed
  }
  return null;
}

function verifyPosting(posting) {
  const title = normalize(posting.title);
  const location = normalize(posting.location);
  const description = normalize(posting.description);
  // Original-case counterparts (clean() only — same offsets as the
  // normalized text, since lowercase never changes length). The
  // case-sensitive "except IN" rule below runs on these.
  const rawTitle = clean(posting.title);
  const rawLocation = clean(posting.location);
  const rawDescription = clean(posting.description);
  const combined = `${title} ${location} ${description}`;
  const fail = (reason, evidence, field) => ({ verdict: 'REJECT', reason, evidence, field });

  // --- 1. Structural failures -------------------------------------------------
  if (!posting.location || !String(posting.location).trim()) {
    return fail('blank_location', '(no location given)', 'location');
  }
  if (!posting.description || !String(posting.description).trim()) {
    return fail('no_description', '(no description text)', 'description');
  }
  if (description.length < 400) {
    return fail('description_too_short', `description is ${description.length} chars (min 400)`, 'description');
  }
  if (!posting.applyUrl && !posting.canonicalUrl) {
    return fail('no_apply_target', '(no apply URL)', 'applyUrl');
  }

  // --- 2. Not a job at all ----------------------------------------------------
  let m = findRealMatch(description, /\b(talent\s+(pool|community|network)|general\s+application|no\s+current\s+openings|job\s+alert|join\s+our\s+talent\s+community)\b/g);
  if (m) return fail('not_a_job', sentenceOf(description, m.index), 'description');

  // --- 3. Hard rejects (any hit rejects; checked on title + location + description)
  const fields = [
    { name: 'title', text: title },
    { name: 'location', text: location },
    { name: 'description', text: description },
  ];

  const hardRejects = [
    { reason: 'hybrid', re: /\bhybrid\b/g, exclude: HYBRID_TECH },
    { reason: 'onsite', re: /\bon[-\s]?site\b/g, exclude: ONSITE_DUTY },
    { reason: 'in_office', re: /\bin[-\s]?office\b/g },
    { reason: 'return_to_office', re: /\breturn\s+to\s+(the\s+)?office\b/g },
    { reason: 'days_in_office', re: /\b[1-5]\s*days?\s*(per|\/)\s*week\s*(in|at)\s*(the\s*)?(office|onsite|on[-\s]?site)\b/g },
    { reason: 'days_in_office', re: /\b(in|at)\s*(the\s*)?(office|onsite|on[-\s]?site)\s+[1-5]\s*days?\s*(per|\/)\s*week\b/g },
    { reason: 'days_in_office', re: /\b[1-5]\s*days?\s+in\s+(the\s+)?(office|onsite|on[-\s]?site)\b/g },
    { reason: 'days_in_office', re: /\bdays?\s*(per|a)\s*week\s*(in|at)\s*(the\s*)?office\b/g },
    { reason: 'residency_required', re: /\bmust\s+(reside|live|be\s+based|be\s+located)\s+in\s+(?!the\s+united\s+states\b|the\s+us\b)/g },
    { reason: 'residency_required', re: /\b(reside|live|be\s+based)\s+(in|within)\s+(?!the\s+united\s+states\b|the\s+us\b)(\d+\s*miles?\s+of\s+)?[a-z]/g },
    { reason: 'based_in_place', re: /\b(based|located)\s+(out\s+of|in|at)\s+(?!the\s+united\s+states\b|the\s+us\b)[a-z]/g },
    { reason: 'commuting_distance', re: /\b(commuting\s+distance|commutable|must\s+be\s+able\s+to\s+commute|within\s+commuting\s+distance)\b/g },
    { reason: 'that_office', re: /\b(that|assigned|designated)\s+office\b/g },
    // Required travel only. The old bare "travel to X" arm rejected OPTIONAL
    // travel ("you may occasionally travel to team meetings"). Only
    // obligation markers (required/must/expected/up to N%) make travel a
    // reject — the constraint bans required travel, not any travel.
    { reason: 'travel_required', re: /\b(up\s+to\s+\d+\s*%\s*travel|travel\s+(is\s+)?required|required\s+to\s+travel|require[sd]?\s+(occasional\s+)?travel|frequent\s+travel|overnight\s+travel|regular\s+travel|quarterly\s+onsite|required\s+annual\s+offsite|must\s+travel|expected\s+to\s+travel|travel\s+is\s+expected)\b/g },
    { reason: 'relocation_required', re: /\brelocation\s+(is\s+)?required\b/g },
    { reason: 'state_restricted', re: STATE_EXCLUSION_RE },
    { reason: 'state_restricted', re: STATE_ONLY_RE },
    { reason: 'state_restricted', re: /\b\w+\s*-\s*only\b/g, exclude: null }, // checked below: only if the word is a state
    // Approved/eligible hiring-location language = a geographic restriction
    // even when no state is named ("subject to our approved hiring
    // locations"). Fail-closed: a US-wide role has no approved-location list.
    { reason: 'state_restricted', re: /\bsubject\s+to\s+(our\s+)?(approved\s+|eligible\s+)?hiring\s+locations?\b/g },
    { reason: 'state_restricted', re: /\bapproved\s+(hiring\s+)?locations?\b/g },
    { reason: 'state_restricted', re: /\beligible\s+(hiring\s+)?locations?\b/g },
    { reason: 'residents_of_state', re: /\bresidents?\s+of\s+(?!the\s+united\s+states\b|the\s+us\b)[a-z]/g },
    { reason: 'can_only_hire_in', re: /\b(we\s+can\s+only\s+hire\s+in|only\s+hire\s+in|hiring\s+only\s+in)\b/g },
    { reason: 'remote_with_location', re: /\bremote\s+[-–—]\s*(?!(united\s+states|us|usa)\b)[a-z]/g },
    { reason: 'remote_with_location', re: /\bremote\s*\(\s*(?!(united\s+states|us|usa)\b)[a-z]/g },
    { reason: 'non_us_currency', re: /[£€₹]/g },
    // Currency codes count ONLY with currency context: an amount before the
    // code ("$80,000 CAD", "80000 EUR"), the code before a number or $
    // ("CAD $80,000", "EUR 50,000"), or a C$/A$/CA$ prefix. A bare "CAD" is a
    // skill/discipline (AutoCAD, CAD files) and must NOT reject a US
    // engineering job (Genspark round 5: the old bare \b(cad|...)\b did).
    { reason: 'non_us_currency', re: /\$?\d[\d,]*\s*(cad|aud|gbp|eur|inr|nzd)\b/g },
    { reason: 'non_us_currency', re: /\b(cad|aud|gbp|eur|inr|nzd)\s*(\$|\d[\d,]*\b)/g },
    { reason: 'non_us_currency', re: /\b(ca|[ca])\$\s?\d/g },
  ];

  for (const rule of hardRejects) {
    for (const f of fields) {
      // The "-only" rule needs the word to be a US state name.
      if (rule.reason === 'state_restricted' && rule.re.source.includes('\\w+\\s*-\\s*only')) {
        const mm = /\b([a-z]+)\s*-\s*only\b/g;
        let hit;
        while ((hit = mm.exec(f.text)) !== null) {
          if (US_STATES.includes(hit[1]) && !isNegated(f.text, hit.index)) {
            return fail('state_restricted', sentenceOf(f.text, hit.index), f.name);
          }
        }
        continue;
      }
      const hit = findRealMatch(f.text, rule.re, rule.exclude || null);
      if (hit) return fail(rule.reason, sentenceOf(f.text, hit.index), f.name);
    }
  }

  // Case-sensitive "except IN" (round 8): uppercase IN in an exclusion
  // context on the ORIGINAL-CASE text. Offsets align with the normalized
  // text (clean().toLowerCase() === normalize()), so the negation check
  // runs on the normalized field at the same index. Evidence comes from
  // the raw field so the vote-visible sentence keeps its capitals.
  const rawFields = [
    { name: 'title', text: rawTitle },
    { name: 'location', text: rawLocation },
    { name: 'description', text: rawDescription },
  ];
  for (let i = 0; i < fields.length; i++) {
    const rawHit = findUppercaseInExclusion(rawFields[i].text);
    if (rawHit && !isNegated(fields[i].text, rawHit.triggerIndex)) {
      return fail('state_restricted', sentenceOf(rawFields[i].text, rawHit.index), fields[i].name);
    }
  }

  // Non-US country / metro anywhere in the text (fail-closed: a posting for a
  // US-wide remote role has no reason to name a foreign country or city).
  for (const f of fields) {
    for (const c of NON_US_COUNTRIES) {
      const re = new RegExp(`\\b${c.replace(/ /g, '\\s+')}\\b`, 'g');
      const hit = findRealMatch(f.text, re);
      if (hit) return fail('non_us_location', sentenceOf(f.text, hit.index), f.name);
    }
    for (const city of NON_US_METROS) {
      const re = new RegExp(`\\b${city.replace(/ /g, '\\s+')}\\b`, 'g');
      const hit = findRealMatch(f.text, re);
      if (hit) return fail('non_us_location', sentenceOf(f.text, hit.index), f.name);
    }
  }

  // Street address in the location field = an on-site job location.
  if (/\b\d{1,6}\s+[a-z]+\s+(road|street|avenue|drive|blvd|boulevard|lane|way|court|plaza|parkway)\b/.test(location)) {
    return fail('street_address_location', location, 'location');
  }
  // A bare city/state location with no US-wide language in the description
  // (DeepSeek: city/state alone is not US-wide).
  if (/^[a-z][a-z\s]+,\s*[a-z]{2}$/.test(location) || /^[a-z][a-z\s]+$/.test(location) && stateTokenPresent(location)) {
    const usWide = /\b(us[-\s]?wide|anywhere\s+in\s+the\s+(us|united\s+states)|all\s+50\s+states|nationwide|open\s+nationwide)\b/.test(description);
    if (!usWide) return fail('location_not_us_wide', location, 'location');
  }

  // --- 4. Positive remote evidence required ----------------------------------
  const POSITIVE = [
    /\bfully\s+remote\b/,
    /\b100%\s*remote\b/,
    /\bremote[-\s]?first\b/,
    /\bwork\s+from\s+anywhere\s+in\s+the\s+(us|u\.s\.|united\s+states)\b/,
    /\bremote\s+within\s+the\s+united\s+states\b/,
    /\btelecommut(e|ing)\b/,
    /\bthis\s+is\s+a\s+remote\s+position\b/,
    /\bremote\s*[-–—]\s*(united\s+states|us|usa)\b/,
    /\banywhere\s+in\s+the\s+(united\s+states|us)\b/,
    /\bwork\s+from\s+home\b/,
    /\bwfh\b/, // "WFH flexible" — same as "work from home", just abbreviated
    /\bwork\s+location:\s*remote\b/, // location-field phrasing ("Work location: Remote")
    /\bus[-\s]?wide\b/,
    /\ball\s+50\s+states\b/,
    /\bremote\s+position\s+.*\bunited\s+states\b/,
  ];
  // Positive evidence is checked on description, title, AND location
  // (round 9, Mistral #5): the ATS location field is first-party data,
  // and real postings put the remote-US assertion there ("Remote -
  // United States", "Remote, USA-based candidates only", "Work location:
  // Remote"). A bare "Remote" location still matches nothing here, so
  // the blank/bare-label failure modes are unchanged.
  let positiveHit = null;
  for (const re of POSITIVE) {
    const hit = findRealMatch(description, new RegExp(re.source, 'g'));
    if (hit) { positiveHit = { ...hit, field: 'description', text: description }; break; }
    const hitTitle = findRealMatch(title, new RegExp(re.source, 'g'));
    if (hitTitle) { positiveHit = { ...hitTitle, field: 'title', text: title }; break; }
    const hitLoc = findRealMatch(location, new RegExp(re.source, 'g'));
    if (hitLoc) { positiveHit = { ...hitLoc, field: 'location', text: location }; break; }
  }
  if (!positiveHit) {
    return fail('no_positive_remote_evidence', '(no explicit fully-remote US-wide statement found)', 'description');
  }

  // --- 5. US signal required --------------------------------------------------
  const US_SIGNAL = [
    /\bunited\s+states\b/,
    /\bremote\s*[-–—]\s*(us|usa)\b/,
    /\bremote\s*\(\s*(us|usa)\s*\)/, // "Remote (US)" paren form, same as the dash form (round 7, Genspark)
    /\bus[-\s]?wide\b/,
    /\ball\s+50\s+states\b/,
    /\bus[-\s]?based\b/,
    /\busa[-\s]?based\b/, // "USA-based candidates only" (round 9, Mistral #5)
    /\bacross\s+the\s+(us|u\.s\.|united\s+states)\b/, // "across the US" (round 9)
    // "across America" / "America-wide" (round 9, Mistral #5): the
    // word immediately after "across" must BE "america" — "across Latin
    // America" and "across North America" do NOT match (the qualifier
    // intervenes), so they are not US signals. A bare "america" on its
    // own is deliberately NOT a signal ("Latin America" must not pass).
    /\bacross\s+america\b/,
    /\bamerica[-\s]?wide\b/,
    // No bare dollar heuristic (round 5, Genspark): /\$\s?[\d,]+/ used to
    // count ANY dollar figure as US evidence, contradicting data/README.md,
    // which forbids USD salary as HQ evidence. A global-remote posting with
    // "work from home" + "$60,000" passed on the dollar alone. A geographic
    // US signal is required; W-2 / 401(k) stay (US-specific instruments,
    // not mere currency). W-2 is lowercase here on purpose: the combined
    // text is lowercase-normalized, so the old case-sensitive /\bW-2\b/
    // was dead code that never fired (round 9, Mistral #5).
    /\bw-2\b/,
    /401\(k\)/,
    /\bee?o\b/,
    /\be-verify\b/,
    /\bauthorized\s+to\s+work\s+in\s+the\s+(us|united\s+states)\b/,
    /\bnationwide\b/,
  ];
  const hasUsSignal = [...US_SIGNAL].some((re) => re.test(combined));
  if (!hasUsSignal) {
    return fail('no_us_signal', '(remote wording present but no US-wide / United States signal)', 'description');
  }

  return {
    verdict: 'ACCEPT',
    reason: 'passed',
    // Evidence comes from the SAME field the match came from. A title-only
    // match must never have its title offset applied to the description.
    evidence: sentenceOf(positiveHit.text, positiveHit.index),
    field: positiveHit.field,
  };
}

module.exports = { verifyPosting, normalize, clean, US_STATES, US_STATE_ABBREV };
