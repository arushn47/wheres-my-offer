'use client';

import { useState, useMemo, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeft,
  FileSpreadsheet,
  Mail,
  ChevronDown,
  AlertTriangle,
  CalendarPlus,
  CheckCircle2,
  ExternalLink,
  Plane,
  Building2,
  Globe,
  GraduationCap,
  Check,
  X,
} from 'lucide-react';
import { cn, timeAgo, getDriveMode } from '@/lib/utils';
import { CategoryBadge, STATUS_META } from '@/components/ui/status-chip';
import { StageStepper, getStageIndex, getEffectiveStage, isEliminatedStatus } from '@/components/companies/stage-stepper';
import { cleanLocationString } from '@/lib/sync/locations';
import { cleanRoleTitle } from '@/lib/sync/events';

export interface CompanyDetail {
  id: string;
  name: string;
  legalName: string | null;
  aliases: string[] | null;
  driveNumber?: string | null;
  driveName?: string | null;
  placementDriveId?: string | null;
  candidateName?: string | null;
  candidateRegId?: string | null;
  application: {
    id: string;
    status: string;
    statusSource: string | null;
    statusConfidence: string | null;
    role: string | null;
    category?: string | null;
    ctc: string | null;
    stipend: string | null;
    location: string | null;
    eligibility: string | null;
    branches?: string[] | null;
    cgpaRequirement?: string | null;
    backlogRequirement?: string | null;
    manualOverride: boolean;
    notes: string | null;
    appliedAt: string | null;
    lastUpdated: string;
  } | null;
  events: {
    id: string;
    eventType: string;
    title: string | null;
    startTime: string | null;
    venue: string | null;
    mode: string | null;
  }[];
  emails: {
    id: string;
    collegeEmailId?: string | null;
    subject: string;
    sender: string;
    receivedAt: string;
    snippet: string;
    classification: string;
    threadId?: string | null;
    gmailMessageId?: string | null;
    accountEmail?: string | null;
    attachmentName?: string | null;
  }[];
  candidateMatches: {
    id: string;
    emailId?: string | null;
    collegeEmailId?: string | null;
    matchType: string;
    matchedValue: string | null;
    matchLocation?: string | null;
    neoId?: string | null;
    createdAt: string;
  }[];
}

function parseCandidateMatchDetails(matchedValue: string | null, neoId?: string | null) {
  if (!matchedValue) return null;

  // XLSX match pattern: Matched in <filename> (<sheet>!<cell>) [<col>] [ - <venue>]
  const xlsxRegex = /^Matched in (.+?)\s*\((.+?)!(.+?)\)(?:\s*\[(.+?)\])?(?:\s*-\s*(.+))?$/i;
  const xlsxMatch = matchedValue.match(xlsxRegex);

  if (xlsxMatch) {
    const [, filename, sheet, cell, col, venue] = xlsxMatch;
    return {
      type: 'xlsx' as const,
      filename: filename.trim(),
      location: `${sheet}!${cell}`,
      column: col ? (col.startsWith('Col ') ? col : `Col ${col}`) : 'ID Column',
      venue: venue ? venue.trim() : null,
      identifier: neoId ? `Neo ID: ${neoId}` : 'Neo ID Verified',
    };
  }

  // Google Sheet pattern
  const gsheetRegex = /^Matched in Google Sheet \((.+?)\):\s*(.+)$/i;
  const gsheetMatch = matchedValue.match(gsheetRegex);
  if (gsheetMatch) {
    const [, sheet, rowText] = gsheetMatch;
    return {
      type: 'gsheet' as const,
      filename: `Google Sheet (${sheet.trim()})`,
      location: sheet.trim(),
      column: 'Spreadsheet Row',
      venue: null,
      identifier: rowText.trim(),
    };
  }

  return {
    type: 'general' as const,
    filename: 'Shortlist Roster',
    location: 'Verified Record',
    column: 'Direct Match',
    venue: null,
    identifier: matchedValue,
  };
}

function getNotShortlistedDetails(
  email: { subject: string; snippet?: string; classification?: string; attachmentName?: string | null },
  candidateRegId?: string | null,
  companyName?: string
) {
  const sub = email.subject.toLowerCase();
  let roundName = 'Next Round Shortlist';
  if (sub.includes('interview') || sub.includes('gd') || sub.includes('discussion')) {
    roundName = 'Interview Shortlist';
  } else if (sub.includes('offer') || sub.includes('congratulations') || sub.includes('final') || sub.includes('selection list')) {
    roundName = 'Final Selection List';
  } else if (sub.includes('test') || sub.includes('assessment') || sub.includes('exam')) {
    roundName = 'Test Shortlist';
  } else if (sub.includes('ppt')) {
    roundName = 'Pre-Placement Shortlist';
  }

  let filename = email.attachmentName;
  if (!filename) {
    const fileMatch = (email.subject + ' ' + (email.snippet || '')).match(/([\w\s\-–\(\)\.]+\.(?:xlsx|xls|pdf|csv))/i);
    if (fileMatch) {
      filename = fileMatch[1].trim();
    } else {
      let cleanTitle = email.subject
        .replace(/^(?:(?:re|fw|fwd|update)\s*:\s*)+/i, '')
        .replace(/^(?:congratulations\s*!*)\s*/i, '')
        .replace(/\s*is\s+scheduled.*$/i, '')
        .replace(/\s*-\s*2027\s*batch.*$/i, '')
        .trim();
      if (!cleanTitle.toLowerCase().includes('shortlist') && !cleanTitle.toLowerCase().includes('selection')) {
        cleanTitle += ' Shortlist';
      }
      filename = `${cleanTitle}.xlsx`;
    }
  }

  return {
    filename,
    roundName,
    identifier: candidateRegId ? `Neo ID: ${candidateRegId}` : 'Candidate ID Scanned',
    rosterType: email.attachmentName ? 'Attachment Roster' : 'Verified Roster',
  };
}

interface CompanyDetailClientProps {
  company: CompanyDetail;
  userCampus?: 'VIT Bhopal' | 'VIT Vellore' | 'VIT Chennai' | 'VIT AP';
  userBranch?: string | null;
  userRegNo?: string | null;
}

const STAGES = ['Applied', 'Shortlisted', 'Test', 'Interview', 'Offer'];

const ALL_STATUSES = [
  { value: 'applied', label: 'Applied' },
  { value: 'ppt_scheduled', label: 'PPT Scheduled' },
  { value: 'shortlisted', label: 'Shortlisted for Test' },
  { value: 'test_scheduled', label: 'Test Scheduled' },
  { value: 'test_completed', label: 'Test Completed (Awaiting Results)' },
  { value: 'interview_scheduled', label: 'Interview Scheduled' },
  { value: 'selected', label: 'Selected / Offer 🎉' },
  { value: 'not_shortlisted', label: 'Not Shortlisted for Test (Screening)' },
  { value: 'rejected_test', label: 'Eliminated in Test Round (Post-Test)' },
  { value: 'rejected_interview', label: 'Interviewed · Not Selected (Post-Interview)' },
  { value: 'declined', label: 'Declined / Opted Out' },
  { value: 'withdrawn', label: 'Withdrawn' },
  { value: 'not_applied', label: 'Not Applied' },
];

const HUES = [
  'border-amber-500/30 bg-amber-500/10 text-amber-300',
  'border-sky-500/30 bg-sky-500/10 text-sky-300',
  'border-rose-500/30 bg-rose-500/10 text-rose-300',
  'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  'border-violet-500/30 bg-violet-500/10 text-violet-300',
];

function getHue(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return HUES[hash % HUES.length];
}

const Stepper = ({ stage, status }: { stage: number; status: string }) => (
  <StageStepper stage={stage} status={status} />
);

function getCleanEmailSummary(
  rawSnippet: string | null | undefined,
  subject: string,
  classification: string,
  companyName: string,
  isMatched?: boolean
): string {
  if (!rawSnippet || rawSnippet.trim().length === 0) {
    const subLower = subject.toLowerCase();
    if (
      classification === 'shortlist' ||
      classification === 'selected' ||
      subLower.includes('shortlist') ||
      subLower.includes('selection list') ||
      subLower.includes('next round of selection') ||
      subLower.includes('selected candidates')
    ) {
      if (isMatched === false) {
        return `Selection roster announced for ${companyName}. Registration ID was not found in the verified shortlist for this round.`;
      }
      return `Registrations screened and shortlist confirmed for ${companyName}. Candidate matches verified in attachment.`;
    }
    if (classification === 'test' || subject.toLowerCase().includes('test') || subject.toLowerCase().includes('assessment')) {
      return `Online assessment and technical test details released for ${companyName}. Review schedule and test window.`;
    }
    if (classification === 'interview' || subject.toLowerCase().includes('interview')) {
      return `Technical interview schedule and reporting instructions released for ${companyName}.`;
    }
    return `Official recruitment circular and process announcement released for ${companyName}.`;
  }

  // Strip disclaimers, common email headers, signatures
  let clean = rawSnippet
    .replace(/<[^>]+>/g, ' ')
    .replace(/(?:this email|disclaimer|confidentiality notice|the information contained in this transmission|forwarded message|greetings from|dear student|dear candidate|warm regards|thanks & regards|placement office|vit vellore|vit bhopal|vit chennai)[\s\S]*/i, '')
    .replace(/^(?:from|to|sent|subject|date):[^\n\r]+/gim, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (clean.length < 20) {
    clean = rawSnippet.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Pick the first 1-2 clean sentences (max 180 chars)
  const sentences = clean.match(/[^.!?]+[.!?]+/g);
  if (sentences && sentences.length > 0) {
    let result = sentences[0].trim();
    if (result.length < 85 && sentences.length > 1) {
      result += ' ' + sentences[1].trim();
    }
    if (result.length > 180) {
      result = result.slice(0, 175).trim() + '…';
    }
    return result;
  }

  if (clean.length > 180) {
    return clean.slice(0, 175).trim() + '…';
  }

  return clean;
}

function getGmailLink(email: {
  threadId?: string | null;
  gmailMessageId?: string | null;
  subject?: string | null;
  accountEmail?: string | null;
}) {
  const authParam = email.accountEmail ? `?authuser=${encodeURIComponent(email.accountEmail)}` : '';
  if (email.threadId) {
    return `https://mail.google.com/mail/u/${authParam}#all/${email.threadId}`;
  }
  if (email.gmailMessageId) {
    return `https://mail.google.com/mail/u/${authParam}#search/rfc822msgid:${email.gmailMessageId}`;
  }
  if (email.subject) {
    return `https://mail.google.com/mail/u/${authParam}#search/${encodeURIComponent(email.subject)}`;
  }
  return `https://mail.google.com/mail/u/0/#inbox`;
}

export default function CompanyDetailClient({
  company,
  userCampus = 'VIT Bhopal',
  userBranch,
  userRegNo,
}: CompanyDetailClientProps) {
  const router = useRouter();
  const rawStatus = company.application?.status || 'applied';
  const notesStr = company.application?.notes || '';
  const isManual = company.application?.manualOverride ?? false;

  const initialDropdownStatus = useMemo(() => {
    const eff = getEffectiveStage(rawStatus, null, company.events, notesStr, isManual);
    if (eff.effectiveStatus === 'rejected_interview') return 'rejected_interview';
    if (eff.effectiveStatus === 'rejected_test') return 'rejected_test';
    if (eff.effectiveStatus === 'not_shortlisted') return 'not_shortlisted';
    if (eff.effectiveStatus === 'test_completed') return 'test_completed';

    if (rawStatus === 'rejected') {
      // Use the same note patterns that getEffectiveStage uses
      if (/eliminated.*interview|interview.*eliminated|interviewed.*not\s*selected|rejected.*interview/i.test(notesStr)) return 'rejected_interview';
      if (/eliminated.*test|test.*eliminated|rejected.*test|test.*rejected/i.test(notesStr)) return 'rejected_test';
      return 'not_shortlisted';
    }
    return rawStatus;
  }, [rawStatus, notesStr, company.events, isManual]);

  const [status, setStatus] = useState(initialDropdownStatus);
  const [isUpdating, setIsUpdating] = useState(false);
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const [openAccordion, setOpenAccordion] = useState<number | null>(0);

  // Keep state in sync if server props update
  useEffect(() => {
    setStatus(initialDropdownStatus);
  }, [initialDropdownStatus]);

  const effective = useMemo(
    () => getEffectiveStage(status, null, company.events, notesStr, isManual),
    [status, company.events, notesStr, isManual]
  );

  // The canonical status string to display in the chip — always use the effective
  // status so the detail page matches exactly what the company card shows.
  const displayStatus = effective.effectiveStatus;

  const stage = effective.stageIndex;
  const isWithdrawn =
    displayStatus === 'withdrawn' ||
    displayStatus === 'declined' ||
    status === 'withdrawn' ||
    status === 'declined';
  const isEliminated =
    isEliminatedStatus(displayStatus) ||
    isEliminatedStatus(status) ||
    effective.eliminatedStage !== -1;
  const terminal = isWithdrawn || isEliminated;
  const hue = useMemo(() => getHue(company.name), [company.name]);
  const initials = company.name.slice(0, 2).toUpperCase();

  const handleStatusChange = async (newStatus: string) => {
    setIsUpdating(true);
    setShowStatusMenu(false);

    let patchStatus = newStatus;
    let patchNotes: string | null = null;

    if (newStatus === 'rejected_test') {
      patchStatus = 'rejected';
      patchNotes = 'Eliminated in Test Round';
    } else if (newStatus === 'rejected_interview') {
      patchStatus = 'rejected';
      patchNotes = 'Interviewed · Not Selected';
    } else if (newStatus === 'not_shortlisted') {
      patchStatus = 'not_shortlisted';
      patchNotes = 'Not Shortlisted for Test';
    } else {
      // Switching to non-rejection status: clear previous rejection notes
      patchNotes = null;
    }

    try {
      const res = await fetch(`/api/companies/${company.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: patchStatus,
          notes: patchNotes,
          placement_drive_id: company.placementDriveId || undefined,
          application_id: company.application?.id || undefined,
        }),
      });
      if (res.ok) {
        setStatus(newStatus);
        if (company.application) {
          company.application.status = patchStatus;
          company.application.notes = patchNotes;
          company.application.manualOverride = true;
        } else {
          company.application = {
            id: '',
            status: patchStatus,
            statusSource: 'manual_override',
            statusConfidence: 'manual',
            role: null,
            ctc: null,
            stipend: null,
            location: null,
            eligibility: null,
            manualOverride: true,
            notes: patchNotes,
            appliedAt: new Date().toISOString(),
            lastUpdated: new Date().toISOString(),
          };
        }
        router.refresh();
      }
    } catch (err) {
      console.error('Failed to update status:', err);
    } finally {
      setIsUpdating(false);
    }
  };

  // Clean location
  const displayLocation = cleanLocationString(company.application?.location);

  // Drive Mode & Travel: Standardized to operational venues:
  // 'Online', 'VIT Vellore', 'VIT Chennai', 'VIT AP', or home campus labs ('Vellore Labs', 'Bhopal Labs', etc.)
  const driveModeDisplay = getDriveMode(notesStr, userCampus);

  // Role display: only show real, meaningful roles. Fallback to Campus Placement Drive if missing/generic.
  const displayRole = cleanRoleTitle(company.application?.role) || 'Campus Placement Drive';

  const rawCategory = company.application?.category || (/1[0-9]\s*lpa|[2-9][0-9]\s*lpa/i.test(company.application?.ctc || '') ? 'Super Dream' : 'Dream');
  const category = rawCategory.replace(/\b(internship|offer|placement|drive)\b/gi, '').replace(/\s*\/\s*/g, ' ').replace(/\s+/g, ' ').trim() || rawCategory.trim();

  const nextUpcomingEvent = company.events.find((e) => e.startTime && new Date(e.startTime).getTime() > Date.now());

  // Derive 4 CTC cards like Emergent: Total CTC, Fixed, Bonus, ESOPs
  const rawCtc = company.application?.ctc || '';
  const cleanCtc = rawCtc.replace(/\*/g, '').trim() || 'TBA';
  const stipend = company.application?.stipend?.replace(/\*/g, '').trim() || null;
  const cleanStipend = useMemo(() => {
    if (!stipend) return null;
    let s = stipend.trim();
    s = s.replace(/\/month\/mo$/i, '/month').replace(/\/mo\/mo$/i, '/mo');
    if (/^\d+$/.test(s)) {
      s = `₹${Number(s).toLocaleString('en-IN')}/month`;
    }
    return s;
  }, [stipend]);

  // Eligibility pills - extracted from circular emails, zero static fallbacks
  const eligibilityList = useMemo(() => {
    const pills: string[] = [];
    const seen = new Set<string>();

    const isGarbled = (str: string) =>
      !/\d/.test(str) || /stipulated\s+duration|academic\s+program|candidates?\s+must|without\s+any|gap\s+of\s+up\s+to/i.test(str);

    const addPill = (text: string | null | undefined) => {
      if (!text) return;
      const clean = text.trim();
      if (!clean || seen.has(clean.toLowerCase())) return;
      if (['bhopal', 'bhopal_lab', 'vellore', 'chennai', 'ap', 'online'].includes(clean.toLowerCase())) return;
      if (/^(?:10th|12th|ug|pg)\b/i.test(clean) && isGarbled(clean)) return;
      seen.add(clean.toLowerCase());
      pills.push(clean);
    };

    const raw = company.application?.eligibility || '';
    const branches = company.application?.branches;
    const cgpaReq = company.application?.cgpaRequirement;
    const backlogReq = company.application?.backlogRequirement;

    const sanitizeAndAddPill = (part: string) => {
      const p = part.trim();
      if (!p) return;

      // 1. Combined 10th & 12th
      if (/^(?:10th\s*(?:&|and)\s*12th|x\s*(?:&|and)\s*xii)/i.test(p)) {
        const valMatch = p.match(/(?:10th\s*(?:&|and)\s*12th|x\s*(?:&|and)\s*xii)\s*[:\-–—\s]*([^\s]+(?:\s+or\s+[^\s]+)?(?:\s*CGPA|\s*%)?)/i) ||
                         p.match(/(?:10th\s*(?:&|and)\s*12th|x\s*(?:&|and)\s*xii)\s*[:\-–—\s]*([^\n\r|]+)/i);
        if (valMatch) {
          const cleanVal = valMatch[1].replace(/\s*(?:in\s+Pursuing|Pursuing|in\s+UG|for\s+PG).*$/i, '').trim();
          if (!isGarbled(cleanVal)) addPill(`10th & 12th: ${cleanVal}`);
          return;
        }
      }

      // 2. Legacy merged pill (e.g. "Degree: 60% or 6.0 CGPA in UG (for PGs) – 60% or 6.0 CGPA No Standin")
      if (/Degree:.*\(for\s+PGs?\)/i.test(p) || /in\s+Pursuing\s+Degree.*(?:for\s+PGs?|in\s+PG)/i.test(p)) {
        const ugMatch = p.match(/(?:Degree|UG)\s*[:\-–—\s]*([^\s–—|\(]+(?:\s+or\s+[^\s–—|\(]+)?(?:\s*CGPA|\s*%)?)/i);
        const pgMatch = p.match(/(?:for\s+PGs?\)?|in\s+PG)\s*[:\-–—\s]*([^\s]+(?:\s+or\s+[^\s]+)?(?:\s*CGPA|\s*%)?)/i);
        if (ugMatch && !isGarbled(ugMatch[1])) addPill(`UG: ${ugMatch[1].trim()}`);
        if (pgMatch && !isGarbled(pgMatch[1])) addPill(`PG: ${pgMatch[1].trim()}`);
        return;
      }

      // 3. Standalone UG / Pursuing Degree
      if (/^(?:UG|Degree|Pursuing\s+Degree)\s*:/i.test(p)) {
        const valMatch = p.match(/^(?:UG|Degree|Pursuing\s+Degree)\s*[:\-–—\s]*([^\s]+(?:\s+or\s+[^\s]+)?(?:\s*CGPA|\s*%)?)/i) ||
                         p.match(/^(?:UG|Degree|Pursuing\s+Degree)\s*[:\-–—\s]*([^\n\r|]+)/i);
        if (valMatch) {
          const cleanVal = valMatch[1].replace(/\s*(?:in\s+UG|\(for\s+PG|for\s+PG|No\s+Standing).*$/i, '').trim();
          if (!isGarbled(cleanVal)) addPill(`UG: ${cleanVal}`);
          return;
        }
      }

      // 4. Standalone PG
      if (/^PG\s*:/i.test(p)) {
        const valMatch = p.match(/^PG\s*[:\-–—\s]*([^\s]+(?:\s+or\s+[^\s]+)?(?:\s*CGPA|\s*%)?)/i) ||
                         p.match(/^PG\s*[:\-–—\s]*([^\n\r|]+)/i);
        if (valMatch) {
          const cleanVal = valMatch[1].replace(/\s*(?:No\s+Standing|Arrear|Eligible).*$/i, '').trim();
          if (!isGarbled(cleanVal)) addPill(`PG: ${cleanVal}`);
          return;
        }
      }

      // 5. Standalone 10th
      if (/^10th\s*:/i.test(p)) {
        const valMatch = p.match(/^10th\s*[:\-–—\s]*([^\s]+(?:\s+or\s+[^\s]+)?(?:\s*CGPA|\s*%)?)/i) ||
                         p.match(/^10th\s*[:\-–—\s]*([^\n\r|]+)/i);
        if (valMatch) {
          if (!isGarbled(valMatch[1])) addPill(`10th: ${valMatch[1].trim()}`);
          return;
        }
      }

      // 6. Standalone 12th
      if (/^12th\s*:/i.test(p)) {
        const valMatch = p.match(/^12th\s*[:\-–—\s]*([^\s]+(?:\s+or\s+[^\s]+)?(?:\s*CGPA|\s*%)?)/i) ||
                         p.match(/^12th\s*[:\-–—\s]*([^\n\r|]+)/i);
        if (valMatch) {
          if (!isGarbled(valMatch[1])) addPill(`12th: ${valMatch[1].trim()}`);
          return;
        }
      }

      // 7. Arrears
      if (/arrear/i.test(p)) {
        if (/no\s*(?:standing)?\s*arrears\s*(?:and|&)\s*no\s*academic\s*gap/i.test(p)) {
          addPill('No standing arrears & no academic gap');
        } else if (/no\s*(?:standing)?\s*arrears|0\s*arrear/i.test(p)) {
          addPill('No standing arrears');
        } else if (/no\s*(?:history\s*of\s*)?arrears/i.test(p)) {
          addPill('No history of arrears');
        } else {
          addPill(p);
        }
        return;
      }

      // 8. Branches
      if (/^Branches\s*:/i.test(p)) {
        addPill(p);
        return;
      }

      if (!isGarbled(p)) {
        addPill(p);
      }
    };

    if (raw && raw.includes('|')) {
      const parts = raw.split('|').map((p) => p.trim()).filter(Boolean);
      for (const p of parts) {
        sanitizeAndAddPill(p);
      }
    } else {
      // 1. 10th and 12th (combined or separate)
      const combinedTenthTwelfthMatch = raw.match(/(?:10th\s*(?:&|and)\s*12th|x\s*(?:&|and)\s*xii)\s*[:\-–—\s]*([^\s]+(?:\s+or\s+[^\s]+)?(?:\s*CGPA|\s*%)?)/i) ||
                                        raw.match(/(?:% in\s+)?(?:x\s+and\s+xii|10th\s+and\s+12th)\s*[:\-–—\s]*([^\n\r|]+)/i);
      if (combinedTenthTwelfthMatch) {
        const cleanVal = combinedTenthTwelfthMatch[1].replace(/\s*(?:in\s+Pursuing|Pursuing|in\s+UG|for\s+PG).*$/i, '').trim();
        if (!isGarbled(cleanVal)) addPill(`10th & 12th: ${cleanVal}`);
      } else {
        const tenthMatch = raw.match(/(?:in\s+10th|10th\s*std|10th\s*grade|10th)\s*[:\-–—\s]*([^\s]+(?:\s+or\s+[^\s]+)?(?:\s*CGPA|\s*%)?)/i);
        if (tenthMatch && !isGarbled(tenthMatch[1])) addPill(`10th: ${tenthMatch[1].trim()}`);
        const twelfthMatch = raw.match(/(?:in\s+12th|12th\s*std|12th\s*grade|12th|diploma)\s*[:\-–—\s]*([^\s]+(?:\s+or\s+[^\s]+)?(?:\s*CGPA|\s*%)?)/i);
        if (twelfthMatch && !isGarbled(twelfthMatch[1])) addPill(`12th: ${twelfthMatch[1].trim()}`);
      }

      // 2. UG Requirement
      if (cgpaReq) {
        const cleanVal = cgpaReq.replace(/^(?:UG|Degree|Pursuing\s+Degree)\s*:\s*/i, '').trim();
        if (!isGarbled(cleanVal)) {
          addPill(`UG: ${/cgpa|degree|%/i.test(cleanVal) ? cleanVal : cleanVal + ' CGPA'}`);
        }
      } else if (raw) {
        const ugMatch = raw.match(/(?:in\s+)?(?:pursuing\s+degree|degree|ug\s+cgpa)\s*[:\-–—\s]*([^\s–—|\(]+(?:\s+or\s+[^\s–—|\(]+)?(?:\s*CGPA|\s*%)?)/i) ||
                        raw.match(/cgpa\s*(?:>=|:|of|above)?\s*(\d+(?:\.\d+)?)/i);
        if (ugMatch) {
          const val = (ugMatch[1] || ugMatch[0]).trim();
          if (!isGarbled(val)) {
            addPill(`UG: ${/cgpa|%/i.test(val) ? val : val + ' CGPA'}`);
          }
        }
      }

      // 3. PG Requirement (only if explicitly in raw)
      if (raw && /(?:for\s+PGs?\)?|in\s+PG\b|Post\s*Graduation)/i.test(raw)) {
        const pgMatch = raw.match(/(?:for\s+PGs?\)?|in\s+PG\b|Post\s*Graduation)\s*[:\-–—\s]*([^\s]+(?:\s+or\s+[^\s]+)?(?:\s*CGPA|\s*%)?)/i);
        if (pgMatch && !isGarbled(pgMatch[1])) addPill(`PG: ${pgMatch[1].trim()}`);
      }

      // 4. Backlogs
      if (backlogReq) {
        addPill(backlogReq);
      } else if (raw && /arrear/i.test(raw)) {
        if (/no\s*(?:standing)?\s*arrears\s*(?:and|&)\s*no\s*academic\s*gap/i.test(raw)) {
          addPill('No standing arrears & no academic gap');
        } else if (/no\s*(?:standing)?\s*arrears|0\s*arrear/i.test(raw)) {
          addPill('No standing arrears');
        } else if (/no\s*(?:history\s*of\s*)?arrears/i.test(raw)) {
          addPill('No history of arrears');
        }
      }

      // 5. Eligible Branches
      if (branches && Array.isArray(branches) && branches.length > 0) {
        const branchStr = branches.join(', ');
        addPill(`Branches: ${branchStr.length > 40 ? branchStr.slice(0, 37) + '...' : branchStr}`);
      }
    }

    return pills;
  }, [
    company.application?.eligibility,
    company.application?.branches,
    company.application?.cgpaRequirement,
    company.application?.backlogRequirement,
  ]);

  return (
    <div data-testid="company-detail-page" className="mx-auto max-w-4xl space-y-4 w-full min-w-0 my-3">
      {/* Back button */}
      <button
        data-testid="back-to-pipeline-btn"
        onClick={() => router.back()}
        className="flex items-center gap-2 text-xs font-semibold text-zinc-500 transition-colors hover:text-zinc-200 cursor-pointer"
      >
        <ArrowLeft className="h-4 w-4" /> Back to pipeline
      </button>

      {/* Header Card */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45 }}
        className="rounded-2xl border border-zinc-800 bg-bg-surface p-4 sm:p-6"
      >
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 sm:gap-4">
          <div className="flex items-start gap-3 sm:gap-4 min-w-0 flex-1">
            <div className={`flex h-12 w-12 sm:h-14 sm:w-14 shrink-0 items-center justify-center rounded-xl border font-display text-base sm:text-lg font-bold ${hue}`}>
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="font-display text-xl sm:text-2xl font-extrabold tracking-tight text-white truncate flex items-baseline gap-2">
                <span>{company.name}</span>
                {company.driveNumber && (() => {
                  const m = company.driveNumber.match(/\d+$/);
                  const displayNum = m ? `#${m[0]}` : company.driveNumber;
                  const tooltip = company.driveNumber.toLowerCase().startsWith('drive')
                    ? `Placement Drive: ${company.driveNumber}`
                    : `Placement Drive Number: ${displayNum} (${company.driveNumber})`;

                  return (
                    <span
                      title={tooltip}
                      className="font-mono text-xs sm:text-sm font-normal text-zinc-400 select-all shrink-0 cursor-help hover:text-zinc-300 transition-colors"
                    >
                      {displayNum}
                    </span>
                  );
                })()}
              </h1>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 sm:gap-2">
                <span className="text-xs sm:text-sm text-zinc-300 font-medium truncate max-w-[240px] sm:max-w-md" title={displayRole}>{displayRole}</span>
                {category && (
                  <>
                    <span className="text-xs sm:text-sm text-zinc-600 font-mono select-none">·</span>
                    <span className="text-xs sm:text-sm text-zinc-400 font-medium">{category}</span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-2.5 self-start sm:self-auto shrink-0">
            {/* Status override dropdown — single unified pill with cursor-pointer */}
            <div className="relative">
              {(() => {
                // Use effectiveStatus (same as the company card) so both show identical labels
                const normStatus = (displayStatus || 'not_applied').toLowerCase();
                const m = STATUS_META[normStatus] || STATUS_META.not_applied;
                return (
                  <button
                    onClick={() => setShowStatusMenu(!showStatusMenu)}
                    disabled={isUpdating}
                    className={cn(
                      'inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-all cursor-pointer select-none hover:brightness-110 active:scale-95',
                      m.cls
                    )}
                    title="Click to manually update hiring status"
                  >
                    <span className={cn('h-2 w-2 rounded-full shrink-0', m.dot, m.isPulse ? 'pulse-dot' : '')} />
                    <span>{m.label}</span>
                    <ChevronDown className="h-3.5 w-3.5 opacity-60 transition-transform" />
                  </button>
                );
              })()}

              {showStatusMenu && (
                <>
                  <div
                    className="fixed inset-0 z-40 cursor-default"
                    onClick={() => setShowStatusMenu(false)}
                  />
                  <div className="absolute right-0 top-full mt-2 w-52 p-1.5 bg-[#12121c] border border-zinc-800 rounded-xl shadow-2xl z-50 animate-fade-in divide-y divide-zinc-800/60 max-h-72 overflow-y-auto">
                    <div className="px-3 py-1.5 text-[10px] font-bold text-zinc-500 uppercase tracking-wider">
                      Override Status
                    </div>
                    <div className="space-y-0.5 pt-1">
                      {ALL_STATUSES.map((s) => (
                        <button
                          key={s.value}
                          onClick={() => handleStatusChange(s.value)}
                          className={cn(
                            'flex items-center justify-between w-full px-3 py-2 text-xs rounded-lg transition-colors text-left cursor-pointer',
                            status === s.value
                              ? 'bg-emerald-500/10 text-emerald-400 font-bold'
                              : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60'
                          )}
                        >
                          <span>{s.label}</span>
                          {status === s.value && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* 4 Info Cards (CTC, Stipend, Drive Mode, Work Location) */}
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div data-testid="ctc-total" className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-3.5 py-3">
            <div className="font-mono text-[9px] uppercase tracking-widest text-zinc-500">Total CTC</div>
            <div className="font-tabular mt-1 font-display text-base sm:text-lg font-bold text-emerald-300 truncate" title={cleanCtc}>
              {cleanCtc}
            </div>
          </div>

          <div data-testid="ctc-stipend" className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-3.5 py-3">
            <div className="font-mono text-[9px] uppercase tracking-widest text-zinc-500">Stipend</div>
            <div className="font-tabular mt-1 font-display text-base sm:text-lg font-bold text-zinc-200 truncate" title={cleanStipend || (cleanCtc !== 'TBA' ? 'N/A' : 'TBA')}>
              {cleanStipend || (cleanCtc !== 'TBA' ? 'N/A' : 'TBA')}
            </div>
          </div>

          <div data-testid="ctc-drive-mode" className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-3.5 py-3">
            <div className="font-mono text-[9px] uppercase tracking-widest text-zinc-500">Drive Mode</div>
            {(() => {
              const driveColor =
                driveModeDisplay === 'Online'
                  ? 'text-emerald-300'
                  : driveModeDisplay.endsWith('Labs')
                  ? 'text-indigo-300'
                  : driveModeDisplay === 'VIT Vellore'
                  ? 'text-amber-300'
                  : driveModeDisplay === 'VIT Chennai'
                  ? 'text-orange-300'
                  : driveModeDisplay === 'VIT AP'
                  ? 'text-purple-300'
                  : 'text-cyan-300';
              return (
                <div className={cn("font-tabular mt-1 font-display text-base sm:text-lg font-bold truncate", driveColor)} title={driveModeDisplay}>
                  {driveModeDisplay}
                </div>
              );
            })()}
          </div>

          <div data-testid="ctc-location" className="group relative rounded-xl border border-zinc-800 bg-zinc-900/50 px-3.5 py-3 hover:border-zinc-700 transition-colors">
            <div className="font-mono text-[9px] uppercase tracking-widest text-zinc-500">Work Location</div>
            <div
              className={cn(
                "font-tabular mt-1 font-display text-base sm:text-lg font-bold truncate",
                (!displayLocation || displayLocation === 'Not Specified') ? "text-zinc-500 font-medium" : "text-zinc-200"
              )}
              title={displayLocation && displayLocation !== 'Not Specified' ? displayLocation : 'To be announced'}
            >
              {displayLocation && displayLocation !== 'Not Specified' ? displayLocation : 'TBA'}
            </div>
            {displayLocation && displayLocation.length > 18 && displayLocation !== 'Not Specified' && (
              <div className="pointer-events-none absolute left-0 bottom-full mb-2 hidden w-max max-w-xs rounded-lg border border-zinc-700/80 bg-zinc-950/95 px-3 py-2 text-xs text-zinc-200 shadow-2xl backdrop-blur-md group-hover:block z-30 transition-all font-sans font-medium leading-relaxed">
                <div className="font-mono text-[9px] uppercase tracking-wider text-zinc-400 mb-0.5">Full Location</div>
                {displayLocation}
              </div>
            )}
          </div>
        </div>

        {/* Eligibility Criteria */}
        {eligibilityList.length > 0 && (
          <div className="mt-5 pt-4 border-t border-zinc-800/70">
            <div className="flex items-center gap-1.5 mb-2.5">
              <GraduationCap className="h-3.5 w-3.5 text-zinc-400" />
              <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                Eligibility Criteria
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {eligibilityList.map((e) => (
                <span
                  key={e}
                  className="rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1 font-mono text-[10px] text-zinc-300"
                >
                  {e}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Venue / Instructions Banner */}
        {nextUpcomingEvent && (
          <div
            data-testid="venue-banner"
            className="mt-4 flex items-start gap-3 rounded-lg border border-amber-500/25 bg-amber-500/6 px-4 py-3 text-xs text-amber-200/90"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <div>
              <span className="font-semibold">{nextUpcomingEvent.title || 'Assessment Instructions'}:</span>{' '}
              {new Date(nextUpcomingEvent.startTime!).toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
              {nextUpcomingEvent.venue && ` · Venue: ${nextUpcomingEvent.venue}`}
              {nextUpcomingEvent.mode && ` (${nextUpcomingEvent.mode})`}
            </div>
          </div>
        )}

        {/* Terminal state banner */}
        {terminal && (
          <div
            data-testid="terminal-banner"
            className="mt-4 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-xs text-zinc-400"
          >
            {isWithdrawn
              ? 'You opted out or withdrew from this drive. Archived from the active pipeline.'
              : displayStatus === 'rejected_test' || status === 'rejected_test' || effective.eliminatedStage === 3
              ? 'Eliminated in the test round. This drive is archived — the radar stays on the next ones.'
              : displayStatus === 'rejected_interview' || status === 'rejected_interview' || effective.eliminatedStage === 4
              ? 'Interview completed · Not selected. This drive is archived — the radar stays on the next ones.'
              : displayStatus === 'not_shortlisted' || status === 'not_shortlisted' || effective.eliminatedStage === 2
              ? "Your ID wasn't in the shortlist. This drive is archived — the radar stays on the next ones."
              : "Your ID wasn't in the final selection sheet. This drive is archived — the radar stays on the next ones."}
          </div>
        )}
      </motion.div>

      {/* Recruitment Stage Stepper */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, delay: 0.1 }}
        className="rounded-2xl border border-zinc-800 bg-bg-surface p-6"
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">
            {effective.effectiveStatus === 'registration_open' ? 'Registration Window' : 'Recruitment Stage'}
          </h2>
          {effective.effectiveStatus !== 'registration_open' && (
            <span
              className={cn(
                'font-mono text-[10px]',
                effective.eliminatedStage !== -1 ? 'text-rose-400 font-semibold' : 'text-zinc-500'
              )}
            >
              {effective.statusSubtitle}
            </span>
          )}
        </div>
        <StageStepper status={status} events={company.events} notes={notesStr} manualOverride={isManual} />
      </motion.div>

      {/* Circular & Email Timeline */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, delay: 0.2 }}
        className="rounded-2xl border border-zinc-800 bg-bg-surface p-4 sm:p-6 w-full min-w-0 overflow-hidden"
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">
            Circular & Email Timeline
          </h2>
          <span className="font-mono text-[10px] text-zinc-600">
            {company.emails.length} events
          </span>
        </div>

        {company.emails.length === 0 ? (
          <div className="py-8 text-center text-xs text-zinc-500 font-mono">
            No emails or circulars linked to this company yet.
          </div>
        ) : (
          <div className="relative space-y-2.5 before:absolute before:bottom-2 before:left-3.75 before:top-2 before:w-px before:bg-zinc-800 w-full min-w-0">
            {company.emails.map((email, idx) => {
              const isShortlist = email.classification === 'shortlist' || email.subject.toLowerCase().includes('shortlist');
              const isTest = email.classification === 'test' || email.subject.toLowerCase().includes('test') || email.subject.toLowerCase().includes('assessment');
              const isInterview = email.classification === 'interview' || email.subject.toLowerCase().includes('interview');
              const isOffer = email.classification === 'selected' || email.subject.toLowerCase().includes('offer') || email.subject.toLowerCase().includes('congratulations');

              const matchedCandidate = company.candidateMatches.find((cm) =>
                (cm.emailId && cm.emailId === email.id) ||
                (cm.collegeEmailId && (cm.collegeEmailId === email.id || cm.collegeEmailId === email.collegeEmailId))
              );

              const isShortlistOrSelection =
                email.classification === 'shortlist' ||
                email.classification === 'selected' ||
                /(?:shortlist|selection\s*list|selected\s*candidates|shortlisted\s*candidates|next\s*round\s*of\s*selection|selection\s*process|offer\s*selection)/i.test(email.subject) ||
                /(?:shortlist|candidates\s+shortlisted|shortlisted\s+candidates|selection\s+list|selected\s+candidates)/i.test(email.snippet) ||
                Boolean(email.attachmentName && /shortlist|selection|roster|eligible/i.test(email.attachmentName));

              // "Not Shortlisted" should ONLY appear when there's an actual shortlist/roster that was checked
              // Require either: explicit shortlist/selected classification, OR a roster-like attachment name
              // Do NOT show for generic registration/JD emails even if drive is eliminated
              const hasRosterAttachment = Boolean(email.attachmentName && /shortlist|selection|roster|eligible|shortlisted/i.test(email.attachmentName));
              const isExplicitShortlistEmail = email.classification === 'shortlist' || email.classification === 'selected';
              const isNotShortlisted = !matchedCandidate && (isExplicitShortlistEmail || hasRosterAttachment);

              const Icon = matchedCandidate
                ? FileSpreadsheet
                : isNotShortlisted
                ? FileSpreadsheet
                : isOffer
                ? FileSpreadsheet
                : isInterview
                ? CalendarPlus
                : isTest
                ? AlertTriangle
                : isShortlist
                ? FileSpreadsheet
                : Mail;

              const iconCls = matchedCandidate
                ? 'border-emerald-500/50 bg-[#121218] text-emerald-400'
                : isNotShortlisted
                ? 'border-rose-500/50 bg-[#121218] text-rose-400'
                : isOffer
                ? 'border-emerald-500/50 bg-[#121218] text-emerald-400'
                : isInterview
                ? 'border-cyan-500/50 bg-[#121218] text-cyan-400'
                : isTest
                ? 'border-amber-500/50 bg-[#121218] text-amber-400'
                : isShortlist
                ? 'border-violet-500/50 bg-[#121218] text-violet-400'
                : 'border-sky-500/40 bg-[#121218] text-sky-400';

              const isOpen = openAccordion === idx;
              const isPersonal = email.sender.includes('noreply.cdcinfo');

              return (
                <div key={email.id} data-testid={`timeline-item-${idx}`} className="relative flex items-start gap-3 sm:gap-4 w-full min-w-0">
                  <div className={cn('z-10 mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border shadow-sm ring-4 ring-bg-surface', iconCls)}>
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                  </div>

                  <div className="mb-1 flex-1 min-w-0 rounded-xl border border-zinc-800/80 bg-zinc-900/40 transition-colors overflow-hidden">
                    <button
                      data-testid={`timeline-toggle-${idx}`}
                      onClick={() => setOpenAccordion(isOpen ? null : idx)}
                      className="flex w-full items-center justify-between gap-3 px-3.5 sm:px-4 py-3 text-left min-w-0 hover:bg-zinc-900/60 transition-colors cursor-pointer"
                    >
                      <div className="flex-1 min-w-0 overflow-hidden">
                        <div className="text-xs sm:text-sm font-semibold text-zinc-200 line-clamp-2 leading-snug wrap-break-word" title={email.subject}>
                          {email.subject}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[10px] text-zinc-500">
                          <span suppressHydrationWarning>{timeAgo(email.receivedAt)}</span>
                          <span>·</span>
                          <span>{isPersonal ? 'personal gmail' : 'college gmail'}</span>
                          {matchedCandidate && (
                            <>
                              <span>·</span>
                              <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-emerald-400">
                                <Check className="h-2.5 w-2.5" /> Shortlist Verified
                              </span>
                            </>
                          )}
                          {isNotShortlisted && (
                            <>
                              <span>·</span>
                              <span className="inline-flex items-center gap-1 rounded bg-rose-500/10 border border-rose-500/20 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-rose-400">
                                <X className="h-2.5 w-2.5" /> Not Shortlisted
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                      <ChevronDown
                        className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform duration-200 ${
                          isOpen ? 'rotate-180 text-zinc-300' : ''
                        }`}
                      />
                    </button>

                    <AnimatePresence>
                      {isOpen && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.2 }}
                          className="overflow-hidden"
                        >
                          <div className="border-t border-zinc-800/80 px-4 py-3">
                            {/* Short, clean 1-2 line summary just like the reference designs */}
                            <p className="text-xs leading-relaxed text-zinc-300">
                              {getCleanEmailSummary(
                                email.snippet,
                                email.subject,
                                email.classification,
                                company.name,
                                matchedCandidate ? true : isNotShortlisted ? false : undefined
                              )}
                            </p>

                            {/* Candidate Match Evidence ONLY if verified on THIS specific email */}
                            {matchedCandidate && (() => {
                              const matchInfo = parseCandidateMatchDetails(matchedCandidate.matchedValue, matchedCandidate.neoId || company.candidateRegId);
                              if (!matchInfo) return null;

                              return (
                                <div
                                  data-testid={`excel-evidence-${idx}`}
                                  className="mt-3 overflow-hidden rounded-lg border border-violet-500/25 bg-[#0e0e14]"
                                >
                                  <div className="flex items-center justify-between border-b border-zinc-800 bg-violet-500/[0.07] px-3 py-2">
                                    <span className="flex items-center gap-2 font-mono text-[10px] text-violet-300 font-medium truncate" title={matchInfo.filename}>
                                      <FileSpreadsheet className="h-3.5 w-3.5 shrink-0 text-violet-400" />
                                      <span className="truncate">{matchInfo.filename}</span>
                                    </span>
                                    <span className="font-mono text-[9px] font-semibold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded shrink-0">
                                      shortlist verified
                                    </span>
                                  </div>
                                  <div className="overflow-x-auto">
                                    <div className="min-w-75 grid grid-cols-4 gap-px bg-zinc-800/70 font-mono text-[10px]">
                                      <div className="bg-[#0b0d11] px-2.5 sm:px-3 py-2 text-violet-300 truncate font-semibold">
                                        {matchInfo.identifier}
                                      </div>
                                      <div className="bg-[#0b0d11] px-2.5 sm:px-3 py-2 text-zinc-300 truncate">
                                        {matchInfo.location}
                                      </div>
                                      <div className="bg-[#0b0d11] px-2.5 sm:px-3 py-2 text-zinc-400 truncate">
                                        {matchInfo.column}
                                      </div>
                                      <div className="bg-[#0b0d11] px-2.5 sm:px-3 py-2 font-bold text-emerald-300 whitespace-nowrap text-center">
                                        MATCH ✓
                                      </div>
                                    </div>
                                  </div>
                                  {matchInfo.venue && (
                                    <div className="border-t border-zinc-800/60 bg-zinc-900/40 px-3 py-1.5 text-[10px] font-mono text-zinc-400">
                                      Venue / Reporting: <span className="text-zinc-200">{matchInfo.venue}</span>
                                    </div>
                                  )}
                                </div>
                              );
                            })()}

                            {/* Not Shortlisted Evidence Card */}
                            {isNotShortlisted && (() => {
                              const notShortlistedInfo = getNotShortlistedDetails(
                                email,
                                company.candidateRegId || userRegNo,
                                company.name
                              );
                              return (
                                <div
                                  data-testid={`not-shortlisted-evidence-${idx}`}
                                  className="mt-3 overflow-hidden rounded-lg border border-rose-500/25 bg-[#0e0e14]"
                                >
                                  <div className="flex items-center justify-between border-b border-zinc-800 bg-rose-500/[0.06] px-3 py-2">
                                    <span
                                      className="flex items-center gap-2 font-mono text-[10px] text-rose-300 font-medium truncate"
                                      title={notShortlistedInfo.filename}
                                    >
                                      <FileSpreadsheet className="h-3.5 w-3.5 shrink-0 text-rose-400" />
                                      <span className="truncate">{notShortlistedInfo.filename}</span>
                                    </span>
                                    <span className="font-mono text-[9px] font-semibold text-rose-400 bg-rose-500/10 border border-rose-500/20 px-2 py-0.5 rounded shrink-0 uppercase tracking-wider">
                                      not shortlisted
                                    </span>
                                  </div>
                                  <div className="overflow-x-auto">
                                    <div className="min-w-75 grid grid-cols-4 gap-px bg-zinc-800/70 font-mono text-[10px]">
                                      <div className="bg-[#0b0d11] px-2.5 sm:px-3 py-2 text-zinc-300 truncate font-semibold">
                                        {notShortlistedInfo.identifier}
                                      </div>
                                      <div className="bg-[#0b0d11] px-2.5 sm:px-3 py-2 text-zinc-400 truncate">
                                        {notShortlistedInfo.roundName}
                                      </div>
                                      <div className="bg-[#0b0d11] px-2.5 sm:px-3 py-2 text-zinc-500 truncate">
                                        {notShortlistedInfo.rosterType}
                                      </div>
                                      <div className="bg-[#0b0d11] px-2.5 sm:px-3 py-2 font-bold text-rose-400 whitespace-nowrap text-center">
                                        NO MATCH ✗
                                      </div>
                                    </div>
                                  </div>
                                  <div className="border-t border-zinc-800/60 bg-zinc-900/40 px-3 py-1.5 text-[10px] font-mono text-zinc-400 flex items-center gap-1.5">
                                    <span className="text-rose-400/90 font-bold">ℹ</span>
                                    <span>Official shortlist roster · Candidate registration ID was not selected for this round</span>
                                  </div>
                                </div>
                              );
                            })()}

                            {/* Action links row: Direct link to original Gmail thread */}
                            <div className="mt-3.5 flex flex-col xs:flex-row xs:items-center justify-between gap-2 pt-2.5 border-t border-zinc-800/60">
                              <a
                                href={getGmailLink(email)}
                                target="_blank"
                                rel="noopener noreferrer"
                                data-testid={`open-email-${idx}`}
                                className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-400 hover:text-emerald-300 transition-colors shrink-0 py-0.5"
                              >
                                <span>Open original email</span>
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                              <div className="flex items-center gap-1.5 text-[10px] font-mono text-zinc-500 min-w-0 max-w-full">
                                <span className="text-zinc-600 shrink-0">From:</span>
                                <span className="truncate" title={email.sender}>
                                  {email.sender}
                                </span>
                              </div>
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </motion.div>
    </div>
  );
}
