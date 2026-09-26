import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';
import { parseDateTime, extractVenue } from '@/lib/sync/events';
import { formatDateTime } from '@/lib/utils';
import { pushEventToGoogleCalendar } from '@/lib/calendar/google-sync';
import { GoogleGenAI } from '@google/genai';
import { getEffectiveStage, isInactiveStatus, isEliminatedStatus } from '@/lib/stages';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/chat
 * AI-Powered Placement Copilot & Command Processor
 * Uses Gemini for deep contextual understanding with deterministic tool execution.
 */
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { error: { message: 'Unauthorized', code: 'unauthorized' } },
      { status: 401 }
    );
  }

  const { message } = await request.json();
  if (!message || typeof message !== 'string') {
    return NextResponse.json(
      { error: { message: 'Message is required', code: 'bad_request' } },
      { status: 400 }
    );
  }

  const supabase = createAdminClient();
  const lowerMsg = message.toLowerCase().trim();

  // 1. Fetch comprehensive user context: profile, companies, applications, and events
  const [
    { data: userData },
    { data: companies },
    { data: applications },
    { data: events },
    { data: placementDrives },
  ] = await Promise.all([
    supabase
      .from('users')
      .select('id, name, email, neo_id, campus')
      .eq('id', session.userId)
      .single(),
    supabase
      .from('companies')
      .select('id, name, aliases'),
    supabase
      .from('applications')
      .select('id, placement_drive_id, status, role, ctc, stipend, location, manual_override, notes, applied_at, registration_deadline')
      .eq('user_id', session.userId),
    supabase
      .from('events')
      .select('id, placement_drive_id, event_type, title, start_time, end_time, venue, mode, gcal_event_id, manual_override')
      .eq('user_id', session.userId)
      .order('start_time', { ascending: true }),
    supabase
      .from('placement_drives')
      .select('id, company_id, drive_number, drive_name, role, category, ctc, stipend, location, registration_deadline'),
  ]);

  const companyList = companies || [];
  const driveMap = new Map((placementDrives || []).map((d) => [d.id, d]));
  const appMap = new Map((applications || []).map((a) => [a.placement_drive_id, a]));
  const companyNameMap = new Map(companyList.map((c) => [c.id, c.name]));
  const now = new Date();

  // Group events by placement_drive_id for quick timeline calculation
  const eventsByDrive = new Map<string, any[]>();
  for (const ev of events || []) {
    if (ev.placement_drive_id) {
      const list = eventsByDrive.get(ev.placement_drive_id) || [];
      list.push(ev);
      eventsByDrive.set(ev.placement_drive_id, list);
    }
  }

  // Build pipeline items with full effective stage derivation (matching UI tabs 1:1)
  const pipeline = companyList.flatMap((c) => {
    const companyDrives = (placementDrives || []).filter((d) => d.company_id === c.id);
    if (companyDrives.length === 0) {
      const rawStatus = 'not_applied';
      const eff = getEffectiveStage(rawStatus, null, [], null, false);
      const isInactive = isInactiveStatus(eff.effectiveStatus);
      return [{
        id: c.id,
        companyId: c.id,
        driveNumber: null,
        name: c.name,
        rawStatus,
        status: eff.effectiveStatus,
        displayStatus: 'Not Registered',
        stageLabel: eff.statusSubtitle,
        role: 'Campus Placement Drive',
        ctc: 'TBA',
        stipend: null,
        location: 'Not Specified',
        manual_override: false,
        notes: null,
        isActive: !isInactive,
        isEliminated: isEliminatedStatus(eff.effectiveStatus),
        isShortlisted: false,
      }];
    }
    return companyDrives.map((drive) => {
      const app = appMap.get(drive.id);
      const rawStatus = app?.status || 'not_applied';
      const driveEvents = eventsByDrive.get(drive.id) || [];
      const latestEvent = driveEvents.length > 0 ? driveEvents[driveEvents.length - 1] : null;
      const eff = getEffectiveStage(
        rawStatus,
        latestEvent,
        driveEvents,
        app?.notes,
        app?.manual_override
      );
      const regDeadline = app?.registration_deadline || drive.registration_deadline;
      const hasFutureDeadline = Boolean(regDeadline && new Date(regDeadline) > now);
      const isInactive = isInactiveStatus(eff.effectiveStatus);
      const isActive = !isInactive || (eff.effectiveStatus === 'not_applied' && hasFutureDeadline);
      const isEliminated = isEliminatedStatus(eff.effectiveStatus);
      const isShortlisted = [
        'shortlisted', 'test_scheduled', 'test_ongoing', 'test_completed',
        'interview_scheduled', 'interview_ongoing', 'interview_completed',
        'interview', 'test', 'selected', 'offer', 'offer_received',
        'rejected_test', 'rejected_interview', 'test_eliminated', 'interview_eliminated'
      ].includes(eff.effectiveStatus);

      let displayStatus = 'Applied';
      if (eff.effectiveStatus === 'ppt_scheduled') displayStatus = 'PPT Scheduled';
      else if (eff.effectiveStatus === 'ppt_completed') displayStatus = 'PPT Completed';
      else if (eff.effectiveStatus === 'ppt_ongoing') displayStatus = 'PPT Live Now';
      else if (eff.effectiveStatus === 'test_scheduled') displayStatus = 'Test Scheduled';
      else if (eff.effectiveStatus === 'test_completed') displayStatus = 'Test Completed';
      else if (eff.effectiveStatus === 'test_ongoing') displayStatus = 'Test Live Now';
      else if (eff.effectiveStatus === 'interview_scheduled') displayStatus = 'Interview Scheduled';
      else if (eff.effectiveStatus === 'interview_completed') displayStatus = 'Interview Completed';
      else if (eff.effectiveStatus === 'interview_ongoing') displayStatus = 'Interview Live Now';
      else if (['selected', 'offer', 'offer_received'].includes(eff.effectiveStatus)) displayStatus = 'Selected / Offer';
      else if (eff.effectiveStatus === 'not_shortlisted') displayStatus = 'Not Shortlisted';
      else if (eff.effectiveStatus === 'rejected_test' || eff.effectiveStatus === 'test_eliminated') displayStatus = 'Eliminated (Test)';
      else if (eff.effectiveStatus === 'rejected_interview' || eff.effectiveStatus === 'interview_eliminated') displayStatus = 'Eliminated (Interview)';
      else if (isEliminated) displayStatus = 'Eliminated';
      else if (['withdrawn', 'declined'].includes(eff.effectiveStatus)) displayStatus = 'Withdrawn';
      else if (eff.effectiveStatus === 'not_applied') displayStatus = 'Not Applied';

      return {
        id: drive.id,
        companyId: c.id,
        driveNumber: drive.drive_number || null,
        name: drive.drive_number ? `${c.name} — ${drive.drive_number}` : c.name,
        rawStatus,
        status: eff.effectiveStatus,
        displayStatus,
        stageLabel: eff.statusSubtitle,
        role: app?.role || drive.role || 'Campus Placement Drive',
        ctc: app?.ctc || drive.ctc || 'TBA',
        stipend: app?.stipend || drive.stipend || null,
        location: app?.location || drive.location || 'Not Specified',
        manual_override: app?.manual_override || false,
        notes: app?.notes || null,
        isActive,
        isEliminated,
        isShortlisted,
      };
    });
  });

  const getEventCompanyName = (placementDriveId: string | null) => {
    if (!placementDriveId) return 'Unknown Company';
    const drive = driveMap.get(placementDriveId);
    const compId = drive?.company_id || placementDriveId;
    const name = companyNameMap.get(compId) || 'Unknown Company';
    return drive?.drive_number ? `${name} — ${drive.drive_number}` : name;
  };

  // Upcoming vs past events
  const allEvents = events || [];
  const upcomingEvents = allEvents
    .filter((e) => e.start_time && new Date(e.start_time) >= now)
    .map((e) => ({
      id: e.id,
      companyId: e.placement_drive_id,
      company: getEventCompanyName(e.placement_drive_id),
      title: e.title || e.event_type,
      type: e.event_type,
      startTime: e.start_time,
      endTime: e.end_time,
      venue: e.venue || 'Campus / Online',
      mode: e.mode || 'online',
    }));

  const pastEvents = allEvents
    .filter((e) => e.start_time && new Date(e.start_time) < now)
    .slice(-15)
    .map((e) => ({
      id: e.id,
      company: getEventCompanyName(e.placement_drive_id),
      title: e.title || e.event_type,
      type: e.event_type,
      startTime: e.start_time,
      venue: e.venue || 'Campus / Online',
    }));

  const studentName = userData?.name || session.name || 'Student';

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. PRIMARY ENGINE: Gemini via @google/genai
  // ═══════════════════════════════════════════════════════════════════════════
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    try {
      const ai = new GoogleGenAI({ apiKey });

      const activePipeline = pipeline.filter((p) => p.isActive);
      const shortlisted = pipeline.filter((p) => p.isShortlisted);
      const scheduledCount = upcomingEvents.length;
      const offers = pipeline.filter((p) => ['selected', 'offer', 'offer_received'].includes(p.status));
      const notShortlisted = pipeline.filter((p) => p.status === 'not_shortlisted');
      const testOrInterviewEliminated = pipeline.filter((p) => p.isEliminated && p.status !== 'not_shortlisted');
      const withdrawn = pipeline.filter((p) => ['withdrawn', 'declined'].includes(p.status));
      const notApplied = pipeline.filter((p) => p.status === 'not_applied' && !p.isActive);

      const pipelineSummary = {
        totalDrives: pipeline.length,
        activePipeline: activePipeline.length,
        shortlisted: shortlisted.length,
        upcomingScheduled: scheduledCount,
        offers: offers.length,
        inactiveBreakdown: {
          notShortlistedScreenedOut: notShortlisted.length,
          eliminatedInTestsOrInterviews: testOrInterviewEliminated.length,
          withdrawnOrOptedOut: withdrawn.length,
          notRegistered: notApplied.length,
        },
      };

      const contextData = {
        student: {
          name: studentName,
          email: userData?.email || session.email,
          neoId: userData?.neo_id || 'Not set',
          homeCampus: userData?.campus || 'VIT Bhopal',
        },
        pipelineSummary,
        upcomingEvents,
        recentPastEvents: pastEvents,
        activeDrives: activePipeline,
        allCompanies: pipeline,
      };

      const systemPrompt = `You are the Placement Assistant for "Where's My Offer?" — an expert, concise campus placement copilot for engineering students.
Today's local date is ${now.toISOString().split('T')[0]}. The current time is ${now.toISOString()}.
You have complete, live, real-time access to this student's placement pipeline, company drives, test dates, venues, CTCs, and events.

STUDENT PLACEMENT CONTEXT:
${JSON.stringify(contextData)}

PIPELINE STATUS DEFINITIONS & ARCHITECTURE:
- Total Drives (${pipelineSummary.totalDrives}): All recruitment drives indexed on the platform.
- Active Pipeline: Exactly ${pipelineSummary.activePipeline} drives actively in progress across recruitment rounds (applied awaiting OA, PPT scheduled/completed, test scheduled/completed awaiting results, interview scheduled/completed, offers).
- Shortlisted (${pipelineSummary.shortlisted}): Drives where the student cracked screening and qualified for assessments or interviews.
- Upcoming Scheduled (${pipelineSummary.upcomingScheduled}): Drives with confirmed future events (tests, interviews, PPTs, or open deadlines).
- Inactive / Archived Drives (${pipelineSummary.totalDrives - pipelineSummary.activePipeline}):
  • Not Shortlisted / Screened Out (${pipelineSummary.inactiveBreakdown.notShortlistedScreenedOut}): Candidate applied but was screened out before tests.
  • Eliminated in Tests / Interviews (${pipelineSummary.inactiveBreakdown.eliminatedInTestsOrInterviews}): Candidate wrote assessment or interviewed but was not selected.
  • Withdrawn / Opted Out (${pipelineSummary.inactiveBreakdown.withdrawnOrOptedOut}): Candidate withdrew registration on NeoPAT.
  • Not Registered (${pipelineSummary.inactiveBreakdown.notRegistered}): Candidate did not register and deadline is closed.

INSTRUCTIONS & BEHAVIOR:
1. When the student asks about active pipeline ("What are my active pipeline drives?", "what is my pipeline?", "what drives are active?"):
   - Explicitly confirm that they have ${pipelineSummary.activePipeline} active drives in their recruitment pipeline.
   - List the active drives from 'activeDrives'. Each drive has its exact current stage (e.g. Applied, PPT Scheduled, PPT Completed, Test Completed).
   - DO NOT claim there are 46 applied drives or "39 other applied drives awaiting notifications"! The student has exactly ${pipelineSummary.activePipeline} active drives. The remaining ${pipelineSummary.totalDrives - pipelineSummary.activePipeline} drives are inactive/archived (not shortlisted, eliminated in tests, or withdrawn).
2. Format for maximum UI clarity and scannability:
   - For overview summaries, format the key metrics as:
     - Total Drives: <count>
     - Active Pipeline: <count>
     - Shortlisted: <count>
     - Upcoming Scheduled: <count>
     - Offers: <count>
   - When listing companies:
     - Format each drive clearly: **Company Name** (pat-PL-2026-xxxx) — Status (Role | Package | Location)
       where Status is one of: Applied, PPT Scheduled, PPT Completed, Shortlisted for Test, Test Scheduled, Test Completed, Interview Scheduled, Selected / Offer
     - If an event/deadline is scheduled, place on the next line:
       Upcoming: Pre-Placement Talk on ... or Online Test on ...
   - Do NOT produce trailing asterisks or broken markdown (never output 'Applied*' or '12:00 PM*').
3. When the student asks about events (e.g. "upcoming ppts?", "what are my upcoming tests?", "when is my next interview?"):
   - Inspect the 'upcomingEvents' list carefully by 'type' ('ppt', 'online_test', 'coding_test', 'technical_interview', etc.).
   - If upcoming events exist, list them clearly with company name, title, date/time formatted nicely, and venue (Online / Campus / Labs).
   - If NO upcoming events exist for that category, state that clearly and mention recent past events if relevant (e.g. "No upcoming PPTs scheduled. Your last PPT was ExxonMobil on Sept 17").
4. When the student gives a command to update status (e.g. "I gave Infosys test yesterday, didn't make interview shortlist", "mark Cognizant as applied", "rejected in interview for Amazon", "got offer from TCS", "opted out of Wipro"):
   - Identify the target company from 'companies'.
   - Decide the correct normalized status:
     - 'applied'
     - 'ppt_scheduled'
     - 'shortlisted' (shortlisted for OA test)
     - 'test_scheduled'
     - 'test_completed' (wrote test, waiting for results)
     - 'interview_scheduled'
     - 'selected' (offer won 🎉)
     - 'not_shortlisted' (screened out before test)
     - 'rejected' (eliminated in test or interview)
     - 'declined' (opted out by choice)
     - 'withdrawn'
   - Include the "action" block in your JSON output.
5. When the student asks to schedule or add an event (e.g. "Add Accenture interview tomorrow at 3pm at TT Lab 3"):
   - Include the "action" block of type "add_event" or "update_event" with start_time in ISO format.
6. When the student asks to sync with Google Calendar (e.g. "sync google calendar", "push events to calendar"):
   - Include the "action" block of type "sync_gcal".

OUTPUT SCHEMA:
Return ONLY valid JSON with this exact structure:
{
  "reply": "Your markdown response to the student",
  "action": null | {
    "type": "update_status" | "add_event" | "update_event" | "sync_gcal",
     "company_name"?: string,
     "placement_drive_id"?: string,
    "status"?: string,
    "event_type"?: string,
    "title"?: string,
    "start_time"?: string,
    "venue"?: string,
    "mode"?: "online" | "offline",
    "notes"?: string
  }
}`;

      // Call Gemini (try gemini-flash-lite-latest, fallback to gemini-flash-latest)
      const modelCandidates = ['gemini-flash-lite-latest', 'gemini-flash-latest', 'gemini-2.5-flash'];
      let rawText = '';

      for (const modelName of modelCandidates) {
        try {
          const res = await ai.models.generateContent({
            model: modelName,
            contents: message,
            config: {
              systemInstruction: systemPrompt,
              responseMimeType: 'application/json',
              temperature: 0.15,
            },
          });
          if (res.text) {
            rawText = res.text;
            break;
          }
        } catch (modelErr: any) {
          console.warn(`[chat/route] ${modelName} call error:`, modelErr?.message || modelErr);
        }
      }

      if (rawText) {
        try {
          const parsed = JSON.parse(rawText);
          let executedAction: string | undefined = undefined;
          let affectedCompanyId: string | undefined = undefined;
          let affectedStatus: string | undefined = undefined;

          // Execute action if Gemini identified one
          if (parsed.action) {
            const action = parsed.action;

            if (action.type === 'update_status' && action.company_name && action.status) {
              const targetComp = companyList.find(
                (c) =>
                  c.name.toLowerCase() === action.company_name.toLowerCase() ||
                  c.name.toLowerCase().includes(action.company_name.toLowerCase()) ||
                  (c.aliases && c.aliases.some((a: string) => a.toLowerCase().includes(action.company_name.toLowerCase())))
              );

              if (targetComp) {
                const requestedDriveId = action.placement_drive_id || null;
                const companyDrives = (placementDrives || []).filter((d) => (d as any).company_id === targetComp.id);
                const targetDrive = requestedDriveId
                  ? companyDrives.find((d) => d.id === requestedDriveId)
                  : (companyDrives.length === 1 ? companyDrives[0] : null);

                if (companyDrives.length > 1 && !targetDrive) {
                  parsed.reply = `${targetComp.name} has multiple placement drives. Please specify the drive number before changing status.`;
                  parsed.action = null;
                  return NextResponse.json({ data: parsed, error: null });
                }

                if (!targetDrive) {
                  parsed.reply = `No placement drive found for ${targetComp.name}.`;
                  parsed.action = null;
                  return NextResponse.json({ data: parsed, error: null });
                }

                let normStatus = action.status;
                let normNotes = action.notes;
                if (action.status === 'rejected_test' || action.status === 'test_eliminated') {
                  normStatus = 'rejected';
                  normNotes = normNotes || 'Eliminated in Test Round';
                } else if (action.status === 'rejected_interview' || action.status === 'interview_eliminated') {
                  normStatus = 'rejected';
                  normNotes = normNotes || 'Interviewed · Not Selected';
                } else if (action.status === 'not_shortlisted') {
                  normStatus = 'not_shortlisted';
                  normNotes = normNotes || 'Not Shortlisted for Test';
                }

                const appPayload = {
                  user_id: session.userId,
                  placement_drive_id: targetDrive.id,
                  status: normStatus,
                  status_source: 'ai_assistant_chat',
                  status_confidence: 'manual',
                  manual_override: true,
                  notes: normNotes || undefined,
                  last_updated: new Date().toISOString(),
                };
                const { data: existingApp } = await supabase
                  .from('applications')
                  .select('id')
                  .eq('user_id', session.userId)
                  .eq('placement_drive_id', targetDrive.id)
                  .maybeSingle();

                if (existingApp?.id) {
                  await supabase.from('applications').update(appPayload).eq('id', existingApp.id);
                } else {
                  await supabase.from('applications').insert(appPayload);
                }
                executedAction = 'status_updated';
                affectedCompanyId = targetComp.id;
                affectedStatus = normStatus;
              }
            } else if ((action.type === 'add_event' || action.type === 'update_event') && action.company_name) {
              const targetComp = companyList.find(
                (c) =>
                  c.name.toLowerCase() === action.company_name.toLowerCase() ||
                  c.name.toLowerCase().includes(action.company_name.toLowerCase())
              );

              if (targetComp && action.start_time) {
                const requestedDriveId = action.placement_drive_id || null;
                const companyDrives = (placementDrives || []).filter((d) => (d as any).company_id === targetComp.id);
                const targetDrive = requestedDriveId
                  ? companyDrives.find((d) => d.id === requestedDriveId)
                  : (companyDrives.length === 1 ? companyDrives[0] : null);

                if (companyDrives.length > 1 && !targetDrive) {
                  parsed.reply = `${targetComp.name} has multiple placement drives. Please specify the drive number before adding an event.`;
                  parsed.action = null;
                  return NextResponse.json({ data: parsed, error: null });
                }

                if (!targetDrive) {
                  parsed.reply = `No placement drive found for ${targetComp.name}.`;
                  parsed.action = null;
                  return NextResponse.json({ data: parsed, error: null });
                }

                const targetApplication = (applications || []).find((a) =>
                  a.placement_drive_id === targetDrive.id
                );
                const eventType = action.event_type || 'online_test';
                const venue = action.venue || 'Campus / Online';
                const mode = action.mode || (/offline|lab|campus|hall/i.test(venue) ? 'offline' : 'online');
                const title = action.title || `${targetComp.name} - ${eventType.replace(/_/g, ' ').toUpperCase()}`;
                const startTime = new Date(action.start_time).toISOString();
                const endTime = new Date(new Date(startTime).getTime() + 3600000).toISOString();

                const { data: insertedEvt } = await supabase.from('events').insert({
                  user_id: session.userId,
                  placement_drive_id: targetDrive.id,
                  event_type: eventType,
                  title,
                  start_time: startTime,
                  end_time: endTime,
                  venue,
                  mode,
                  confidence: 'high',
                  manual_override: true,
                }).select().single();

                if (insertedEvt) {
                  pushEventToGoogleCalendar({
                    userId: session.userId,
                    title,
                    startTime,
                    endTime,
                    venue,
                    mode,
                    eventId: insertedEvt.id,
                    placementDriveId: targetDrive?.id || null,
                    applicationId: targetApplication?.id || null,
                  }).catch((gErr) => console.warn('[chat/route] GCal sync error:', gErr));
                }

                executedAction = 'event_added';
                affectedCompanyId = targetComp.id;
              }
            } else if (action.type === 'sync_gcal') {
              executedAction = 'gcal_synced';
              for (const evt of upcomingEvents) {
                pushEventToGoogleCalendar({
                  userId: session.userId,
                  title: evt.title,
                  startTime: evt.startTime!,
                  endTime: evt.endTime,
                  venue: evt.venue,
                  mode: evt.mode,
                }).catch((gErr) => console.warn('[chat/route] GCal sync error:', gErr));
              }
            }
          }

          return NextResponse.json({
            reply: parsed.reply,
            action: executedAction,
            companyId: affectedCompanyId,
            status: affectedStatus,
          });
        } catch (parseErr) {
          console.warn('[chat/route] Failed to parse Gemini response as JSON:', rawText);
        }
      }
    } catch (aiErr: any) {
      console.error('[chat/route] Gemini processing failed, using fallback:', aiErr?.message || aiErr);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. DETERMINISTIC FALLBACK (If AI Key is missing or rate limited)
  // ═══════════════════════════════════════════════════════════════════════════

  // Upcoming PPTs
  if (/ppt|pre[\s-]*placement/i.test(lowerMsg)) {
    const upcomingPpts = upcomingEvents.filter((e) => /ppt/i.test(e.type || e.title));
    if (upcomingPpts.length > 0) {
      const list = upcomingPpts.map(
        (p) => `• **${p.company}** — *${formatDateTime(p.startTime!)}* (${p.venue})`
      );
      return NextResponse.json({
        reply: `📢 **Upcoming Pre-Placement Talks (PPTs):**\n\n${list.join('\n')}`,
      });
    }
    const pastPpts = pastEvents.filter((e) => /ppt/i.test(e.type || e.title));
    const pastNote = pastPpts.length > 0
      ? `\n\nYour past PPTs include: **${pastPpts.map((p) => p.company).join(', ')}**.`
      : '';
    return NextResponse.json({
      reply: `You don't have any upcoming Pre-Placement Talks (PPTs) scheduled right now.${pastNote}`,
    });
  }

  // Upcoming Tests
  if (/test|assessment|exam|coding|oa/i.test(lowerMsg) && /upcoming|next|when|schedule/i.test(lowerMsg)) {
    const upcomingTests = upcomingEvents.filter((e) =>
      /test|assessment|coding|exam/i.test(e.type || e.title)
    );
    if (upcomingTests.length > 0) {
      const list = upcomingTests.map(
        (t) => `• **${t.company}** — *${formatDateTime(t.startTime!)}* (${t.venue})`
      );
      return NextResponse.json({
        reply: `⏰ **Upcoming Online Assessments & Tests (${upcomingTests.length}):**\n\n${list.join('\n')}`,
      });
    }
    return NextResponse.json({
      reply: "You don't have any upcoming tests scheduled right now. All caught up! 🎯",
    });
  }

  // Upcoming Interviews
  if (/interview/i.test(lowerMsg) && /upcoming|next|when|schedule/i.test(lowerMsg)) {
    const upcomingInts = upcomingEvents.filter((e) => /interview/i.test(e.type || e.title));
    if (upcomingInts.length > 0) {
      const list = upcomingInts.map(
        (t) => `• **${t.company}** — *${formatDateTime(t.startTime!)}* (${t.venue})`
      );
      return NextResponse.json({
        reply: `🤝 **Upcoming Interviews (${upcomingInts.length}):**\n\n${list.join('\n')}`,
      });
    }
    return NextResponse.json({
      reply: "You don't have any interviews scheduled right now. Check back once test shortlists are released!",
    });
  }

  // General Upcoming Schedule
  if (/upcoming|next|schedule/i.test(lowerMsg)) {
    if (upcomingEvents.length > 0) {
      const list = upcomingEvents.map(
        (e) => `• **${e.company}** (${e.title}) — *${formatDateTime(e.startTime!)}* (${e.venue})`
      );
      return NextResponse.json({
        reply: `🗓️ **Your Upcoming Placement Schedule (${upcomingEvents.length}):**\n\n${list.join('\n')}`,
      });
    }
    return NextResponse.json({
      reply: "You don't have any upcoming rounds scheduled right now. Check back as new CDC circulars land!",
    });
  }

  // Active Pipeline
  if (/active|pipeline/i.test(lowerMsg)) {
    const active = pipeline.filter((p) => p.isActive);
    if (active.length > 0) {
      const list = active.map((a) => `• **${a.name}** — ${a.displayStatus} (${a.role} | ${a.ctc})`);
      return NextResponse.json({
        reply: `🎯 **Your Active Pipeline (${active.length} drives):**\n\n${list.join('\n')}`,
      });
    }
    return NextResponse.json({
      reply: "You don't have any active drives in your pipeline right now.",
    });
  }

  // Shortlisted Companies
  if (/shortlist/i.test(lowerMsg)) {
    const shortlisted = pipeline.filter((p) => p.isShortlisted);
    if (shortlisted.length > 0) {
      const list = shortlisted.map((s) => `• **${s.name}** (${s.role}) — ${s.ctc}`);
      return NextResponse.json({
        reply: `✨ You are currently shortlisted for **${shortlisted.length}** companies:\n\n${list.join('\n')}`,
      });
    }
    return NextResponse.json({
      reply: "You don't have any active test/interview shortlists right now.",
    });
  }

  // Default fallback response
  return NextResponse.json({
    reply: `Hi ${studentName}! I'm your Placement Copilot. You can ask me:\n• *"What are my active pipeline drives?"*\n• *"What are my upcoming tests?"*\n• *"Upcoming PPTs?"*\n• *"What is the CTC for Infosys?"*\n• *"Mark Cognizant as applied"*\n• *"I gave Infosys test yesterday, didn't make shortlist"*\n• *"Sync with Google Calendar"*`,
  });
}
