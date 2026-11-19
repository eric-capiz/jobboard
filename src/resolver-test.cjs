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
    name: 'icims bare-tenant form (68 entries were detected-not-crawlable)',
    domain: 'smumn.edu',
    html: '<a href="https://faculty-saintmarysuniversity.icims.com/jobs">Jobs</a>',
    url: 'https://smumn.edu/careers',
    expect: { ats: 'icims', slug: 'faculty-saintmarysuniversity', crawlable: true },
  },
  {
    name: 'icims vendor subdomain never yields a slug',
    domain: 'example.com',
    html: '<a href="https://www.icims.com/products">iCIMS</a><script src="https://api.icims.com/x.js"></script>',
    url: 'https://example.com/careers',
    expect: { ats: 'icims', crawlable: false },
  },
  {
    name: 'icims careers- form still wins over bare form',
    domain: 'wayne.com',
    html: '<a href="https://careers-wayne.icims.com/jobs">Jobs</a><a href="https://wayne.icims.com/other">x</a>',
    url: 'https://careers-wayne.icims.com/jobs',
    expect: { ats: 'icims', slug: 'wayne', crawlable: true },
  },
  {
    name: 'workable widget',
    domain: 'startup.io',
    html: '<script src="https://apply.workable.com/api/v1/widget/accounts/startup-io?details=true"></script>',
    url: 'https://startup.io/careers',
    expect: { ats: 'workable', slug: 'startup-io', crawlable: true },
  },
  // --- Second wave (2026-11-19, new-ats-families.md) ---
  {
    name: 'neogov reporting-only',
    domain: 'yourmetrobus.org',
    html: '<a href="https://www.governmentjobs.com/careers/yourmetrobus">Jobs</a>',
    url: 'https://yourmetrobus.org/metro-jobs.aspx',
    expect: { ats: 'neogov', crawlable: false },
  },
  {
    name: 'schooljobs resolves as schooljobs, not neogov (NEOGOV brand)',
    domain: 'mountunion.edu',
    html: '<a href="https://www.schooljobs.com/careers/mountunion">Jobs</a><p>Powered by NEOGOV</p>',
    url: 'https://mountunion.edu/careers',
    expect: { ats: 'schooljobs', crawlable: false },
  },
  {
    name: 'jobscore crawlable (feed.json, no auth)',
    domain: 'sesameworkshop.org',
    html: '<a href="https://careers.jobscore.com/careers/sesameworkshop">Jobs</a>',
    url: 'https://sesameworkshop.org/careers',
    expect: { ats: 'jobscore', slug: 'sesameworkshop', crawlable: true },
  },
  {
    name: 'pageup reporting-only (numeric tenant id)',
    domain: 'uah.edu',
    html: '<a href="https://careers.pageuppeople.com/1012/cw/en-us/listing">Jobs</a>',
    url: 'https://uah.edu/careers',
    expect: { ats: 'pageup', crawlable: false },
  },
  {
    name: 'adp workforcenow reporting-only (feed endpoint unverified)',
    domain: 'providencechc.org',
    html: '<a href="https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=07bdc9d7-07f0-4c27-b1d0-1d240cfec2c7">Jobs</a>',
    url: 'https://providencechc.org/careers',
    expect: { ats: 'adp-workforcenow', crawlable: false },
  },
  {
    name: 'adp myjobs crawlable (two-call feed, orgoid header)',
    domain: 'pepsico.com',
    html: '<a href="https://myjobs.adp.com/pbna">Jobs</a>',
    url: 'https://pepsico.com/careers',
    expect: { ats: 'adp-myjobs', slug: 'pbna', crawlable: true },
  },
  {
    name: 'oracle hcm object slug (tenant/site/host like workday)',
    domain: 'marriott.com',
    html: '<a href="https://ejwl.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/requisitions">Careers</a>',
    url: 'https://careers.marriott.com',
    expect: { ats: 'oracle', slug: 'ejwl.fa.us2.oraclecloud.com/CX', crawlable: true },
  },
  {
    name: 'oracle bare oraclecloud.com without CandidateExperience does not resolve',
    domain: 'example.com',
    html: '<a href="https://www.oraclecloud.com/products">Oracle Cloud</a>',
    url: 'https://example.com/careers',
    expect: { ats: 'unresolved', crawlable: false },
  },
  {
    name: 'peoplematter reporting-only',
    domain: 'synq3.com',
    html: '<a href="https://my.peoplematter.com/mja/synq3/JobApp/Identification?alias=synq3">Apply</a>',
    url: 'https://synq3.com/careers',
    expect: { ats: 'peoplematter', crawlable: false },
  },
  {
    name: 'bamboohr crawlable (careers/list feed)',
    domain: 'scribd.com',
    html: '<a href="https://scribd.bamboohr.com/careers">Jobs</a>',
    url: 'https://scribd.com/careers',
    expect: { ats: 'bamboohr', slug: 'scribd', crawlable: true },
  },
  {
    name: 'jazzhr crawlable (XML feed)',
    domain: 'asymca.org',
    html: '<a href="https://asymca.applytojob.com/apply/jobs">Jobs</a>',
    url: 'https://asymca.org/careers',
    expect: { ats: 'jazzhr', slug: 'asymca', crawlable: true },
  },
  {
    name: 'paylocity reporting-only (GUID slug, partner-gated API)',
    domain: 'southernlumber.com',
    html: '<a href="https://recruiting.paylocity.com/recruiting/jobs/All/3d2b522f-2192-4090-8cfc-66ad4e035d14/Southern-Lumber">Jobs</a>',
    url: 'https://southernlumber.com/careers',
    expect: { ats: 'paylocity', crawlable: false },
  },
  {
    name: 'ukg reporting-only',
    domain: 'gray.tv',
    html: '<a href="https://recruiting.ultipro.com/graytv/JobBoard/abc">Jobs</a>',
    url: 'https://gray.tv/careers',
    expect: { ats: 'ukg', crawlable: false },
  },
  {
    name: 'breezy crawlable (json feed, no description)',
    domain: 'thirdchannel.com',
    html: '<a href="https://thirdchannel-inc.breezy.hr/">Jobs</a>',
    url: 'https://thirdchannel.com/careers',
    expect: { ats: 'breezy', slug: 'thirdchannel-inc', crawlable: true },
  },
  {
    name: 'fountain reporting-only (apply-page token required)',
    domain: 'ups.com',
    html: '<a href="https://us-2.fountain.com/apply/ups/opening/us-laguna-hub-driver">Apply</a>',
    url: 'https://ups.com/careers',
    expect: { ats: 'fountain', crawlable: false },
  },
  {
    name: 'fountain marketing site alone does not resolve',
    domain: 'example.com',
    html: '<a href="https://fountain.com/">Fountain</a>',
    url: 'https://example.com/careers',
    expect: { ats: 'unresolved', crawlable: false },
  },
  {
    name: 'hireology reporting-only',
    domain: 'hyatt.com',
    html: '<a href="https://careers.hireology.com/hyattneward">Jobs</a>',
    url: 'https://hyatt.com/careers',
    expect: { ats: 'hireology', crawlable: false },
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
