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
export interface DriveVenueDisplay { label: string; detail?: string; requiresTravel?: boolean }
export type DriveMode = 'Own Location' | 'Home Campus' | 'Other Campus' | 'External Venue' | 'TBA';
export interface DriveModeRound { stage: string; mode: DriveMode; venue: string; requiresTravel?: boolean }
export interface DriveModeDisplay { label: DriveMode; shortVenue?: string; detail?: string; requiresTravel?: boolean; rounds: DriveModeRound[] }

const campuses = ['Bhopal', 'Vellore', 'Chennai', 'AP'] as const;
export function knownCampus(email?: string | null): string | undefined {
  const domain = email?.toLowerCase().split('@')[1];
  return domain === 'vitbhopal.ac.in' ? 'VIT Bhopal' : ['vit.ac.in', 'vitstudent.ac.in'].includes(domain || '') ? 'VIT Vellore'
    : ['chennai.vit.ac.in', 'chennai.vitstudent.ac.in'].includes(domain || '') ? 'VIT Chennai' : ['vitap.ac.in', 'vitapstudent.ac.in'].includes(domain || '') ? 'VIT AP' : undefined;
}
function campusIn(text: string): string | undefined {
  // These buildings belong to Vellore even when a circular omits the campus name.
  if (/\b(?:SJT|PRP)\s*[-–]?\s*(?:\d{1,4}\b|\b)|\bPearl\s+Research\s+Park\b/i.test(text)) return 'VIT Vellore';
  if (/\bSarojini\s+Naidu\s+gallery\b|\b(?:Dr\.?\s*)?Channa\s+Reddy\b/i.test(text)) return 'VIT Vellore';
  const match = text.match(/\bVIT\s*[-,]?\s*(Bhopal|Vellore|Chennai|AP|Amaravati)\b|\b(Bhopal|Vellore|Chennai|AP)\s+(?:LC|labs?|campus)\b/i);
  const name = match?.[1] || match?.[2];
  return name ? `VIT ${campuses.find(c => c.toLowerCase() === name.toLowerCase()) || 'AP'}` : undefined;
}
function venueCampus(entry: VenueEntry): string | undefined {
  if (entry.kind === 'campus') return campusIn(entry.name);
  if (entry.kind !== 'place') return;
  return campusIn(entry.name) || (/\bVellore\b/i.test(entry.name) && /\b(?:gallery|auditorium|CDC|LC)\b/i.test(entry.name) ? 'VIT Vellore' : undefined)
    || (/^(?:VIT\s+)?(?:Bhopal|Vellore|Chennai|AP)\s+campus\s*[:–-]/i.test(entry.quote)
    ? campusIn(entry.quote) : undefined);
}
function stageIn(text: string): string | undefined {
  if (/\b(?:PPT|pre[ -]?placement talk)\b.{0,25}\bfollowed by\b/i.test(text)) return 'PPT';
  const stages = [
    [/\binterviews?|technical round|managerial round|HR round/i, 'Interviews'],
    [/\bgame(?:\s+(?:based|round))?\b/i, 'Game round'],
    [/\bGD\b|\bgroup discussion\b/i, 'Group discussion'],
    [/\b(?:test|assessment)(?:\s*(?:round)?\s*([12]))?\b/i, 'Test'],
    [/\bPPT\b|pre[ -]?placement talk/i, 'PPT'],
  ] as const;
  for (const [pattern, name] of stages) {
    const match = text.match(pattern);
    if (match) return name === 'Test' && match[1] ? `Test ${match[1]}` : name;
  }
}
function audiencePrefix(line: string) {
  const token = '(?:VIT\\s+)?(?:Bhopal|Vellore|Chennai|AP|Amaravati|Amravati)(?:\\s+campus(?:es)?)?';
  const match = line.match(new RegExp(`^(?:[-•,]\\s*)?(?:For\\s+)?(${token}(?:\\s*(?:,?\\s*and|&|,)\\s*${token})*)(?:\\s+(?:students|candidates|shortlist(?:ed)?(?:\\s+candidates)?))?(?=\\s*(?:[:;,–()\\-]|$|(?:the|it|in|virtual|will|shall|can|must|should|are|interviews?|tests?|PPT|GD)\\b))`, 'i'));
  return match ? { prefix: match[0], names: [...match[1].matchAll(/\b(Bhopal|Vellore|Chennai|AP|Amaravati|Amravati)\b/gi)].map(m =>
    `VIT ${campuses.find(c => c.toLowerCase() === m[1].toLowerCase()) || 'AP'}`) } : undefined;
}

/** Input is the current circular, with quoted reply history removed by the existing body helper. */
export function extractRecruitmentVenues(subject: string, body: string): VenueEntry[] {
  const entries: VenueEntry[] = [];
  const subjectStage = stageIn(subject) || (/\bonline\b.*\bscheduled\b/i.test(subject) && /\bassessment\b/i.test(body) ? 'Test' : undefined);
  let sectionStage = subjectStage;
  let sectionAudiences: string[] = [];
  // Sentence-local extraction prevents a Work Location/office footer from supplying a venue.
  // Gmail plain text wraps prose at ~78 columns; restore continued clauses, not table headings.
  const unwrapped = body.replace(/[*_]/g, '').replace(/\b(in|at|from|the|our|respective|VIT)\s*\r?\n\s*/g, '$1 ')
    .replace(/\b(PPT|Interviews?|Test)\s*(&|and|\+)\s*\r?\n\s*(?=Interviews?|PPT|(?:Online\s+)?Test)/gi, '$1 $2 ')
    .replace(/([.!?])(?=(?:PPT|Interviews?|Online\s+Test)\s*(?:&|:))/gi, '$1\n')
    .replace(/([^\n.!?:])\r?\n[ \t]*(?=[a-z])/g, '$1 ')
    .replace(/\b(Bhopal|AP)\s*\r?\n\s*,\s*(AP|Bhopal)\b/gi, '$1, $2');
  const clauses = unwrapped.replace(/,\s*(?=(?:VIT\s+)?(?:Bhopal|Vellore|Chennai|AP)(?:\s*(?:&|and)\s*(?:VIT\s+)?(?:Bhopal|Vellore|Chennai|AP))?\s+(?:campus\s+)?(?:students|candidates|campus)\s+(?:will|must|should|need|are)\b)/gi, '\n')
    .replace(/\s*\/\s*(?=(?:For\s+)?(?:VIT\s+)?(?:Bhopal|AP)\b)/gi, '\n')
    .replace(/\(\s*(?=(?:VIT\s+)?(?:Bhopal|AP)\b)/gi, '\n')
    .replace(/\)\s*&\s*(?=(?:VIT\s+)?(?:Bhopal|AP)\b)/gi, ')\n')
    .replace(/\s+and\s+(?=students\s+from\s+(?:VIT\s+)?(?:Vellore|AP|Chennai)\b)/gi, '\n');
  const lines = `${subject}\n${clauses}`.split(/\r?\n|;\s*|(?<=[.!?])\s+(?=[A-Z*])/).map(s => s.replace(/[*_]/g, '').trim()).filter(Boolean);
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index].replace(/\bVIT\s*[-–]\s*/gi, 'VIT ');
    if (/^Note\s*:\s*(?:VIT\s+)?(?:Bhopal|AP)\b/i.test(line)) line = line.replace(/^Note\s*:\s*/i, '');
    if (/^(?:regards|warm regards|best regards)\b/i.test(line)) break;
    if (/^(?:job|work)\s*location\s*:/i.test(line)) continue;
    if (/\b(?:mock|practice|training|guidance)\b/i.test(line)) continue;
    if (/\b(?:suspended|blacklisted|disqualified)\b/i.test(line)) continue;
    if (/\bplaced students\b|\b(?:volunteer|to help|help with|assist with)\b/i.test(line)) continue;
    // Compact campus venue lists can omit verbs entirely (American Express).
    const localCampusList = line.match(/((?:(?:VIT\s+)?(?:Bhopal|Vellore|Chennai|AP)\s*[,/&]?\s*)+)\brespective\s+(?:campus\s+)?(?:CDC\s+)?labs?\b/i);
    if (localCampusList) {
      const stage=stageIn(line) || subjectStage || stageIn(body) || 'Recruitment';
      for(const match of localCampusList[1].matchAll(/\b(Bhopal|Vellore|Chennai|AP)\b/gi)) entries.push({stage,kind:'respective',name:'Respective campus',audience:`VIT ${campuses.find(c=>c.toLowerCase()===match[1].toLowerCase())}`,quote:line.slice(0,220)});
      const hostRoom=line.match(/\bVellore\s+students\s+(PRP\s*\d+|SJT\s*\d+)/i);
      if(hostRoom) entries.push({stage,kind:'place',name:hostRoom[1],audience:'VIT Vellore',quote:line.slice(0,220)});
      continue;
    }
    if (line.length < 90 && /^(?:interview process|(?:(?:physical|technical|management|HR)\s+)?interviews?\b|test details|assessment details|PPT details)/i.test(line)) sectionStage = stageIn(line);
    // A labeled table cell may put its value on the next line.
    if (/^(?:(?:test|interview|PPT|assessment)\s+)?venue\s*[:\-]?$/i.test(line)) line += ` ${lines[index + 1] || ''}`;
    // Registration tables announce the initial drive mode without a dated round.
    // A virtual visit is explicit Online evidence even when its date is still unknown.
    const visitCell = line.match(/^Date\s+of\s+Visit\s*:?\s*(.*)$/i);
    const visitMode = visitCell && (visitCell[1] || lines[index + 1] || '').trim();
    if (visitMode && /^(?:virtual|online)(?:\s+mode)?[.!]?$/i.test(visitMode)) {
      entries.push({ stage: 'Recruitment', kind: 'online', name: 'Online', quote: `Date of Visit: ${visitMode}` });
      continue;
    }
    const stage = stageIn(line) || sectionStage || 'Recruitment';
    const audienceList = audiencePrefix(line);
    if (audienceList && /^\s*:/.test(line.slice(audienceList.prefix.length))) sectionAudiences = audienceList.names;
    if (audienceList && /^[:\s]*$/.test(line.slice(audienceList.prefix.length))) {
      sectionAudiences = audienceList.names;
      continue;
    }
    if (/^(?:Important\s+)?Note\s*:|^Important\s+Instruction\b|^All\s+(?:the\s+)?students\b/i.test(line)) sectionAudiences = [];
    const audienceMatch = line.match(/\b(?:students|candidates)\s+(?:of|from)\s+(VIT\s+(?:Bhopal|Vellore|Chennai|AP))\b/i);
    const audiences = audienceList?.names || (audienceMatch ? [campusIn(audienceMatch[1])!] : sectionAudiences);
    const audience = audiences[0];
    const audienceRemote = audiences.length > 0 && /\b(?:virtual(?:ly)?|remote(?:ly)?)\b/i.test(line);
    // Campus venue tables are attendance evidence when the circular names a round.
    const campusCell = sectionStage && line.match(/^(?:VIT\s+)?(Bhopal|Vellore|Chennai|AP)\s+campus\s*[:–-]\s*(.+)$/i);
    if (campusCell && /\b(?:PRP|SJT|CDC|AB\d|L\d{3,4})\b/i.test(campusCell[2])) {
      entries.push({stage,kind:'place',name:campusCell[2].slice(0,90),audience:`VIT ${campuses.find(c=>c.toLowerCase()===campusCell[1].toLowerCase())}`,quote:line.slice(0,220)});
      continue;
    }
    const reportingRoom = /\breport\s+(?:to|at)\s+(?:the\s+)?(?:LC|PRP|SJT|CDC)\b/i.test(line);
    const physicalProcessVenue = /\bphysical\s+(?:selection\s+)?process\b.{0,40}\bat\s+VIT\s+(?:Bhopal|Vellore|Chennai|AP)\b/i.test(line);
    const recruitment = stage !== 'Recruitment' || physicalProcessVenue || /\b(?:recruitment|placement drive|selection process|(?:the|this)\s+drive|drive\s+(?:will|shall))\b/i.test(line) || reportingRoom || audienceRemote;
    const attendance = /\b(?:held|conducted|scheduled|attend|report|appear|travel|take|will have|will be having)\b|\b(?:will|shall)\s+be\b|\b(?:is|are)\s+(?:virtual|remote)\b/i.test(line);
    const venueLabel = /(?:^|\b)(?:(?:test|interview|PPT|assessment)\s+)?venue\s*[:\-@]/i.test(line);
    const datedVenue = /^\s*(?:(?:online|physical)\s+)?(?:test|assessment|interviews?|PPT)(?:\s*(?:&|and|\+)\s*(?:(?:online|physical)\s+)?(?:test|assessment|interviews?|PPT))*(?:\s+Date)?\s*:\s*[^\n@]{0,90}@/i.test(line);
    const tableVenue = /^(?:Online\s+)?(?:Test|Assessment|PPT)\b.{0,150}\bAt\s+(?:the\s+)?respective\s+campus(?:es)?\b/i.test(line);
    if (!recruitment || (!attendance && !physicalProcessVenue && !audienceRemote && !venueLabel && !datedVenue && !tableVenue && !/\b(?:test|assessment).{0,25}(?:at|from)\s+(?:own|home)\s+location/i.test(line))) continue;
    if (/\b(?:not|no longer|cancelled|canceled)\b|\b(?:may|might|could)\s+(?:be|take)\b/i.test(line)) continue;
    // Registration instructions are not attendance evidence, even if the subject mentions a test.
    if (/\b(?:registration|register|deadline|job location|work location)\b/i.test(line) && !stageIn(line)) continue;
    // Compound campus exceptions without a clear audience are not a universal instruction.
    if (/\bothers\b|\bexcept\b/i.test(line)) continue;
    if (!audience && /\bphysical\b.*\bvirtual\b|\bvirtual\b.*\bphysical\b/i.test(line)) continue;
    if (/\bother campus\b.*\bvirtual(?:ly)?\b/i.test(line) && !audience) continue;
    const base = { stage, quote: line.slice(0, 220), ...(audience ? { audience } : {}) };
    const venueText = line.match(/^(?:(?:test|interview|PPT|assessment)\s+)?venue\s*[:\-@]\s*(.+)/i)?.[1]
      || [...line.matchAll(/@\s*([^@]+)/g)].at(-1)?.[1]
      || (tableVenue ? line.match(/\bAt\s+((?:the\s+)?respective\s+campus(?:es)?\b.*)/i)?.[1] : undefined)
      || (physicalProcessVenue ? line.match(/\bat\s+(VIT\s+(?:Bhopal|Vellore|Chennai|AP)\b.*)/i)?.[1] : undefined)
      || line.match(/\b(?:held|conducted|scheduled|attend|report|appear|travel|take(?: place)?|having)\b.{0,100}?\b(?:at|in|from|to)\s+(?!\d)(.+)/i)?.[1];
    // Only the attendance clause supplies a campus, never an audience or nearby job city.
    const campus = venueText ? campusIn(venueText) : undefined;
    const office = venueText?.match(/^(?:person\s+at\s+)?(?:the\s+)?([A-Za-z][A-Za-z0-9 &.-]{0,65}?)\s+office\b/i);
    let entry: VenueEntry | undefined;
    if (/\b(?:TBA|TBD|to be announced|informed later)\b/i.test(line)) entry = { ...base, kind: 'unknown', name: '' };
    else if (venueText && /\brespective\s+(?:campus|campuses|college)\b/i.test(venueText)) entry = { ...base, kind: 'respective', name: 'Respective campus' };
    else if (venueText && /\brespective\s+(?:campus\s+)?(?:CDC\s*(?:offices?|venues?|labs?)?|labs?)\b/i.test(venueText)) entry = { ...base, kind: 'respective', name: 'Respective campus' };
    else if (venueText && /^(?:the\s+)?campus(?:\s+labs?)?\b/i.test(venueText)) entry = { ...base, kind: 'respective', name: 'Respective campus' };
    else if (audienceRemote && /\b(?:only\s+(?:in|at)|from)\s+(?:the\s+)?CDC\s+office\b/i.test(line) && !campus) entry = { ...base, kind: 'respective', name: 'Respective campus' };
    else if (campus) {
      // Keep named rooms in the details while resolving their campus in the badge.
      entry = /\b(?:SJT|PRP)\s*[-–]?\s*\d|\bPearl\s+Research\s+Park\b/i.test(venueText || '')
        ? { ...base, kind: 'place', name: venueText!.replace(/[.,]$/, '').slice(0, 90) }
        : { ...base, kind: 'campus', name: campus };
    }
    else if (office && !/\bCDC\b/i.test(office[1])) {
      const city = office[1].match(/\b(Chennai|Bangalore|Bengaluru|Hyderabad|Mumbai|Pune|Delhi|Gurugram|Gurgaon|Noida|Kolkata|Bhopal|Vellore|Amaravati)\b/i)?.[1]
        || venueText!.slice((office.index || 0) + office[0].length).match(/^\s*[,–-]?\s*(?:in|at)?\s*(Chennai|Bangalore|Bengaluru|Hyderabad|Mumbai|Pune|Delhi|Gurugram|Gurgaon|Noida|Kolkata)\b/i)?.[1];
      entry = { ...base, kind: 'office', name: `${office[1].trim()} office`, ...(city ? { city: city[0].toUpperCase() + city.slice(1).toLowerCase() } : {}) };
    } else if (venueText && /^(?:the\s+)?LC\s*\d*\b/i.test(venueText)) {
      entry = { ...base, kind: 'respective', name: venueText.replace(/\s+(?:with|only|for)\b.*$/i, '').slice(0,90) };
    } else if (venueText && /^(?:the\s+)?CDC\s+office\b/i.test(venueText)) {
      entry = { ...base, kind: 'campus', name: 'VIT Vellore' };
    } else if (venueText && /\b(?:auditorium|gallery|hall|hotel|centre|center|PRP|SJT|LC|CDC|Channa)\s*\d*\b/i.test(venueText)) {
      entry = { ...base, kind: 'place', name: venueText.replace(/^[-\s]+/, '').replace(/\s*[-–]\s*(?:Report immediately|Batch\b|.*Shortlist\b).*$/i, '').replace(/\s+(?:only|on time|with your|for the interviews|at\s+\d|by\s+\d|if you)\b.*$/i,'').replace(/[.,]$/, '').slice(0, 90) };
    }
    // "Online test" describes the platform, not permission to attend remotely.
    // Explicit home/virtual attendance is required, and physical venues take priority.
    else if (/\b(?:virtual(?:ly)?|remote(?:ly)?|own locations?|home location|from\s+home|(?:held|conducted|attend)\s+online)\b/i.test(line)
      && !/\b(?:labs?|LC|PRP|SJT|CDC|Channa|in person|in-person|office|auditorium|gallery|campus)\b/i.test(audienceList ? line.slice(audienceList.prefix.length) : line)) entry = { ...base, kind: 'online', name: 'Online' };
    if (entry) {
      const roundLabel = datedVenue ? line.slice(0,line.indexOf(':')) : '';
      const stages = roundLabel ? [...new Set(roundLabel.split(/\s*(?:&|and|\+)\s*/i).map(stageIn).filter((stage): stage is string=>Boolean(stage)))] : [entry.stage];
      for (const stage of stages) entries.push(...(audiences.length>1 ? audiences.map(a=>({...entry!,stage,audience:a})) : [{...entry,stage}]));
    }
  }
  // A campus team's separate venue arrangements mean attendance at that campus,
  // even when its room number has not been announced yet.
  const localArrangements = lines.find(line=>/\bother\s+campus(?:es)?\b[^\n]{0,180}\b(?:venues?|campus team|CDC office)\b[^\n]{0,100}\b(?:inform|update|share|communicat|announc)/i.test(line)
    || /\bother\s+campus(?:es)?\b[^\n]{0,100}\bvenues?\b[^\n]{0,100}\b(?:informed|shared|updated)\b[^\n]{0,80}\b(?:campus|respective|team)\b/i.test(line)
    || /\bvenues?\s+for\s+(?:the\s+)?other\s+campus(?:es)?\b[^\n]{0,100}\b(?:informed|shared|updated)\b[^\n]{0,80}\b(?:campus|campuses|respective|team)\b/i.test(line)
    || /\bother\s+campus(?:es)?\b[^\n]{0,80}\b(?:report|attend)\b[^\n]{0,60}\brespective\s+campus\b/i.test(line)
    || /\bother\s+campus(?:es)?\b[^\n]{0,60}\bcheck\s+with\s+your\s+campus\b[^\n]{0,60}\bvenue\b/i.test(line));
  if (localArrangements) {
    const host = entries.map(venueCampus).find(Boolean);
    const stages = new Set(entries.filter(e=>venueCampus(e)===host).map(e=>e.stage));
    if (host) for (const campus of campuses.map(c=>`VIT ${c}`)) {
      if (campus !== host) for (const stage of stages) {
        if (!entries.some(e=>e.audience===campus && e.stage===stage)) entries.push({stage,kind:'respective',name:'Respective campus',audience:campus,quote:localArrangements.slice(0,220)});
      }
    }
  }
  // Conflicting instructions for one stage/audience stay unknown rather than guessing.
  const grouped = new Map<string, VenueEntry[]>();
  const routesCampus = (entry: VenueEntry) => entry.kind==='respective' || Boolean(entry.audience && entry.kind==='online');
  const wholeProcessRouting = entries.some(entry=>routesCampus(entry) && /\b(?:entire\s+(?:selection|further)\s+process|(?:the|this)\s+drive\s+will\s+be)\b/i.test(entry.quote));
  for (const original of entries) {
    // A circular that explicitly routes other campuses separately does not make
    // the headline campus venue a universal attendance instruction.
    const physicalCampus = venueCampus(original);
    // Campus routing for a test says nothing about where later interviews occur.
    const campusRouting = Boolean(localArrangements) || wholeProcessRouting
      || entries.some(entry=>routesCampus(entry) && (entry.stage===original.stage || original.stage==='Recruitment' && entry.audience));
    const entry = campusRouting && !original.audience && physicalCampus
      ? { ...original, audience: physicalCampus } : original;
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
    const unique = new Set(group.map(e => venueCampus(e) || `${e.kind}:${e.name}:${e.city || ''}`));
    return unique.size === 1 ? group[0] : { ...group[0], kind: 'unknown' as const, name: '' };
  }).slice(0, 12);
}

function applicableVenueEntries(value: unknown, userCampus?: string): VenueEntry[] {
  const projection = value as RecruitmentVenues | null;
  if (projection?.version !== 1 || !Array.isArray(projection.entries)) return [];
  const valid = projection.entries.filter(e => e && typeof e.stage === 'string' && typeof e.name === 'string');
  const applicable = valid.filter(e => {
    if (e.audience) return e.audience === userCampus;
    const campus = venueCampus(e);
    if (!campus || !userCampus || campus === userCampus) return true;
    // A bare "report immediately" reminder repeats the host-campus headline;
    // it does not revoke the earlier circular's campus-specific arrangements.
    const headlineOnly = !/\b(?:all|every)\s+(?:the\s+)?(?:shortlisted\s+)?(?:students|candidates|campus(?:es)?)\b/i.test(e.quote);
    if (!headlineOnly) return true;
    const hostScoped = valid.some(other=>other.stage===e.stage && other.audience===campus && venueCampus(other)===campus);
    const interviewException = e.stage==='Recruitment' && /next round of (?:the )?selection process/i.test(e.quote)
      && valid.some(other=>other.stage==='Interviews' && other.audience===userCampus && ['online','respective'].includes(other.kind));
    return !hostScoped && !interviewException;
  });
  // A later generic selection round can add a physical venue after an online PPT.
  const scopedStages = new Set(applicable.filter(e=>e.audience===userCampus && e.audience).map(e=>e.stage));
  return applicable.filter(e => e.audience || !scopedStages.has(e.stage));
}

export function resolveDriveVenue(value: unknown, userCampus?: string): DriveVenueDisplay {
  const entries = applicableVenueEntries(value, userCampus).filter(e => e.kind !== 'unknown');
  const locations = new Map<string, string[]>();
  const attendanceLocations = new Set<string>();
  const labLocations = new Set<string>();
  for (const entry of entries) {
    // This kind requires explicit remote attendance, not just an online test platform.
    // A generic virtual visit establishes the mode; it does not specify an own-location round.
    const label = entry.kind === 'online' ? /^Date\s+of\s+Visit\s*:/i.test(entry.quote) ? 'Online' : 'Own location' : entry.kind === 'office' ? `Company Office${entry.city ? ` · ${entry.city}` : ''}`
      : entry.kind === 'campus' || entry.kind === 'place' ? venueCampus(entry) || entry.name : entry.kind === 'respective' ? userCampus : undefined;
    if (!label) continue;
    if (entry.kind !== 'online') attendanceLocations.add(label);
    if (entry.kind === 'respective' || /\b(?:LC|L\d{3,4}|labs?|lab complex)\b/i.test(`${entry.name} ${entry.quote}`)) labLocations.add(label);
    const detail = `${entry.stage}: ${entry.kind === 'respective' && entry.name !== 'Respective campus' ? entry.name : entry.kind === 'respective' || entry.kind === 'online' ? label : entry.name}`;
    locations.set(label, [...(locations.get(label) || []), detail]);
  }
  if (!locations.size) return { label: 'To be announced' };
  // Show one actual destination, prioritizing required travel and later rounds.
  // The details retain every applicable round; never use an aggregate location label.
  const away = [...attendanceLocations].filter(label => userCampus && label !== userCampus);
  const candidates = new Set(away.length ? away : attendanceLocations.size ? attendanceLocations : locations.keys());
  const priority = (details: string[]) => Math.min(...details.map(detail =>
    /^Interviews:/.test(detail) ? 0 : /^Recruitment:/.test(detail) ? 1 : /^Test/.test(detail) ? 2 : /^Game/.test(detail) ? 3 : 4));
  const headline = [...candidates].sort((a, b) => priority(locations.get(a)!) - priority(locations.get(b)!) || a.localeCompare(b))[0];
  return { label: headline === 'VIT Bhopal' && userCampus === 'VIT Bhopal' && labLocations.has(headline) ? 'Bhopal LC' : headline, detail: [...new Set([...locations.values()].flat())].join('; ').slice(0, 220),
    ...(userCampus ? { requiresTravel: away.length > 0 } : {}) };
}

/** Read-only UI formatting. Keep canonical venues and notification text unchanged. */
export function resolveDriveMode(value: unknown, userCampus?: string): DriveModeDisplay {
  const display = resolveDriveVenue(value, userCampus);
  const entries = applicableVenueEntries(value, userCampus);
  const resolved = entries.map(entry => {
    const location = resolveDriveVenue({ version: 1, entries: [entry] }, userCampus);
    const campus = entry.kind === 'respective' ? userCampus : venueCampus(entry);
    // User-provided Bhopal room correction, display only. Preserve source text
    // and do not generalize this alias to other campuses or room numbers.
    const name = campus === 'VIT Bhopal' ? entry.name.replace(/\bL3103\b/gi, 'LC 103') : entry.name;
    const respectiveBhopalLab = campus === 'VIT Bhopal' && entry.kind === 'respective'
      && name === 'Respective campus' && /\blabs?\b/i.test(entry.quote);
    // The user's home-campus shorthand: omit the redundant Bhopal campus name
    // on cards, while retaining specific rooms and the source venue in details.
    const genericBhopalHome = userCampus === 'VIT Bhopal' && campus === userCampus
      && (name === campus || entry.kind === 'respective' && name === 'Respective campus');
    let mode: DriveMode = 'TBA';
    if (location.label !== 'To be announced') {
      if (entry.kind === 'online') mode = 'Own Location';
      else if (entry.kind === 'campus' || entry.kind === 'respective' || campus) {
        if (campus && userCampus) mode = campus === userCampus ? 'Home Campus' : 'Other Campus';
      } else if (entry.kind === 'office' || entry.kind === 'place') mode = 'External Venue';
    }
    // Keep room names and external addresses, rather than the shortened card destination.
    const venue = location.label === 'To be announced' ? 'TBA'
      : respectiveBhopalLab ? 'LC'
      : entry.kind === 'respective' ? name === 'Respective campus' ? userCampus! : `${userCampus} · ${name}`
      : entry.kind === 'online' ? /\bhome\s+locations?|\bfrom home\b/i.test(entry.quote) ? 'From home'
        : /\bown\s+locations?\b/i.test(entry.quote) ? 'Own location' : 'Virtual'
      : `${name}${entry.city && !name.toLowerCase().includes(entry.city.toLowerCase()) ? ` · ${entry.city}` : ''}`;
    const shortVenue = mode === 'Other Campus' ? campus
      : mode === 'Home Campus' ? genericBhopalHome ? 'LC' : entry.kind === 'respective' && name === 'Respective campus' ? campus : name
      : mode === 'External Venue' ? venue : undefined;
    return { destination: location.label, shortVenue, round: { stage: entry.stage, mode, venue, ...(location.requiresTravel !== undefined ? { requiresTravel: location.requiresTravel } : {}) } };
  });
  const rounds = [...new Map(resolved.map(({ round }) => [`${round.stage}:${round.mode}:${round.venue}`, round])).values()];
  const physical = resolved.filter(({ round }) => ['Home Campus', 'Other Campus', 'External Venue'].includes(round.mode));
  const primary = physical.find(item => item.destination === display.label) || physical[0];
  const label: DriveMode = primary ? primary.round.mode
    : rounds.length && rounds.every(round => round.mode === 'Own Location') ? 'Own Location' : 'TBA';
  return { label, rounds, ...(primary?.shortVenue ? { shortVenue: primary.shortVenue } : {}),
    ...(rounds.length ? { detail: rounds.map(round => `${round.stage}: ${round.mode} · ${round.venue}`).join('; ') } : {}),
    ...(display.requiresTravel !== undefined ? { requiresTravel: display.requiresTravel } : {}) };
}
