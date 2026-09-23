# Implementation plan: round-scoped elimination and four extraction fields

Execute the edits below in order. They are instructions for a later implementation pass; this file is the only deliverable of the present pass. Leave existing uncommitted changes intact. Do not change `isOlderThanCurrentStatus`, `STATUS_PRIORITY`, company/drive resolution, or sync batching. `extractJobDetails` is in `src/lib/sync/events.ts`, **not** `classifier.ts`. The relevant current schema is `supabase/schema.sql`: `candidate_matches` has `user_id`, `email_id`, `placement_drive_id`, `match_type`, and no round column; `events` has `event_type`, `venue`, and `mode`; `applications` has `role`, `ctc`, `stipend`, `location`, and no job work-mode column. The database `emails.body_snippet` contains substantial real message text. Apply the SQL migration before deploying code that writes the new columns.

## Fix 1 — immediately preceding round only

### 1. Add explicit match provenance

**File:** `supabase/migrations/migration_v22_candidate_match_round_and_work_mode.sql` (new file; this migration also carries Fix 2's work-mode column). **Insertion point:** whole new file. **Insert exactly:**

```sql
BEGIN;

ALTER TABLE public.candidate_matches ADD COLUMN IF NOT EXISTS matched_round_type text;
ALTER TABLE public.candidate_matches DROP CONSTRAINT IF EXISTS candidate_matches_matched_round_type_check;
ALTER TABLE public.candidate_matches ADD CONSTRAINT candidate_matches_matched_round_type_check
  CHECK (matched_round_type IS NULL OR matched_round_type IN ('test', 'interview', 'selected'));

-- Backfill only explicit round words, never infer round from dates or a bare "result".
UPDATE public.candidate_matches cm
SET matched_round_type = CASE
  WHEN e.subject ~* '(final[[:space:]]+selection|offer[[:space:]]+(letter|release)|selection[[:space:]]+list)' 
       AND e.subject !~* '(interview|test)' THEN 'selected'
  WHEN e.subject ~* '(interview|selection[[:space:]]+process)' THEN 'interview'
  WHEN e.subject ~* '(online[[:space:]]+test|coding[[:space:]]+test|assessment|test[[:space:]]+shortlist)' THEN 'test'
  ELSE NULL
END
FROM public.emails e
WHERE cm.email_id = e.id
  AND cm.matched_round_type IS NULL
  AND cm.match_type <> 'xlsx_applied_list'
  AND e.subject IS NOT NULL;

ALTER TABLE public.applications ADD COLUMN IF NOT EXISTS work_mode text;
ALTER TABLE public.applications DROP CONSTRAINT IF EXISTS applications_work_mode_check;
ALTER TABLE public.applications ADD CONSTRAINT applications_work_mode_check
  CHECK (work_mode IS NULL OR work_mode IN ('remote', 'office', 'hybrid'));

COMMIT;
```

**File:** `supabase/schema.sql`, table `public.candidate_matches`. **Insertion point:** immediately after `match_type TEXT NOT NULL CHECK (...)`. **Insert:** `  matched_round_type TEXT CHECK (matched_round_type IS NULL OR matched_round_type IN ('test', 'interview', 'selected')),`. **Reason:** a positive match must carry the announced round so an earlier match cannot masquerade as the immediately preceding one.

**File:** `supabase/schema.sql`, table `public.applications`. **Insertion point:** immediately after `location TEXT,`. **Insert:** `  work_mode TEXT CHECK (work_mode IS NULL OR work_mode IN ('remote', 'office', 'hybrid')),`. **Reason:** job work arrangement is distinct from `events.mode` (event attendance) and `notes` (campus travel).

**File:** `supabase/schema-simple.sql`, tables `public.candidate_matches` and `public.applications`. **Insertion points:** same `match_type` and `location` column lines respectively; insert the same two column declarations above, using the existing lowercase SQL style. Do not overwrite other edits to this file. **Reason:** keep the second schema dump in sync.

### 2. Classify only unambiguous announced rounds

**File:** `src/lib/sync/status-engine.ts`; **function:** new `announcedShortlistRound(subject: string, body: string)` directly before `processEmailForEventsAndStatus`. **Insertion point:** immediately before the docblock `/** Processes an email to extract events`. **Insert exactly:**

```ts
type ShortlistRound = 'test' | 'interview' | 'selected';

function announcedShortlistRound(subject: string, body: string): ShortlistRound | null {
  // Round order: ppt (open attendance; no shortlist) → test → interview → selected.
  // A missing test shortlist is NOT an elimination; interview requires a test match,
  // and final selection requires an interview match. An ambiguous "next round"/"result"
  // has no provable predecessor and must not cause rejection.
  if (/interview|selection\s+process/i.test(subject) ||
      (/next\s+round/i.test(subject) && /interview|in[\s-]*person|f2f/i.test(body))) return 'interview';
  if (/final\s*selection|offer\s*(?:letter|release)|selection\s*list/i.test(subject) &&
      !/interview|test/i.test(subject)) return 'selected';
  if (/online\s+test|coding\s+test|assessment|test\s+(?:shortlist|link|invitation|schedule)/i.test(subject)) return 'test';
  return null;
}
```

**Reason:** use an explicit round sequence; do not guess the meaning of a generic result email from its timestamp.

### 3. Tag new positive matches and check the correct predecessor

**File:** `src/lib/sync/status-engine.ts`; **function:** `processEmailForEventsAndStatus`. **Insertion point:** immediately after `const isShortlistEmail = ...;` (currently near line 194). **Insert:**

```ts
  const announcedRound = announcedShortlistRound(email.subject, fullText);
  const previousRound: ShortlistRound | null =
    announcedRound === 'interview' ? 'test' :
    announcedRound === 'selected' ? 'interview' : null;
```

**Reason:** the predecessor of an interview shortlist is test; the predecessor of a final list is interview; PPT has no shortlist match.

**Insertion point:** replace `if (isEliminationEmail && matchType === 'email_body') { isNeoMatched = false; }` (currently near line 299) with:

```ts
  if (isEliminationEmail) {
    // A mention in an elimination list (including an attached roster) is not a positive shortlist match.
    isNeoMatched = false;
  }
```

**Reason:** the positive-match branch otherwise assigns `rejected` without checking the predecessor and can persist an elimination-list match as positive evidence.

**Insertion point:** immediately after `if (hasPersonalTestCredentials && !isNeoMatched) { ... }` (currently near line 313). **Insert:** `  if (isEliminationEmail) isNeoMatched = false;`. **Reason:** a personal test-credentials heuristic must not re-enable an elimination-list match after the first elimination check.

**Insertion point:** in the `candidate_matches` `.insert({ ... })` payload (currently near line 317), immediately after `match_type: matchType,`. **Insert:**

```ts
      matched_round_type: (isShortlistEmail || hasPersonalTestCredentials) ? announcedRound : null,
```

**Additional edit at the same insertion block:** replace the existing `if (candidateMatchError && candidateMatchError.code !== '23505') { throw candidateMatchError; }` with:

```ts
    if (candidateMatchError?.code === '23505' && announcedRound &&
        (isShortlistEmail || hasPersonalTestCredentials)) {
      const { error: tagError } = await supabase.from('candidate_matches')
        .update({ matched_round_type: announcedRound })
        .eq('user_id', userId).eq('email_id', emailDbId)
        .eq('placement_drive_id', targetDriveId).eq('match_type', matchType);
      if (tagError) throw tagError;
    } else if (candidateMatchError) {
      throw candidateMatchError;
    }
```

**Reason:** a rerun must annotate an already-inserted match, rather than leave a historical `NULL` tag indefinitely.

**Insertion point:** just before `// 5. Compute updated application status` (currently near line 589). **Insert:**

```ts
  // Read only a positive match for the immediately preceding round of this drive.
  // Legacy/ambiguous NULL round tags do not prove elimination.
  let hasPreviousRoundMatch = false;
  if (previousRound) {
    const { data: previousMatches, error: previousMatchError } = await supabase
      .from('candidate_matches')
      .select('id, emails!inner(received_at)')
      .eq('user_id', userId)
      .eq('placement_drive_id', targetDriveId)
      .eq('matched_round_type', previousRound)
      .neq('match_type', 'xlsx_applied_list');
    if (previousMatchError) throw previousMatchError;
    hasPreviousRoundMatch = (previousMatches || []).some((match) => {
      const source = match.emails as unknown as { received_at: string | null };
      return Boolean(source?.received_at &&
        new Date(source.received_at).getTime() < new Date(email.receivedAt).getTime());
    });
  }
```

**Reason:** enforce drive, predecessor round, and source-email ordering; unknown provenance fails closed.

**Insertion point:** in the `if (isNeoMatched)` status branch, replace `if (isRejectionLanguage) { newStatus = 'rejected'; }` with `if (isRejectionLanguage) { newStatus = hasPreviousRoundMatch ? 'rejected' : 'not_shortlisted'; }`. **Reason:** even a direct rejection email cannot establish elimination without the immediately preceding shortlist match.

**Insertion point:** inside `if (isPostTestRound) {` in the unmatched-shortlist branch (currently near line 689), replace the entire block from `// Check if user had an actual confirmed shortlist match in the database` through the last `newStatus = 'not_shortlisted';` before the matching `} else { // It is a test or screening shortlist email` with:

```ts
        hasConfirmedShortlistMatch = hasPreviousRoundMatch;
        const { data: upcomingEvents } = await supabase
          .from('events').select('start_time, event_type')
          .eq('user_id', userId).eq('placement_drive_id', targetDriveId)
          .in('event_type', ['online_test', 'coding_test']);
        const hasFutureTestEvent = upcomingEvents?.some((ev) =>
          Boolean(ev.start_time && new Date(ev.start_time).getTime() > Date.now()));

        if (hasPreviousRoundMatch && !hasFutureTestEvent) {
          newStatus = 'rejected';
        } else if (hasPreviousRoundMatch && hasFutureTestEvent) {
          newStatus = 'test_scheduled';
        } else {
          newStatus = 'not_shortlisted';
        }
```

**Reason:** replace the existing any-round `compMatches` query and current-status/timestamp heuristics with the exact immediately preceding round check; retain the existing future-test protection. Keep the recency and priority guards below this branch byte-for-byte unchanged.

### 4. Keep other match writers and holistic recalculation consistent

**File:** `src/lib/sync/attachment-scanner.ts`; **function:** `scanAndPersistCandidateMatches`. **Insertion point:** immediately after `match_type: 'xlsx_cell',` in its `candidate_matches` insert (near line 135). **Insert:**

```ts
          matched_round_type: /interview|selection\s+process/i.test(email.subject || '') ? 'interview'
            : /final\s*selection|selection\s*list/i.test(email.subject || '') ? 'selected'
            : /online\s+test|coding\s+test|assessment|test\s+shortlist/i.test(email.subject || '') ? 'test'
            : null,
```

**Reason:** matches discovered during a later attachment scan need the same explicit provenance; this file has existing user edits, so insert without reverting them.

**File:** `src/app/api/sync/reprocess/route.ts`; **function:** the drive-status recalculation inside the drive batch callback. **Insertion point:** after `const matchedShortlistEmailIds = new Set(...)` (near line 757), insert:

```ts
    const roundForMatchedEmail = (emailId: string, round: 'test' | 'interview') =>
      (candidateMatches || []).some((m) =>
        m.email_id === emailId &&
        (m as typeof m & { matched_round_type?: string | null }).matched_round_type === round &&
        m.match_type !== 'xlsx_applied_list');
```

**Insertion point:** in the initial `candidateMatches` query (near line 205), change `.select('id, match_type, email_id, matched_value')` to `.select('id, match_type, email_id, matched_value, matched_round_type')`. **Reason:** the reprocessor must read the stored round, rather than treating any drive match as prior-round evidence.

**Insertion point:** change `isMatchedInTest = matchedShortlistEmailIds.has(latestTestShortlistEmail.id);` to `isMatchedInTest = roundForMatchedEmail(latestTestShortlistEmail.id, 'test');`; change each subsequent `testShortlistEmails.some((e) => matchedShortlistEmailIds.has(e.id))` and `testEmails.some((e) => matchedShortlistEmailIds.has(e.id))` used to assign `isMatchedInTest` to use `roundForMatchedEmail(e.id, 'test')`. Delete the `if (!isMatchedInTest) { isMatchedInTest = testShortlistEmails.some((e) => matchedEmailIds.has(e.id)); }` fallback (near line 790). **Reason:** applied rosters or an untagged match must not be considered confirmed test shortlisting.

**Insertion point:** change `const isMatchedInNextRound = sortedNextRoundEmails.some((e) => matchedShortlistEmailIds.has(e.id));` to `const isMatchedInNextRound = sortedNextRoundEmails.some((e) => roundForMatchedEmail(e.id, 'interview'));`. **Reason:** selection on an unrelated round is not interview-shortlist confirmation.

**Insertion point:** replace the `else if (!hasUpcomingInterviewEvent && interviewTime > 0 && (Date.now() - interviewTime) > 14 * 24 * 60 * 60 * 1000) { computedStatus = 'rejected'; computedRejectionNote = 'Interviewed · Not Selected'; }` branch (near line 878) with nothing. **Reason:** passage of 14 days without a next-round result is not elimination under the requested rule.

**Insertion point:** in `const subsequentPostTestEmails = [...selectionEmails, ...nextRoundEmails].filter(...)` (near line 898), change `[...]` to `nextRoundEmails` without altering the time predicate. After the corresponding `if (!hasUpcomingTestEvent && subsequentPostTestEmails.length > 0) { ... }` branch, add:

```ts
      else if (!hasUpcomingTestEvent && selectionEmails.some((e) =>
        Boolean(e.received_at && new Date(e.received_at).getTime() > testMatchTime + 30 * 60 * 1000))) {
        computedStatus = 'not_shortlisted';
      }
```

**Reason:** final selection cannot reject somebody who only ever matched the test round; interview is the missing immediate predecessor.

**Insertion point:** change `const isPhantomRejection = ...` (near line 997) to:

```ts
    const isPhantomRejection =
      !existingApp?.manual_override &&
      existingApp?.status === 'rejected' &&
      computedStatus === 'not_shortlisted';
```

**Reason:** the existing monotonic guard must allow correcting a previously stored false `rejected` even if an older test match exists. Leave the `STATUS_PRIORITY` block in `status-engine.ts` alone. The reprocess file also has pre-existing edits: preserve them.

**Important reprocess verification:** if `nextRoundEmails` includes generic or test emails, narrow it to explicit interview notices at the `nextRoundEmails` declaration before using it as interview evidence; do not infer a round from timing. Confirm that a final selection message without an interview match yields `not_shortlisted`, not a delayed `rejected`.

## Fix 2 — extraction from observed production examples

Sampled 400 classified drive emails read-only; 30 distinct circulars contained compensation/location/role labels. These are **real snippets**, not invented formats:

- `OJ Commerce - Dream Internship - B.Tech -2027 Batch`: `We are currently hiring for the following positions: - Software Engineering - Analytics - Business Process - Program Management Office(PMO)`; `Selected candidates will receive: - ₹7.5 LPA for Software Engineering...`; `all the roles are Work From Office role`; `₹1 lakh loyalty bonus ...`. Current output: `ctc=null`, role=`₹1 lakh loyalty bonus after completing two years ...`, work mode unavailable. Expected: `7.5 LPA`, `Software Engineering / Analytics / Business Process / Program Management Office`, `office`.
- `Infosys Regular Offer Registration 2027 Batch.`: `join our organization as a *Systems Engineer (Trainee)*, offering a compensation package of *₹3.6 LPA.*` Current role null; expected `Systems Engineer` (current `cleanRoleTitle` already strips parenthetical notes).
- `Re: Deliotte Dream Internship / PlacementRegistration - 2027 Batch`: quoted prior circular contains `*Job location:* *Refer JD’s*`; current output `Refer`, expected **null from that phrase** (do not guess the work city from a quoted thread). `EA Games Electronic Arts Super Dream Internship Registration - 2027 Batch`: `Location- EA Hyderabad office in person(No remote)` and `Mode of Work- Hybrid(3 days a week)`; current location `EA Hyderabad office(No)`; expected `Hyderabad`, work mode `hybrid`. `KPMG GLOBAL SERVICES : Registration : DREAM OFFER INTERNSHIP 2027 Batch`: `Day 1 (Process) : 6 LPA Fixed + Variable`, `Day 2 (Process) : 5 LPA Fixed + Variable`, `CTC: Total Earning Potential will be 6 LPA Fixed + Variable...`; current CTC null, expected `5 - 6 LPA`. Do not change stipend parsing.

### 1. Work mode (job arrangement, not event/campus mode)

**File:** `src/lib/sync/events.ts`; **interface:** `ExtractedJobDetails`. **Insertion point:** immediately after `location: string | null;`. **Insert:** `  workMode: 'remote' | 'office' | 'hybrid' | null;`. **Reason:** no existing job-work-mode field exists and `ExtractedEvent.mode` refers to an individual event.

**File:** `src/lib/sync/events.ts`; **function:** `extractJobDetails`. **Insertion point:** immediately after `let location: string | null = null;`. **Insert:**

```ts
  let workMode: ExtractedJobDetails['workMode'] = null;
```

**Insertion point:** immediately after `const cleanText = cleanWithLines.replace(/\s+/g, ' ');` (locate the existing two-line expression, do not replace it). **Insert:**

```ts
  // Only job-arrangement language: do not turn a virtual PPT or online test into remote work.
  const workModeText = cleanWithLines.match(/\b(?:mode\s+of\s+work|work\s+mode|internship\s+mode)\b\s*[:\-–—]?\s*([^\r\n]{2,100})/i)?.[1] || '';
  if (/\bhybrid\b/i.test(workModeText)) workMode = 'hybrid';
  else if (/\bwork\s+from\s+office\b|\b(?:in[\s-]*person|on[\s-]*site)\b/i.test(workModeText) ||
           /\ball\s+the\s+roles\s+are\s+work\s+from\s+office\b/i.test(cleanText)) workMode = 'office';
  else if (/\bremote\b|\bwork\s+from\s+home\b/i.test(workModeText)) workMode = 'remote';
```

**Insertion point:** add `workMode,` after `location,` in the final return object; add `workMode: null,` after `location: null,` in the CSE-eligibility early return. **Reason:** handle the observed OJ Commerce and EA Games job-mode labels without using campus travel or test mode as a proxy.

**File:** `src/lib/sync/status-engine.ts`; **function:** `processEmailForEventsAndStatus`. **Insertion point:** immediately after `if (resolvedLocation && (!existingApp?.location || !isOlderThanCurrentStatus)) appUpdate.location = resolvedLocation;`. **Insert:**

```ts
  if (jobDetails.workMode && (!existingApp?.work_mode || !isOlderThanCurrentStatus)) appUpdate.work_mode = jobDetails.workMode;
```

**Insertion point:** append `work_mode` to the existing `.select('status, manual_override, applied_at, location, ctc, role, stipend, notes, ...')` for `existingApp` near line 135. **Reason:** persist an explicit job mode with the same populated-field/recency behavior as location; leave travel notes and event mode alone.

### 2. CTC

**File:** `src/lib/sync/events.ts`; **function:** `extractJobDetails`. **Insertion point:** in the CTC section, immediately before `if (nums.length > 0) { const min = ... }` (currently near line 1357). **Insert exactly:**

```ts
    if (nums.length === 0) {
      // OJ Commerce: "Selected candidates will receive: ₹7.5 LPA for Software Engineering".
      const offered = textForBhopal.match(/\bselected\s+candidates\s+will\s+receive\s*:\s*(?:[•*\-]\s*)?(?:INR|₹|Rs\.?)?\s*(\d+(?:\.\d+)?)\s*LPA\b/i);
      if (offered) nums.push(Number(offered[1]));
    }
    if (nums.length === 0) {
      // KPMG: "Day 1 (Process): 6 LPA Fixed", "Day 2 (Process): 5 LPA Fixed".
      const fixedDayRates = [...textForBhopal.matchAll(/\bDay\s+[12]\s*\(Process\)\s*:\s*(\d+(?:\.\d+)?)\s*LPA\s*Fixed\b/gi)];
      for (const rate of fixedDayRates) nums.push(Number(rate[1]));
    }
```

**Reason:** old CTC block can stop at `Process`/`Stipend` and full-text fallback can miss the OJ amount or KPMG's day-labelled values; only explicit offers/fixed day rates are admitted, leaving existing range/addition/TCTC precedence intact. If `ctcText` excludes these phrases, use `textForBhopal` for these two new patterns only; never bypass the non-Bhopal divider. Verify the expected results against the actual snippets before deploying; if a pattern still fails, fix its bounded context instead of widening all CTC scanning.

### 3. Role

**File:** `src/lib/sync/events.ts`; **function:** `extractJobDetails`. **Insertion point:** immediately before `// 1. Explicit headers: Designation, Job Role...` (near line 1499). **Insert exactly:**

```ts
  if (!role) {
    // Infosys: "join our organization as a *Systems Engineer (Trainee)*".
    const joinedAs = cleanText.match(/\bjoin\s+our\s+organization\s+as\s+a\s+([A-Za-z][A-Za-z\s/&-]{2,70}(?:\s*\([^)]{1,30}\))?)(?=\s*,|\s*\.)/i);
    if (joinedAs) role = cleanRoleTitle(joinedAs[1]);
  }
  if (!role) {
    // OJ Commerce: "hiring for the following positions:" followed by bullet roles.
    const positions = cleanWithLines.match(/\bcurrently\s+hiring\s+for\s+the\s+following\s+positions\s*:\s*([\s\S]{1,500}?)(?=\bSelected\s+candidates\s+will\s+receive\b|$)/i)?.[1];
    if (positions) {
      const titles = positions.split(/\r?\n/)
        .map((line) => line.replace(/^\s*[•*\-]+\s*/, '').replace(/\s*\([^)]*\)/g, '').trim())
        .filter((title) => /^(?:Software Engineering|Analytics|Business Process|Program Management Office)$/i.test(title));
      if (titles.length > 0 && titles.length <= 5) role = titles.join(' / ');
    }
  }
```

**Insertion point:** also change the existing `listIntroMatch` test `if (listIntroMatch) {` (near line 1480) to `if (listIntroMatch && !/₹|\b(?:lakh|loyalty|bonus)\b/i.test(listIntroMatch[1])) {`. **Reason:** old narrative designation search sees OJ's phrase "roles are Work From Office role" and captures the unrelated loyalty-bonus bullet; explicitly titled positions and Infosys's employment sentence are higher-confidence evidence. Do not change `cleanRoleTitle`'s prior rejection examples.

### 4. Location

**File:** `src/lib/sync/events.ts`; **function:** `extractJobDetails`. **Insertion point:** inside `if (locMatch) {`, after all `rawLoc` cleanup ending in `.slice(0, 60);` and before the `if (rawLoc.includes('(') ...` line (near line 1592). **Insert exactly:**

```ts
    // A JD pointer is not a city. EA's "EA Hyderabad office in person(No remote)"
    // describes the Hyderabad office; "in person" is not part of the location.
    if (/^(?:refer|see|check)\s+(?:the\s+)?(?:attached\s+)?(?:jd|attachment)/i.test(rawLoc)) rawLoc = '';
    const namedOffice = rawLoc.match(/\b(Bangalore|Bengaluru|Hyderabad|Pune|Mumbai|Chennai|Gurgaon|Gurugram|Noida|Delhi|Kolkata|Ahmedabad)\s+office\b/i);
    if (namedOffice && /\bin\s+person\b/i.test(locMatch[1])) rawLoc = namedOffice[1];
```

**Reason:** the old cleaning truncates `Refer JD’s` to the false city `Refer`, and leaves EA's `office(No)` suffix; this targets only the observed pointer and explicitly named office, preserving existing multi-city cases.

### Checks (after implementing; not performed in this planning pass)

Run `npm run typecheck` and `npm test -- src/lib/sync/events-location.test.ts src/lib/sync/events-role.test.ts`, plus a focused status-engine/reprocess test using a mocked Supabase client. Validate CTC/role/location with the real snippets above. The script generating the sample under `C:\Users\ARUSH\AppData\Local\Temp\opencode` is temporary diagnostic material, not an application file; do not commit its raw email contents. Before deployment, confirm older untaged matches remain `NULL` unless the migration's explicit-subject backfill can identify the round.

### Found but not fixed

- `events.ts` `extractTravelRequirement` does not describe job work arrangement; `events.mode` is round attendance. Do not overwrite either with `applications.work_mode`.
- Other reprocess positive-match branches and time-based heuristics may still classify ambiguous mail; the specific rejection paths above must be verified against the scenarios below without restructuring the reprocessor.

## Test scenarios (input email → expected output)

1. Registration confirmation → `applied`; PPT schedule without a shortlist → `ppt_scheduled`; test shortlist with candidate ID → `test_scheduled` and `candidate_matches.matched_round_type='test'`; subsequent interview shortlist without ID → `rejected` with test-elimination note.
2. Registration → test shortlist **without** ID → `not_shortlisted`; later interview shortlist **without** ID → stays `not_shortlisted` (never `rejected`); even a much older PPT match or `NULL`-tagged match cannot count as test evidence.
3. Candidate matches test shortlist and misses interview shortlist → `rejected`; separately, candidate matches interview shortlist and misses *final selection list* → `rejected` with interview-elimination note. Candidate matches **only** test shortlist and misses final selection (no interview match) → `not_shortlisted`, not `rejected`; 14 days without a result email never alone triggers rejection.
4. OJ Commerce subject/body snippets above → `ctc='7.5 LPA'`, `role='Software Engineering / Analytics / Business Process / Program Management Office'`, `work_mode='office'`; Infosys sentence above → `role='Systems Engineer'` and existing `ctc='3.6 LPA'` remains.
5. EA Games snippet → `location='Hyderabad'`, `work_mode='hybrid'`; `Job location: Refer JD’s` → no extracted location; KPMG Day 1/Day 2 snippet → `ctc='5 - 6 LPA'`; existing Natwest `Gurgaon & Bangalore`, Amex `ETS – Software Engineering`, and single-city location tests still pass.
