/** Display-only recruitment venues. Never consume job location, status notes or inferred events. */
export interface VenueEntry {
  stage: string;
  kind: 'online' | 'campus' | 'office' | 'place' | 'respective' | 'unknown';
  name: string;
  city?: string;
  audience?: string;
  quote: string;
}
export interface RecruitmentVenues { version: 1; entries: Array<VenueEntry & { sourceId: string; receivedAt: string }> }
export interface DriveVenueDisplay { label: string; detail?: string }

const campuses = ['Bhopal', 'Vellore', 'Chennai', 'AP'] as const;
export function knownCampus(email?: string | null): string | undefined {
  const domain = email?.toLowerCase().split('@')[1];
  return domain === 'vitbhopal.ac.in' ? 'VIT Bhopal' : ['vit.ac.in', 'vitstudent.ac.in'].includes(domain || '') ? 'VIT Vellore'
    : ['chennai.vit.ac.in', 'chennai.vitstudent.ac.in'].includes(domain || '') ? 'VIT Chennai' : ['vitap.ac.in', 'vitapstudent.ac.in'].includes(domain || '') ? 'VIT AP' : undefined;
}
function campusIn(text: string): string | undefined {
  const match = text.match(/\bVIT\s*[-,]?\s*(Bhopal|Vellore|Chennai|AP|Amaravati)\b|\b(Bhopal|Vellore|Chennai|AP)\s+(?:LC|labs?|campus)\b/i);
  const name = match?.[1] || match?.[2];
  return name ? `VIT ${campuses.find(c => c.toLowerCase() === name.toLowerCase()) || 'AP'}` : undefined;
}
function stageIn(text: string): string | undefined {
  const stages = [
    [/\binterviews?|technical round|managerial round|HR round/i, 'Interviews'],
    [/\bgame(?:\s+(?:based|round))?\b/i, 'Game round'],
    [/\b(?:test|assessment)(?:\s*(?:round)?\s*([12]))?\b/i, 'Test'],
    [/\bPPT\b|pre[ -]?placement talk/i, 'PPT'],
  ] as const;
  for (const [pattern, name] of stages) {
    const match = text.match(pattern);
    if (match) return name === 'Test' && match[1] ? `Test ${match[1]}` : name;
  }
}

/** Input is the current circular, with quoted reply history removed by the existing body helper. */
export function extractRecruitmentVenues(subject: string, body: string): VenueEntry[] {
  const entries: VenueEntry[] = [];
  const subjectStage = stageIn(subject);
  let sectionStage = subjectStage;
  // Sentence-local extraction prevents a Work Location/office footer from supplying a venue.
  // Gmail plain text wraps prose at ~78 columns; restore continued clauses, not table headings.
  const unwrapped = body.replace(/\b(in|at|from|the|our|respective|VIT)\s*\r?\n\s*/g, '$1 ')
    .replace(/([^\n.!?:])\r?\n(?=[a-z])/g, '$1 ');
  const lines = `${subject}\n${unwrapped}`.split(/\r?\n|;\s*|(?<=[.!?])\s+(?=[A-Z*])/).map(s => s.replace(/[*_]/g, '').trim()).filter(Boolean);
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index];
    if (/^(?:regards|warm regards|best regards)\b/i.test(line)) break;
    if (/^(?:job|work)\s*location\s*:/i.test(line)) continue;
    if (line.length < 90 && /^(?:interview process|test details|assessment details|PPT details)/i.test(line)) sectionStage = stageIn(line);
    // A labeled table cell may put its value on the next line.
    if (/^(?:(?:test|interview|PPT|assessment)\s+)?venue\s*[:\-]?$/i.test(line)) line += ` ${lines[index + 1] || ''}`;
    const stage = stageIn(line) || sectionStage || 'Recruitment';
    const recruitment = stage !== 'Recruitment' || /\b(?:recruitment|placement drive|selection process)\b/i.test(line);
    const attendance = /\b(?:held|conducted|scheduled|attend|report|appear|take place)\b/i.test(line);
    const venueLabel = /(?:^|\b)(?:(?:test|interview|PPT|assessment)\s+)?venue\s*[:\-@]/i.test(line);
    if (!recruitment || (!attendance && !venueLabel && !/\b(?:test|assessment).{0,25}(?:at|from)\s+(?:own|home)\s+location/i.test(line))) continue;
    if (/\b(?:not|no longer|cancelled|canceled)\b|\b(?:may|might|could)\s+(?:be|take)\b/i.test(line)) continue;
    // Registration instructions are not attendance evidence, even if the subject mentions a test.
    if (/\b(?:registration|register|deadline|job location|work location)\b/i.test(line) && !stageIn(line)) continue;
    const audienceMatch = line.match(/\b(VIT\s+(?:Bhopal|Vellore|Chennai|AP))\s+(?:students|candidates)\b|\b(?:students|candidates)\s+(?:of|from)\s+(VIT\s+(?:Bhopal|Vellore|Chennai|AP))\b/i);
    const audience = audienceMatch ? campusIn(audienceMatch[1] || audienceMatch[2]) : undefined;
    // Compound campus exceptions without a clear audience are not a universal instruction.
    if (/\bothers\b|\bexcept\b/i.test(line)) continue;
    const base = { stage, quote: line.slice(0, 220), ...(audience ? { audience } : {}) };
    const venueText = line.match(/\bvenue\s*[:\-@]\s*(.+)/i)?.[1]
      || line.match(/\b(?:held|conducted|scheduled|attend|report|appear|take place)\b.{0,65}?\b(?:at|in|from)\s+(.+)/i)?.[1];
    // Only the attendance clause supplies a campus, never an audience or nearby job city.
    const campus = venueText ? campusIn(venueText) : undefined;
    const office = venueText?.match(/^(?:person\s+at\s+)?(?:the\s+)?([A-Za-z][A-Za-z0-9 &.-]{0,65}?)\s+office\b/i);
    let entry: VenueEntry | undefined;
    if (/\b(?:TBA|TBD|to be announced|informed later)\b/i.test(line)) entry = { ...base, kind: 'unknown', name: '' };
    else if (venueText && /\brespective\s+(?:campus|campuses|college)\b/i.test(venueText)) entry = { ...base, kind: 'respective', name: 'Respective campus' };
    else if (office) {
      const city = office[1].match(/\b(Chennai|Bangalore|Bengaluru|Hyderabad|Mumbai|Pune|Delhi|Gurugram|Gurgaon|Noida|Kolkata|Bhopal|Vellore|Amaravati)\b/i)?.[1]
        || venueText!.slice((office.index || 0) + office[0].length).match(/^\s*[,–-]?\s*(?:in|at)?\s*(Chennai|Bangalore|Bengaluru|Hyderabad|Mumbai|Pune|Delhi|Gurugram|Gurgaon|Noida|Kolkata)\b/i)?.[1];
      entry = { ...base, kind: 'office', name: `${office[1].trim()} office`, ...(city ? { city: city[0].toUpperCase() + city.slice(1).toLowerCase() } : {}) };
    } else if (campus) entry = { ...base, kind: 'campus', name: campus };
    else if (venueText && /\b(?:auditorium|gallery|hall|hotel|centre|center)\b/i.test(venueText)) entry = { ...base, kind: 'place', name: venueText.replace(/[.,]$/, '').slice(0, 90) };
    else if (/\b(?:online|virtual|remote|own location|home location)\b/i.test(line) && !/\b(?:labs?|LC|in person|in-person|office|auditorium|campus)\b/i.test(line)) entry = { ...base, kind: 'online', name: 'Online' };
    if (entry) entries.push(entry);
  }
  // Conflicting instructions for one stage/audience stay unknown rather than guessing.
  const grouped = new Map<string, VenueEntry[]>();
  for (const entry of entries) {
    const key = `${entry.stage}:${entry.audience || ''}`;
    grouped.set(key, [...(grouped.get(key) || []), entry]);
  }
  return [...grouped.values()].map(group => {
    const unique = new Set(group.map(e => `${e.kind}:${e.name}:${e.city || ''}`));
    return unique.size === 1 ? group[0] : { ...group[0], kind: 'unknown' as const, name: '' };
  }).slice(0, 12);
}

export function resolveDriveVenue(value: unknown, userCampus?: string): DriveVenueDisplay {
  const projection = value as RecruitmentVenues | null;
  if (projection?.version !== 1 || !Array.isArray(projection.entries)) return { label: 'To be announced' };
  const applicable = projection.entries.filter(e => e && typeof e.stage === 'string' && typeof e.name === 'string' && (!e.audience || e.audience === userCampus));
  const explicit = applicable.filter(e => e.stage !== 'Recruitment');
  const entries = (explicit.length ? explicit : applicable).filter(e => e.kind !== 'unknown');
  const locations = new Map<string, string[]>();
  for (const entry of entries) {
    const label = entry.kind === 'online' ? 'Online' : entry.kind === 'office' ? `Company Office${entry.city ? ` · ${entry.city}` : ''}`
      : entry.kind === 'campus' || entry.kind === 'place' ? entry.name : entry.kind === 'respective' ? userCampus : undefined;
    if (!label) continue;
    const detail = `${entry.stage}: ${entry.kind === 'respective' ? label : entry.name}`;
    locations.set(label, [...(locations.get(label) || []), detail]);
  }
  if (!locations.size) return { label: 'To be announced' };
  return { label: locations.size > 1 ? 'Multiple locations' : [...locations.keys()][0], detail: [...new Set([...locations.values()].flat())].join('; ').slice(0, 220) };
}
