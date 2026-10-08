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
  if (/\b(?:PPT|pre[ -]?placement talk)\b.{0,25}\bfollowed by\b/i.test(text)) return 'PPT';
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
  const subjectStage = stageIn(subject) || (/\bonline\b.*\bscheduled\b/i.test(subject) && /\bassessment\b/i.test(body) ? 'Test' : undefined);
  let sectionStage = subjectStage;
  // Sentence-local extraction prevents a Work Location/office footer from supplying a venue.
  // Gmail plain text wraps prose at ~78 columns; restore continued clauses, not table headings.
  const unwrapped = body.replace(/\b(in|at|from|the|our|respective|VIT)\s*\r?\n\s*/g, '$1 ')
    .replace(/([^\n.!?:])\r?\n(?=[a-z])/g, '$1 ');
  const clauses = unwrapped.replace(/,\s*(?=(?:VIT\s+)?(?:Bhopal|Vellore|Chennai|AP)(?:\s*(?:&|and)\s*(?:VIT\s+)?(?:Bhopal|Vellore|Chennai|AP))?\s+(?:campus\s+)?(?:students|candidates|campus)\s+(?:will|must|should|need|are)\b)/gi, '\n');
  const lines = `${subject}\n${clauses}`.split(/\r?\n|;\s*|(?<=[.!?])\s+(?=[A-Z*])/).map(s => s.replace(/[*_]/g, '').trim()).filter(Boolean);
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index];
    if (/^(?:regards|warm regards|best regards)\b/i.test(line)) break;
    if (/^(?:job|work)\s*location\s*:/i.test(line)) continue;
    if (/\b(?:mock|practice|training|guidance)\b/i.test(line)) continue;
    if (/\b(?:suspended|blacklisted|disqualified)\b/i.test(line)) continue;
    if (/\bplaced students\b|\b(?:volunteer|to help|help with|assist with)\b/i.test(line)) continue;
    if (line.length < 90 && /^(?:interview process|test details|assessment details|PPT details)/i.test(line)) sectionStage = stageIn(line);
    // A labeled table cell may put its value on the next line.
    if (/^(?:(?:test|interview|PPT|assessment)\s+)?venue\s*[:\-]?$/i.test(line)) line += ` ${lines[index + 1] || ''}`;
    const stage = stageIn(line) || sectionStage || 'Recruitment';
    // Campus venue tables are attendance evidence when the circular names a round.
    const campusCell = sectionStage && line.match(/^(?:VIT\s+)?(Bhopal|Vellore|Chennai|AP)\s+campus\s*[:–-]\s*(.+)$/i);
    if (campusCell && /\b(?:PRP|SJT|CDC|AB\d|L\d{3,4})\b/i.test(campusCell[2])) {
      entries.push({stage,kind:'place',name:campusCell[2].slice(0,90),audience:`VIT ${campuses.find(c=>c.toLowerCase()===campusCell[1].toLowerCase())}`,quote:line.slice(0,220)});
      continue;
    }
    const reportingRoom = /\breport\s+(?:to|at)\s+(?:the\s+)?(?:LC|PRP|SJT|CDC)\b/i.test(line);
    const recruitment = stage !== 'Recruitment' || /\b(?:recruitment|placement drive|selection process)\b/i.test(line) || reportingRoom;
    const attendance = /\b(?:held|conducted|scheduled|attend|report|appear|take place|will have|will be having)\b/i.test(line);
    const venueLabel = /(?:^|\b)(?:(?:test|interview|PPT|assessment)\s+)?venue\s*[:\-@]/i.test(line);
    const datedVenue = /^\s*(?:online\s+)?(?:test|assessment|interviews?|PPT)\s*:\s*[^\n@]{0,60}@/i.test(line);
    if (!recruitment || (!attendance && !venueLabel && !datedVenue && !/\b(?:test|assessment).{0,25}(?:at|from)\s+(?:own|home)\s+location/i.test(line))) continue;
    if (/\b(?:not|no longer|cancelled|canceled)\b|\b(?:may|might|could)\s+(?:be|take)\b/i.test(line)) continue;
    // Registration instructions are not attendance evidence, even if the subject mentions a test.
    if (/\b(?:registration|register|deadline|job location|work location)\b/i.test(line) && !stageIn(line)) continue;
    const audienceMatch = line.match(/\b(VIT\s+(?:Bhopal|Vellore|Chennai|AP))\s+(?:students|candidates)\b|\b(?:students|candidates)\s+(?:of|from)\s+(VIT\s+(?:Bhopal|Vellore|Chennai|AP))\b/i);
    const audienceList = line.match(/^(?:For\s+)?((?:VIT\s+)?(?:Bhopal|Vellore|Chennai|AP)(?:\s*(?:&|and)\s*(?:VIT\s+)?(?:Bhopal|Vellore|Chennai|AP))*)\s+(?:campus\s+)?(?:students|candidates|shortlist|campus)\b/i);
    const audiences = audienceList ? [...audienceList[1].matchAll(/\b(Bhopal|Vellore|Chennai|AP)\b/gi)].map(m=>`VIT ${campuses.find(c=>c.toLowerCase()===m[1].toLowerCase())}`) : [];
    const audience = audiences[0] || (audienceMatch ? campusIn(audienceMatch[1] || audienceMatch[2]) : undefined);
    // Compound campus exceptions without a clear audience are not a universal instruction.
    if (/\bothers\b|\bexcept\b/i.test(line)) continue;
    if (!audience && /\bphysical\b.*\bvirtual\b|\bvirtual\b.*\bphysical\b/i.test(line)) continue;
    if (/\bother campus\b.*\bvirtual(?:ly)?\b/i.test(line) && !audience) continue;
    const base = { stage, quote: line.slice(0, 220), ...(audience ? { audience } : {}) };
    const venueText = line.match(/\bvenue\s*[:\-@]\s*(.+)/i)?.[1]
      || [...line.matchAll(/@\s*([^@]+)/g)].at(-1)?.[1]
      || line.match(/\b(?:held|conducted|scheduled|attend|report|appear|take place|having)\b.{0,100}?\b(?:at|in|from|to)\s+(?!\d)(.+)/i)?.[1];
    // Only the attendance clause supplies a campus, never an audience or nearby job city.
    const campus = venueText ? campusIn(venueText) : undefined;
    const office = venueText?.match(/^(?:person\s+at\s+)?(?:the\s+)?([A-Za-z][A-Za-z0-9 &.-]{0,65}?)\s+office\b/i);
    let entry: VenueEntry | undefined;
    if (/\b(?:TBA|TBD|to be announced|informed later)\b/i.test(line)) entry = { ...base, kind: 'unknown', name: '' };
    else if (venueText && /\brespective\s+(?:campus|campuses|college)\b/i.test(venueText)) entry = { ...base, kind: 'respective', name: 'Respective campus' };
    else if (venueText && /\brespective\s+(?:campus\s+)?(?:CDC\s*(?:offices?|venues?|labs?)?|labs?)\b/i.test(venueText)) entry = { ...base, kind: 'respective', name: 'Respective campus' };
    else if (venueText && /^(?:the\s+)?campus(?:\s+labs?)?\b/i.test(venueText)) entry = { ...base, kind: 'respective', name: 'Respective campus' };
    else if (campus) entry = { ...base, kind: 'campus', name: campus };
    else if (office && !/\bCDC\b/i.test(office[1])) {
      const city = office[1].match(/\b(Chennai|Bangalore|Bengaluru|Hyderabad|Mumbai|Pune|Delhi|Gurugram|Gurgaon|Noida|Kolkata|Bhopal|Vellore|Amaravati)\b/i)?.[1]
        || venueText!.slice((office.index || 0) + office[0].length).match(/^\s*[,–-]?\s*(?:in|at)?\s*(Chennai|Bangalore|Bengaluru|Hyderabad|Mumbai|Pune|Delhi|Gurugram|Gurgaon|Noida|Kolkata)\b/i)?.[1];
      entry = { ...base, kind: 'office', name: `${office[1].trim()} office`, ...(city ? { city: city[0].toUpperCase() + city.slice(1).toLowerCase() } : {}) };
    } else if (venueText && /\b(?:auditorium|gallery|hall|hotel|centre|center|PRP|SJT|LC|CDC|Channa)\s*\d*\b/i.test(venueText)) {
      entry = { ...base, kind: 'place', name: venueText.replace(/^[-\s]+/, '').replace(/\s*[-–]\s*(?:Report immediately|Batch\b|.*Shortlist\b).*$/i, '').replace(/\s+(?:only|on time|with your|for the interviews|at\s+\d|by\s+\d|if you)\b.*$/i,'').replace(/[.,]$/, '').slice(0, 90) };
    }
    // "Online test" describes the platform, not permission to attend remotely.
    // Explicit home/virtual attendance is required, and physical venues take priority.
    else if (/\b(?:virtual|remote|own locations?|home location|(?:held|conducted|attend)\s+online)\b/i.test(line)
      && !/\b(?:labs?|LC|PRP|SJT|CDC|Channa|in person|in-person|office|auditorium|gallery|campus)\b/i.test(audienceList ? line.slice(audienceList[0].length) : line)) entry = { ...base, kind: 'online', name: 'Online' };
    if (entry) entries.push(...(audiences.length>1 ? audiences.map(a=>({...entry!,audience:a})) : [entry]));
  }
  // Conflicting instructions for one stage/audience stay unknown rather than guessing.
  const grouped = new Map<string, VenueEntry[]>();
  const campusRouting = /\bother campus\b|\b(?:Bhopal|AP)\b[^\n]{0,100}\bvirtual\b/i.test(clauses);
  for (const original of entries) {
    // A circular that explicitly routes other campuses separately does not make
    // the headline campus venue a universal attendance instruction.
    const entry = campusRouting && !original.audience && original.kind === 'campus'
      ? { ...original, audience: original.name } : original;
    const key = `${entry.stage}:${entry.audience || ''}`;
    grouped.set(key, [...(grouped.get(key) || []), entry]);
  }
  return [...grouped.values()].map(group => {
    if (group.some(e=>['respective','place','campus','office'].includes(e.kind))) {
      group=group.filter(e=>e.kind!=='online' || /\b(?:own|home)\s+locations?|\bremote\b/i.test(e.quote));
    }
    // A universal respective-campus instruction qualifies a headline room;
    // generic "CDC labs" and a specific room are not contradictory venues.
    const respective = group.find(e=>e.kind==='respective');
    if (respective && group.every(e=>['respective','place','campus'].includes(e.kind))) return respective;
    const specific = group.filter(e=>!(e.kind==='place' && /^(?:the\s+)?CDC\s+labs?$/i.test(e.name)));
    if (specific.length && specific.length < group.length) group = specific;
    const unique = new Set(group.map(e => `${e.kind}:${e.name}:${e.city || ''}`));
    return unique.size === 1 ? group[0] : { ...group[0], kind: 'unknown' as const, name: '' };
  }).slice(0, 12);
}

export function resolveDriveVenue(value: unknown, userCampus?: string): DriveVenueDisplay {
  const projection = value as RecruitmentVenues | null;
  if (projection?.version !== 1 || !Array.isArray(projection.entries)) return { label: 'To be announced' };
  const applicable = projection.entries.filter(e => e && typeof e.stage === 'string' && typeof e.name === 'string' && (!e.audience || e.audience === userCampus));
  // A later generic selection round can add a physical venue after an online PPT.
  const scopedStages = new Set(applicable.filter(e=>e.audience===userCampus && e.audience).map(e=>e.stage));
  const entries = applicable.filter(e => e.kind !== 'unknown' && (e.audience || !scopedStages.has(e.stage)));
  const locations = new Map<string, string[]>();
  const attendanceLocations = new Set<string>();
  for (const entry of entries) {
    // This kind requires explicit remote attendance, not just an online test platform.
    const label = entry.kind === 'online' ? 'Own location' : entry.kind === 'office' ? `Company Office${entry.city ? ` · ${entry.city}` : ''}`
      : entry.kind === 'campus' || entry.kind === 'place' ? entry.name : entry.kind === 'respective' ? userCampus : undefined;
    if (!label) continue;
    if (entry.kind !== 'online') attendanceLocations.add(label);
    const detail = `${entry.stage}: ${entry.kind === 'respective' || entry.kind === 'online' ? label : entry.name}`;
    locations.set(label, [...(locations.get(label) || []), detail]);
  }
  if (!locations.size) return { label: 'To be announced' };
  // The badge answers whether campus/office attendance is required. A remote
  // round must not hide a confirmed travel requirement behind "Multiple locations".
  const headlineLocations = attendanceLocations.size ? attendanceLocations : new Set(locations.keys());
  return { label: headlineLocations.size > 1 ? 'Multiple locations' : [...headlineLocations][0], detail: [...new Set([...locations.values()].flat())].join('; ').slice(0, 220) };
}
