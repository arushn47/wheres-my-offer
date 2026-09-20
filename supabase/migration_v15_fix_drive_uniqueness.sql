-- Migration v15: Drive uniqueness constraints and data integrity fixes
-- 1. Ensure unique constraint on (user_id, normalized_drive_number) for placement_drives
CREATE UNIQUE INDEX IF NOT EXISTS idx_placement_drives_user_norm_drive
ON public.placement_drives(user_id, normalized_drive_number)
WHERE normalized_drive_number IS NOT NULL;

-- 2. Ensure unique constraint on (user_id, placement_drive_id) for applications
CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_user_drive
ON public.applications(user_id, placement_drive_id);

-- 3. Clean up Whirlpool drive names and roles for user
UPDATE public.placement_drives
SET drive_name = 'Whirlpool Super Dream Internship',
    role = COALESCE(role, 'Graduate Engineer Trainee / Intern')
WHERE normalized_drive_number = 'pat-pl-2026-1204';

UPDATE public.placement_drives
SET drive_name = 'Whirlpool Dream Internship',
    role = COALESCE(role, 'Intern - Engineering')
WHERE normalized_drive_number = 'pat-pl-2026-1317';

-- 4. Remove premature email link from Whirlpool Dream drive
DELETE FROM public.email_drive_links
WHERE email_id = '008ff1c7-a10a-4600-835d-99f48ca9b7ac'
  AND placement_drive_id = '8cd532f5-ef47-4c6f-8048-205c30273ef9';
