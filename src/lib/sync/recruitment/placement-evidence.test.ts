import { describe, expect, it } from 'vitest';
import { hasPublishedShortlistContext, personalPlacementEvidence } from './placement-evidence';
import { isPartialRoster, resolveRoundVerdicts, statusForRoundVerdict, type RoundEvidence } from './round-verdict';

const neoId='I4W0P0K8';
function circular(subject:string,body:string):RoundEvidence { return {emailId:'one',subject,body,receivedAt:'2026-10-05T10:00:00Z',rosters:[]}; }

describe('placement participation and published outcomes',()=>{
  it.each(['Toshiba Super dream offer','Prodapt super dream offer','Valeo Intern'])('never interprets eligibility for %s as hiring selection',drive=>{
    const subject="Congratulations! You're Eligible for Placement Drive";
    const body=`Placement Drive Invitation Dear Student, Congratulations! Based on your profile, you are eligible to participate. Drive Name: ${drive} Please confirm participation.`;
    expect(personalPlacementEvidence(subject,body)).toEqual({invitation:false});
  });
  it('keeps registration confirmation distinct from test invitation and hiring offer',()=>{
    expect(personalPlacementEvidence('Confirmed: Your Registration for Prodapt Placement Drive','Registration Confirmed! Drive Name: Prodapt Super dream offer')).toEqual({invitation:false});
    expect(personalPlacementEvidence('Online assessment','Your test link and password are below')).toEqual({invitation:true});
    expect(personalPlacementEvidence('Offer letter','We are pleased to offer you the role')).toEqual({outcome:'selected',invitation:false});
  });
  it('ignores future shortlisting mentioned in registration boilerplate',()=>{
    const e=circular('Chargebee Super Dream Internship Registration - 2027 Batch','PPT & Test: 26.09.2026 12 Noon. Please update your resume as there would be shortlisting by the company for the selection process.');
    expect(hasPublishedShortlistContext(e.subject,e.body)).toBe(false);
    expect(resolveRoundVerdicts([e],[neoId])).toEqual([]);
  });
  it.each(['UBS next round of selection process on 6 October 2026','Goldman Sachs Selection List – 2027 Batch'])('evaluates presence and absence in inline Neo ID tables: %s',subject=>{
    const absent=resolveRoundVerdicts([circular(subject,'Find the below shortlist.\nNeo ID Division\nF6N4O7J4 Operations\nL4W4F5W7 Operations')],[neoId])[0];
    expect(absent).toMatchObject({state:'verified_absent',eligible:false,finalNegative:true});
    const present=resolveRoundVerdicts([circular(subject,`Find the below shortlist.\nNeo ID Division\n${neoId} Operations`)],[neoId])[0];
    expect(present).toMatchObject({state:'verified_present',eligible:true});
  });
  it('does not confuse graduating year with numbered candidate batches',()=>{
    expect(isPartialRoster('Test Shortlist - 2027 Batch')).toBe(false);
    expect(isPartialRoster('Test shortlist List 1 - 2027 Batch')).toBe(true);
    expect(isPartialRoster('Interview batch 2')).toBe(true);
  });
  it('checks headerless lists and keeps waitlisted rows from granting eligibility',()=>{
    const absent=resolveRoundVerdicts([circular('Selection list','Operations Manager intern role\nP1T4H8Z7')],[neoId])[0];
    expect(absent.state).toBe('verified_absent');
    const waitlist=resolveRoundVerdicts([circular('Interview shortlist',`Resume Review Outcome Neo id\nWaitlisted ${neoId}\nShortlisted for Interview K3U6C5I8`)],[neoId])[0];
    expect(waitlist.eligible).toBe(false);
    const oneLine=resolveRoundVerdicts([circular('Interview shortlist',`Neo ID\nWaitlisted K3U6C5I8 Shortlisted for Interview ${neoId}`)],[neoId])[0];
    expect(oneLine.eligible).toBe(true);
  });
  it('does not reset a known stage while a roster is unavailable',()=>{
    const v=resolveRoundVerdicts([circular('Test 2 shortlist','Please find the attached shortlist.')],[neoId])[0];
    expect(v.state).toBe('deferred');
    expect(statusForRoundVerdict(v,'ppt_scheduled')).toBe('ppt_scheduled');
    expect(statusForRoundVerdict(v,'shortlisted')).toBe('shortlisted');
  });
  it('does not infer test attendance from a generic shortlisted status',()=>{
    const v=resolveRoundVerdicts([circular('Selection List - 2027 Batch','Neo ID\nF6N4O7J4')],[neoId])[0];
    expect(statusForRoundVerdict(v,'shortlisted')).toBe('not_shortlisted');
    expect(statusForRoundVerdict(v,'applied')).toBe('not_shortlisted');
  });
});
