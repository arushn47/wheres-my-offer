-- ============================================
-- Migration V4: Dynamic Drive Resolutions Table
-- Persists timing-correlated and manually reviewed drive_number -> role mappings
-- ============================================

CREATE TABLE IF NOT EXISTS public.drive_resolutions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  drive_number TEXT NOT NULL UNIQUE,
  company_base_name TEXT NOT NULL,
  resolved_role TEXT NOT NULL,
  resolved_company_name TEXT NOT NULL,
  resolved_via TEXT NOT NULL CHECK (resolved_via IN ('timing_correlation', 'direct_role_text', 'manual_review', 'historical_rule')),
  confidence TEXT NOT NULL DEFAULT 'high' CHECK (confidence IN ('high', 'medium', 'low', 'needs_review')),
  time_diff_seconds INTEGER,
  candidate_circular_id UUID REFERENCES public.emails(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_drive_resolutions_drive_num ON public.drive_resolutions(drive_number);
CREATE INDEX IF NOT EXISTS idx_drive_resolutions_company ON public.drive_resolutions(company_base_name);
