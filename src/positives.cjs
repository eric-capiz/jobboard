// positives.json — hand-written fixtures for the accept path and tricky edges.
// The 309 sweep fixtures are ALL expected REJECT, so a verifier that rejects
// everything would pass that gate trivially. These fixtures prove the accept
// path works: every expected-ACCEPT case must be accepted, every
// expected-REJECT edge must be rejected. Positive texts are drawn from the
// consults' own pass/fail examples (ChatGPT, Perplexity, Genspark).
// Each description is padded with the same neutral boilerplate as the sweep
// fixtures so length rules apply equally.
const NEUTRAL = ' We are looking for a motivated team member to join our team. '
  + 'You will support customers by phone, email, and chat, and help resolve questions '
  + 'about products and services. This is a full-time position with benefits including '
  + 'health insurance, paid time off, and a 401(k) retirement plan. We are an equal '
  + 'opportunity employer and welcome all qualified applicants. The schedule is Monday '
  + 'through Friday during standard business hours.';

const P = (id, title, location, text, expected) => ({
  id, company: 'Fixture', title, location,
  description: text + NEUTRAL,
  applyUrl: 'https://example.com/jobs/' + id,
  expected, source: 'hand-written', provenance: 'hand-written',
});

module.exports = [
  // --- Expected ACCEPT (must pass the gate) ---
  P('pos-01', 'Customer Success Manager', 'Remote - United States',
    'Remote in all 50 states; no travel or office attendance required. This is a fully remote position.', 'ACCEPT'),
  P('pos-02', 'Support Specialist', 'Remote - US',
    '100% remote, US-based employees. Work from anywhere in the US.', 'ACCEPT'),
  P('pos-03', 'Customer Service Representative', 'United States',
    'This position can be performed remotely from any US state. Fully remote.', 'ACCEPT'),
  P('pos-04', 'Technical Support Agent', 'Remote - United States',
    'Remote - United States. No travel required. This is a remote position.', 'ACCEPT'),
  P('pos-05', 'Client Services Associate', 'United States',
    'Fully remote. Work from anywhere in the United States. United States only.', 'ACCEPT'),
  P('pos-06', 'Member Services Representative', 'Remote - US',
    'Telecommute position, remote within the United States. Must be authorized to work in the US.', 'ACCEPT'),
  P('pos-07', 'Customer Care Specialist', 'Remote - United States',
    'Remote-first company, this role is 100% remote, US-wide, no office attendance required, no travel required.', 'ACCEPT'),
  P('pos-08', 'Help Desk Technician', 'Remote - United States',
    'Work from home. Remote - US. No relocation required.', 'ACCEPT'),
  P('pos-09', 'Customer Support Lead', 'United States',
    'This is a fully remote role open to candidates anywhere in the US. No travel required.', 'ACCEPT'),
  P('pos-10', 'Service Desk Analyst', 'Remote - US',
    'Remote (US). 100% remote. Candidates must be based in the United States.', 'ACCEPT'),
  P('pos-11', 'Customer Experience Associate', 'Remote - United States',
    'Work from anywhere in the US. Fully remote, no office, no travel.', 'ACCEPT'),
  P('pos-12', 'Support Engineer', 'Remote - United States',
    'Distributed team, fully remote across the United States. No in-office days required.', 'ACCEPT'),
  P('pos-13', 'Client Support Representative', 'Remote - United States',
    'Remote position - United States. This role is 100% remote with no travel and no office requirement.', 'ACCEPT'),
  P('pos-14', 'Customer Service Agent', 'Remote - US',
    'Telecommute. Remote within the United States. Must be authorized to work in the United States.', 'ACCEPT'),
  P('pos-15', 'Technical Support Representative', 'Remote - US',
    '100% remote role. Location: Remote - US. No hybrid schedule. No onsite requirement.', 'ACCEPT'),
  // --- Expected REJECT edges (must be rejected) ---
  P('neg-01', 'Customer Service Representative', 'Remote - California',
    'This role is 100% remote, based in California. Work from home.', 'REJECT'),
  P('neg-02', 'Support Specialist', 'Remote - US',
    'Fully remote role open to candidates in the US or Canada.', 'REJECT'),
  P('neg-03', 'Customer Care Associate', 'Remote',
    'Hybrid role, 2 days per week in the office. Fully remote the rest of the week.', 'REJECT'),
  P('neg-04', 'Client Services Manager', 'Remote - United States',
    'Fully remote within the United States. Up to 25% travel required.', 'REJECT'),
  P('neg-05', 'Member Support Representative', 'Remote',
    '100% remote. Must reside in Texas.', 'REJECT'),
  P('neg-06', 'Customer Support Agent', 'Remote - London, UK',
    'Fully remote role, work from home.', 'REJECT'),
  P('neg-07', 'Technical Support Analyst', 'Remote - United States',
    'Fully remote in the US. Salary £50,000 - £60,000 per year.', 'REJECT'),
  P('neg-08', 'Customer Service Representative', 'Remote',
    'This is a remote position, but you must be able to commute to our Austin office.', 'REJECT'),
  P('neg-09', 'Support Coordinator', 'Remote - United States',
    'Remote within the United States. Quarterly onsite gathering required.', 'REJECT'),
  P('neg-10', 'Future Remote Opportunities', 'Remote - United States',
    'Join our talent community for future remote opportunities. No current openings.', 'REJECT'),
  // --- Expected ACCEPT edges (consult rules: these must NOT reject) ---
  P('pos-16', 'Customer Support Specialist', 'Remote - United States',
    'Fully remote within the United States. Salary range: CA $80k, CO $75k, NY $85k, WA $82k.', 'ACCEPT'),
  P('pos-17', 'Cloud Support Engineer', 'Remote - United States',
    'Hybrid cloud engineer, fully remote in the US. You will work with hybrid cloud infrastructure. No travel required.', 'ACCEPT'),
  P('pos-18', 'Customer Care Representative', 'Remote - United States',
    'Not a hybrid role. This is a fully remote position with no onsite requirement. Work from anywhere in the US.', 'ACCEPT'),
  // --- Expected REJECT: approved/eligible hiring-location language (round 3) ---
  P('neg-11', 'Customer Service Representative', 'Remote - United States',
    'This is a remote position. Candidates may work remotely, subject to our approved hiring locations.', 'REJECT'),
  P('neg-12', 'Support Specialist', 'Remote - United States',
    'Work from home. This role is open to candidates in our eligible hiring locations across the country.', 'REJECT'),
  P('neg-13', 'Customer Support Agent', 'Remote - United States',
    'Fully remote within the United States. Must be in an approved location to work.', 'REJECT'),
  // --- Round 5 (Genspark): CAD skill vs CAD currency; optional vs required
  // --- travel; coverage "days per week" vs office attendance; dollar-only US signal ---
  P('pos-19', 'CAD Designer', 'Remote - United States',
    'Fully remote in the United States. You will create drawings in AutoCAD and review CAD files daily.', 'ACCEPT'),
  P('neg-14', 'CAD Designer', 'Remote - United States',
    'Fully remote in the United States. Salary: $80,000 CAD per year. You will create drawings and review files daily.', 'REJECT'),
  P('pos-20', 'Customer Success Manager', 'Remote - United States',
    'Fully remote in the United States. You may occasionally travel to team meetings.', 'ACCEPT'),
  P('neg-15', 'Customer Success Manager', 'Remote - United States',
    'Fully remote in the United States. You must travel to client sites.', 'REJECT'),
  P('pos-21', 'Support Specialist', 'Remote - United States',
    'Fully remote in the United States. Our support team provides coverage 5 days per week.', 'ACCEPT'),
  P('neg-16', 'Customer Support Agent', 'Remote - United States',
    'Fully remote in the United States. You will work 2 days per week in the office.', 'REJECT'),
  // neg-17: a global-remote posting whose ONLY "US signal" is a dollar
  // salary must REJECT. Custom object, NOT P(): the shared NEUTRAL
  // boilerplate contains "401(k)", a genuine US signal, which would mask
  // the dollar-only test.
  {
    id: 'neg-17', company: 'Fixture', title: 'Customer Support Agent',
    location: 'Remote',
    description: 'Work from home. This is a fully remote role. Salary $60,000 per year. '
      + 'You will support customers by phone, email, and chat, and help resolve questions '
      + 'about products and services. This is a full-time position with benefits including '
      + 'health insurance and paid time off. We welcome all qualified applicants. The schedule '
      + 'is Monday through Friday during standard business hours. You will work with a friendly '
      + 'team and have clear goals and regular feedback. Strong written communication skills and '
      + 'attention to detail are important. Experience with customer support tools is helpful but '
      + 'not required. We provide training and the equipment you need to do the job well.',
    applyUrl: 'https://example.com/jobs/neg-17',
    expected: 'REJECT', source: 'hand-written', provenance: 'hand-written',
  },
  // --- Round 6: state exclusions cover ALL 50 states + DC (ChatGPT
  // re-vote #3). The old 16-state subset let "except Idaho" through.
  P('neg-18', 'Customer Success Manager', 'Remote - United States',
    'Fully remote within the United States, except Idaho. This is a fully remote position.', 'REJECT'),
  P('neg-19', 'Support Specialist', 'Remote - United States',
    'Fully remote within the United States, excluding Maine. This is a fully remote position.', 'REJECT'),
  P('neg-20', 'Customer Care Associate', 'Remote - United States',
    'Fully remote within the United States. Not available in Mississippi. This is a fully remote position.', 'REJECT'),
  P('neg-21', 'Customer Service Representative', 'Remote - United States',
    'Fully remote within the United States, except residents of Vermont. This is a fully remote position.', 'REJECT'),
  P('pos-22', 'Customer Success Manager', 'Remote - United States',
    'Fully remote within the United States. Our headquarters is in Idaho and our team collaborates online daily. This is a fully remote position.', 'ACCEPT'),
  // --- Round 7 (Genspark re-vote): "required to travel" arm, CA$ prefix,
  // --- "Remote (US)" paren form in the US signal ---
  P('neg-22', 'Customer Success Manager', 'Remote - United States',
    'Fully remote in the United States. You are required to travel to HQ twice a year.', 'REJECT'),
  P('neg-23', 'Customer Success Manager', 'Remote - United States',
    'Fully remote in the United States. This role requires travel to client sites twice a month.', 'REJECT'),
  P('neg-24', 'CAD Designer', 'Remote - United States',
    'Fully remote in the United States. Salary CA$70,000 per year. You will create drawings and review files daily.', 'REJECT'),
  // pos-23: location "Remote (US)" must ACCEPT with NO other US signal in
  // the text. Custom object, NOT P(): the shared NEUTRAL boilerplate
  // contains "401(k)", a genuine US signal, which would mask the test.
  {
    id: 'pos-23', company: 'Fixture', title: 'Customer Success Manager',
    location: 'Remote (US)',
    description: 'Fully remote role. Work from home anywhere in the country. '
      + 'You will support customers by phone, email, and chat, and help resolve questions '
      + 'about products and services. This is a full-time position with benefits including '
      + 'health insurance and paid time off. We welcome all qualified applicants. The schedule '
      + 'is Monday through Friday during standard business hours. You will work with a friendly '
      + 'team and have clear goals and regular feedback. Strong written communication skills and '
      + 'attention to detail are important. Experience with customer support tools is helpful but '
      + 'not required. We provide training and the equipment you need to do the job well.',
    applyUrl: 'https://example.com/jobs/pos-23',
    expected: 'ACCEPT', source: 'hand-written', provenance: 'hand-written',
  },
  // --- Round 8 (ChatGPT re-vote #4): case-sensitive "except IN". The
  // --- normalized text cannot tell Indiana's abbreviation "IN" from the
  // --- ordinary word "in", so the old code ACCEPTed "except IN". The
  // --- verifier now checks the original-case text: uppercase IN in an
  // --- exclusion context rejects; lowercase "in rare cases" still accepts.
  P('neg-25', 'Customer Success Manager', 'Remote - United States',
    'Fully remote within the United States, except IN. This is a fully remote position.', 'REJECT'),
  P('pos-24', 'Customer Success Manager', 'Remote - United States',
    'Fully remote within the United States, except in rare cases approved by your manager. This is a fully remote position.', 'ACCEPT'),
  // --- Round 9 (ChatGPT re-vote #5): all-caps IN disambiguation, mixed-case
  // --- forms. In a mixed-case sentence an uppercase IN still rejects
  // --- (round-8 behaviour, unchanged); lowercase "in" still accepts.
  // --- pos-35 is the per-sentence case: a mixed-case posting whose
  // --- trigger sentence is all-caps ("EXCEPT IN RARE CASES.") accepts.
  P('neg-30', 'Customer Success Manager', 'Remote - United States',
    'Fully remote within the United States, except IN residents. This is a fully remote position.', 'REJECT'),
  P('neg-31', 'Customer Success Manager', 'Remote - United States',
    'Fully remote within the United States, except IN certain circumstances. This is a fully remote position.', 'REJECT'),
  P('pos-31', 'Customer Success Manager', 'Remote - United States',
    'Fully remote within the United States, except in certain circumstances. This is a fully remote position.', 'ACCEPT'),
  P('pos-35', 'Customer Success Manager', 'Remote - United States',
    'Fully remote within the United States. EXCEPT IN RARE CASES. This is a fully remote position.', 'ACCEPT'),
  // --- Round 9 (Mistral #5): recall gaps. Real phrasings the old signal
  // --- lists missed, all fail-closed (they REJECTed instead of
  // --- ACCEPTing). Custom objects, NOT P(): the shared NEUTRAL
  // --- boilerplate contains "401(k)", a genuine US signal, which would
  // --- mask the test — each fixture below isolates exactly ONE new
  // --- signal, with a signal-free filler (no United States / US /
  // --- nationwide / 401(k) / W-2 / E-Verify / authorized / EEO / America).
  // --- The two traps must still REJECT on the new code.
  ...(() => {
    const NO_SIGNAL_FILLER = 'You will support customers by phone, email, and chat, and help resolve questions '
      + 'about products and services. This is a full-time position with benefits including '
      + 'health insurance and paid time off. We welcome all qualified applicants. The schedule '
      + 'is Monday through Friday during standard business hours. You will work with a friendly '
      + 'team and have clear goals and regular feedback. Strong written communication skills and '
      + 'attention to detail are important. Experience with customer support tools is helpful but '
      + 'not required. We provide training and the equipment you need to do the job well.';
    const C = (id, title, location, text, expected) => ({
      id, company: 'Fixture', title, location,
      description: text + ' ' + NO_SIGNAL_FILLER,
      applyUrl: 'https://example.com/jobs/' + id,
      expected, source: 'hand-written', provenance: 'hand-written',
    });
    return [
      C('pos-25', 'Customer Support Agent', 'Remote',
        'Our distributed team works across America. This is a fully remote position. Work from home.', 'ACCEPT'),
      C('pos-26', 'Customer Support Agent', 'Remote - United States',
        'WFH flexible schedule with no office days. You will support customers by phone and email.', 'ACCEPT'),
      C('pos-27', 'Customer Support Agent', 'Work location: Remote',
        'We are hiring a customer support agent for our team in the United States. You will help customers by phone and email.', 'ACCEPT'),
      C('pos-28', 'Customer Support Agent', 'Remote, USA-based candidates only',
        'This is a fully remote position. You will support customers by phone and email.', 'ACCEPT'),
      C('pos-29', 'Customer Support Agent', 'Remote',
        'This is a fully remote position. We offer W-2 employment with benefits and paid time off.', 'ACCEPT'),
      C('pos-30', 'Customer Support Agent', 'Remote',
        'This is a fully remote position. Work from anywhere across the US.', 'ACCEPT'),
      C('neg-26', 'Customer Support Agent', 'Remote',
        'This is a fully remote position. Our distributed team works across Latin America. Work from home.', 'REJECT'),
      C('neg-27', 'Customer Support Agent', 'Remote',
        'WFH flexible schedule with no office days. Our team is based in Toronto, Canada.', 'REJECT'),
    ];
  })(),
  // --- Round 9 (ChatGPT re-vote #5): all-caps IN disambiguation, all-caps
  // --- forms. The whole posting is uppercased (title/location/description
  // --- incl. filler) — the exact case round 8's guard skipped. Custom
  // --- objects with an ALL-CAPS signal-free filler, same reason as above.
  ...(() => {
    const CAPS_FILLER = 'YOU WILL SUPPORT CUSTOMERS BY PHONE, EMAIL, AND CHAT, AND HELP RESOLVE QUESTIONS '
      + 'ABOUT PRODUCTS AND SERVICES. THIS IS A FULL-TIME POSITION WITH BENEFITS INCLUDING '
      + 'HEALTH INSURANCE AND PAID TIME OFF. WE WELCOME ALL QUALIFIED APPLICANTS. THE SCHEDULE '
      + 'IS MONDAY THROUGH FRIDAY DURING STANDARD BUSINESS HOURS. YOU WILL WORK WITH A FRIENDLY '
      + 'TEAM AND HAVE CLEAR GOALS AND REGULAR FEEDBACK. STRONG WRITTEN COMMUNICATION SKILLS AND '
      + 'ATTENTION TO DETAIL ARE IMPORTANT. EXPERIENCE WITH CUSTOMER SUPPORT TOOLS IS HELPFUL BUT '
      + 'NOT REQUIRED. WE PROVIDE TRAINING AND THE EQUIPMENT YOU NEED TO DO THE JOB WELL.';
    const CC = (id, text, expected) => ({
      id, company: 'Fixture', title: 'CUSTOMER SUPPORT AGENT', location: 'REMOTE - UNITED STATES',
      description: text + ' ' + CAPS_FILLER,
      applyUrl: 'https://example.com/jobs/' + id,
      expected, source: 'hand-written', provenance: 'hand-written',
    });
    return [
      CC('neg-28', 'FULLY REMOTE WITHIN THE UNITED STATES, EXCEPT IN. THIS IS A FULLY REMOTE POSITION.', 'REJECT'),
      CC('neg-29', 'FULLY REMOTE WITHIN THE UNITED STATES, EXCEPT IN RESIDENTS. THIS IS A FULLY REMOTE POSITION.', 'REJECT'),
      CC('neg-32', 'FULLY REMOTE WITHIN THE UNITED STATES, EXCEPT IN APPLICANTS. THIS IS A FULLY REMOTE POSITION.', 'REJECT'),
      CC('pos-32', 'FULLY REMOTE WITHIN THE UNITED STATES, EXCEPT IN RARE CASES. THIS IS A FULLY REMOTE POSITION.', 'ACCEPT'),
      CC('pos-33', 'FULLY REMOTE WITHIN THE UNITED STATES, EXCEPT IN CERTAIN CIRCUMSTANCES. THIS IS A FULLY REMOTE POSITION.', 'ACCEPT'),
      CC('pos-34', 'FULLY REMOTE WITHIN THE UNITED STATES, EXCEPT IN SOME CASES. THIS IS A FULLY REMOTE POSITION.', 'ACCEPT'),
    ];
  })(),
];
