// resolver-test.cjs — unit tests for the ATS resolver using canned HTML.
// No network: each fixture is a snippet of the kind of careers-page HTML
// the resolver will see in Actions (script/iframe src tokens).
'use strict';

const { resolveAts } = require('./resolver.cjs');

const cases = [
  {
    name: 'greenhouse iframe',
    domain: 'acme.com',
    html: '<html><body><iframe src="https://job-boards.greenhouse.io/acme"></iframe></body></html>',
    url: 'https://acme.com/careers',
    expect: { ats: 'greenhouse', slug: 'acme', crawlable: true },
  },
  {
    name: 'greenhouse api token in script',
    domain: 'globex.com',
    html: '<script src="https://boards-api.greenhouse.io/v1/boards/globex/jobs?content=true"></script>',
    url: 'https://globex.com/jobs',
    expect: { ats: 'greenhouse', slug: 'globex', crawlable: true },
  },
  {
    name: 'greenhouse embed widget for= token (ingest pilot: Acumen/Ad Council)',
    domain: 'acumen.org',
    html: '<script src="https://boards.greenhouse.io/embed/job_board/js?for=acumen"></script>',
    url: 'https://acumen.org/jobs/',
    expect: { ats: 'greenhouse', slug: 'acumen', crawlable: true },
  },
  {
    name: 'greenhouse embed path without for= never yields slug "embed"',
    domain: 'example.com',
    html: '<script src="https://boards.greenhouse.io/embed/job_board/js"></script>',
    url: 'https://example.com/jobs',
    expect: { ats: 'greenhouse', crawlable: false },
  },
  {
    name: 'lever',
    domain: 'initech.com',
    html: '<a href="https://jobs.lever.co/initech">See jobs</a>',
    url: 'https://initech.com/careers',
    expect: { ats: 'lever', slug: 'initech', crawlable: true },
  },
  {
    name: 'ashby',
    domain: 'umbrella.com',
    html: '<script>fetch("https://api.ashbyhq.com/posting-api/job-board/umbrella")</script><iframe src="https://jobs.ashbyhq.com/umbrella"></iframe>',
    url: 'https://umbrella.com/careers',
    expect: { ats: 'ashby', slug: 'umbrella', crawlable: true },
  },
  {
    name: 'workday tenant+site',
    domain: 'hooli.com',
    html: '<a href="https://hooli.wd5.myworkdayjobs.com/en-US/hoolicareers">Careers</a>',
    url: 'https://hooli.wd5.myworkdayjobs.com/en-US/hoolicareers',
    expect: { ats: 'workday', slug: 'hooli/hoolicareers', crawlable: true },
  },
  {
    name: 'workday host captured from wd number (not wd5 default)',
    domain: 'acme.com',
    html: '<a href="https://acme.wd1.myworkdayjobs.com/en-US/ACME-Careers">Careers</a>',
    url: 'https://acme.com/careers',
    expect: { ats: 'workday', slug: 'acme/ACME-Careers', crawlable: true },
  },
  {
    name: 'smartrecruiters',
    domain: 'stark.com',
    html: '<iframe src="https://careers.smartrecruiters.com/StarkIndustries"></iframe>',
    url: 'https://stark.com/careers',
    expect: { ats: 'smartrecruiters', slug: 'StarkIndustries', crawlable: true },
  },
  {
    name: 'icims',
    domain: 'wayne.com',
    html: '<a href="https://careers-wayne.icims.com/jobs">Jobs</a>',
    url: 'https://careers-wayne.icims.com/jobs',
    expect: { ats: 'icims', slug: 'wayne', crawlable: true },
  },
  {
    name: 'taleo',
    domain: 'massive.com',
    html: '<a href="https://massive.taleo.net/careersection">Apply</a>',
    url: 'https://massive.taleo.net/careersection',
    expect: { ats: 'taleo', slug: 'massive', crawlable: true },
  },
  {
    name: 'successfactors family only (no slug, not crawlable)',
    domain: 'oldcorp.com',
    html: '<script src="https://oldcorp.successfactors.com/careers"></script>',
    url: 'https://oldcorp.com/careers',
    expect: { ats: 'successfactors', crawlable: false },
  },
  {
    name: 'unresolved plain careers page',
    domain: 'momandpop.com',
    html: '<html><body><h1>Join our team</h1><a href="/jobs/baker">Baker</a></body></html>',
    url: 'https://momandpop.com/careers',
    expect: { ats: 'unresolved', crawlable: false },
  },
  {
    name: 'blog page trap (no ATS token)',
    domain: 'bloggy.com',
    html: '<html><body><h1>Why we love remote work</h1><p>Our team works from home...</p></body></html>',
    url: 'https://bloggy.com/blog/remote-work',
    expect: { ats: 'unresolved', crawlable: false },
  },
  {
    name: 'workable widget',
    domain: 'startup.io',
    html: '<script src="https://apply.workable.com/api/v1/widget/accounts/startup-io?details=true"></script>',
    url: 'https://startup.io/careers',
    expect: { ats: 'workable', slug: 'startup-io', crawlable: true },
  },
];

let failures = 0;
for (const c of cases) {
  const got = resolveAts(c.domain, c.html, c.url);
  const ok = got.ats === c.expect.ats
    && got.crawlable === c.expect.crawlable
    && (c.expect.slug === undefined || got.slug === c.expect.slug);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name}: ats=${got.ats} slug=${got.slug || '-'} crawlable=${got.crawlable}`);
  if (!ok) {
    failures++;
    console.log(`  expected: ${JSON.stringify(c.expect)}`);
  }
}
console.log(failures === 0 ? 'RESOLVER TESTS: PASS' : `RESOLVER TESTS: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
