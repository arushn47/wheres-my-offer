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
