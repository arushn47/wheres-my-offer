import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { DriveVenueRounds } from './drive-venue-rounds';
import { DriveModeBadge } from './drive-mode-badge';
import { DriveModeDetails } from './drive-mode-details';
import { extractRecruitmentVenues, resolveDriveMode, type DriveMode } from '@/lib/drive-venues';

it.each<DriveMode>(['Own Location', 'Home Campus', 'Other Campus', 'External Venue', 'TBA'])('renders the same fixed %s label on cards and details', label => {
  expect(renderToStaticMarkup(React.createElement(DriveModeBadge, { driveMode: label }))).toContain(`>${label}</span>`);
  expect(renderToStaticMarkup(React.createElement(DriveModeDetails, { label }))).toContain(`>${label}</span>`);
});
it('renders each round mode and exact venue without requiring a tooltip', () => {
  const mode = resolveDriveMode({ version: 1, entries: extractRecruitmentVenues('Registration', 'Test will be conducted from own location.\nInterviews will be held at Chargebee Chennai office.') }, 'VIT Bhopal');
  const html = renderToStaticMarkup(React.createElement(DriveVenueRounds, { rounds: mode.rounds }));
  expect(html).toContain('Recruitment attendance by round');
  expect(html).toContain('>Test</th>');
  expect(html).toContain('>Own Location</span>');
  expect(html).toContain('Own location');
  expect(html).toContain('>Interviews</th>');
  expect(html).toContain('>External Venue</span>');
  expect(html).toContain('Chargebee Chennai office');
  expect(html).toContain('Travel required');
});
it('shows a short physical destination on cards and keeps the full venue in the details', () => {
  const mode = resolveDriveMode({ version: 1, entries: extractRecruitmentVenues('Test', 'Test venue: PRP 717') }, 'VIT Bhopal');
  const card = renderToStaticMarkup(React.createElement(DriveModeBadge, { driveMode: mode.label, shortVenue: mode.shortVenue, detail: mode.detail, requiresTravel: mode.requiresTravel }));
  expect(card).toContain('>Other Campus</span>');
  expect(card).toContain('>VIT Vellore</span>');
  expect(card).toContain('Travel required');
  const details = renderToStaticMarkup(React.createElement(DriveVenueRounds, { rounds: mode.rounds }));
  expect(details).toContain('>PRP 717</td>');
});
it('omits a destination suffix for remote attendance and TBA', () => {
  for (const driveMode of ['Own Location', 'TBA'] as const) {
    const html = renderToStaticMarkup(React.createElement(DriveModeBadge, { driveMode, shortVenue: 'Unused destination' }));
    expect(html).not.toContain('>Unused destination</span>');
  }
});
it('identifies a company office on the card instead of displaying only its city', () => {
  const mode = resolveDriveMode({ version: 1, entries: extractRecruitmentVenues('Interviews', 'Interviews will be held at Chargebee Chennai office.') }, 'VIT Bhopal');
  const card = renderToStaticMarkup(React.createElement(DriveModeBadge, { driveMode: mode.label, shortVenue: mode.shortVenue, requiresTravel: mode.requiresTravel }));
  expect(card).toContain('>External Venue</span>');
  expect(card).toContain('>Chargebee Chennai office</span>');
});
it('shows an honest fallback without fabricating round venues', () => {
  const html = renderToStaticMarkup(React.createElement(DriveVenueRounds, { rounds: [] }));
  expect(html).toContain('Attendance mode or venue has not been confirmed.');
  expect(html).not.toContain('<table');
  expect(renderToStaticMarkup(React.createElement(DriveModeBadge, {}))).toContain('>TBA</span>');
});
