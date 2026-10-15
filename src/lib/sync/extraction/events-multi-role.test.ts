import { describe, expect, it } from 'vitest';
import { extractJobDetails } from './events';
import { extractRoleCompensation } from './role-compensation';
import { extractRegistrationRequirements, readRegistrationRequirements } from './registration-requirements';
import { extractRecruitmentVenues, resolveDriveMode } from '@/lib/drive-venues';
import { formatCompensationLabel } from '@/lib/compensation';

const circular = `Category
Super Dream / Dream Internship - 2027 Batch
Date of Visit:
Application - 15th October
Video Interview - 20th October
Assignment Submission - 24th October
OnCampus Interviews -27th October at Vellore for Vellore campus students
others campus it will be Virtual
Eligible Branches
B.Tech. Computer Science and Engineering
B.Tech. Computer Science and Engineering (Artificial Intelligence and
Machine Learning)
Eligibility Criteria
% in X and XII – 75% or 7.5 CGPA
in Pursuing Degree – 75% or 7.5 CGPA
No Standing Arrears
CTC
Check below (If converted)
Stipend
Check below
Last date for Registration
16-10-2026 (2.00 pm)
Website
arrowhead.ai
Role,CTC,Stipend details:
QA Engineer - 25k stipend - 6-10 LPA based on performance
Data Analyst - 40k Stipend - 12-16 LPA based on performance
Conversational AI Engineer - 40k stipend - 12-16 LPA based on performance
Job location- Bengaluru - Indiranagar
JD: Refer Attachments
Company registration form is available under the “Drive
Description ” section on the NeoPAT platform.
All interested students should register in NEO PAT & Company registration link before 16th October.`;

describe('multi-role registration circular', () => {
  it('retains each role and its associated compensation, with compact labels', () => {
    const details = extractJobDetails(circular);
    expect(details.role).toBe('QA Engineer / Data Analyst / Conversational AI Engineer');
    expect(details.ctc).toContain('QA Engineer: 6 - 10 LPA (if converted) (based on performance)');
    expect(details.ctc).toContain('Data Analyst: 12 - 16 LPA');
    expect(details.stipend).toContain('QA Engineer: ₹25,000/month');
    expect(details.stipend).toContain('Conversational AI Engineer: ₹40,000/month');
    expect(formatCompensationLabel(details.ctc)).toBe('6 - 16 LPA');
    expect(formatCompensationLabel(details.stipend)).toBe('₹25,000 - ₹40,000/month');
    expect(details.category).toBe('Super Dream / Dream Internship');
    expect(details.location).toBe('Bengaluru, Indiranagar');
    expect(details.branches).toHaveLength(2);
    expect(details.branches?.[1]).toContain('(Artificial Intelligence and Machine Learning)');
  });

  it('routes the same interview to Vellore locally and Bhopal virtually', () => {
    const entries = extractRecruitmentVenues('Registration', circular);
    const value = { version: 1, entries: entries.map(entry => ({ ...entry, sourceId: 'circular', receivedAt: '2026-10-15T09:52:22Z' })) };
    expect(resolveDriveMode(value, 'VIT Bhopal').label).toBe('Own Location');
    expect(resolveDriveMode(value, 'VIT Vellore').label).toBe('Home Campus');
  });

  it('directs students to the company form inside NeoPAT', () => {
    const requirements = extractRegistrationRequirements({ bodyPlain: circular });
    expect(requirements?.companyFormLocation).toBe('neopat_drive_description');
    expect(readRegistrationRequirements(requirements)?.companyFormLocation).toBe('neopat_drive_description');
    expect(requirements?.companyLinks).toEqual([]);
  });

  it('does not turn a job description or a salary-free role list into pay data', () => {
    expect(extractRoleCompensation('QA Engineer - testing data pipelines\nData Analyst - SQL')).toBeNull();
    expect(extractRoleCompensation('Role,CTC,Stipend details:\nQA Engineer - see documents')).toBeNull();
  });
});
