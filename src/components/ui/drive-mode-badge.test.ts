import { expect, it } from 'vitest';
import { Building2, Globe, HelpCircle, Plane } from 'lucide-react';
import { getDriveModeBadgeConfig } from './drive-mode-badge';
import { extractRecruitmentVenues, resolveDriveVenue } from '@/lib/drive-venues';

function config(body: string) {
  const venue = resolveDriveVenue({ version: 1, entries: extractRecruitmentVenues('Test', body) }, 'VIT Bhopal');
  return getDriveModeBadgeConfig(venue.label, venue.requiresTravel);
}
it('uses a plane for physical attendance outside the home campus', () => {
  expect(config('Test will be held at PRP717.').icon).toBe(Plane);
  expect(config('Interviews will be held at Chargebee Chennai office.').icon).toBe(Plane);
});
it('keeps home-campus and own-location attendance distinct from travel', () => {
  expect(config('Test will be held at VIT Bhopal.').icon).toBe(Building2);
  expect(config('Test will be conducted from own location.').icon).toBe(Globe);
});
it('does not invent a travel requirement for an unannounced venue', () => {
  expect(config('Online test on HackerRank.').icon).toBe(HelpCircle);
});
