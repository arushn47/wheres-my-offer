import { expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { writeFile } from 'node:fs/promises';
import type { createAdminClient } from '@/lib/supabase/admin';
import { readDriveActivity, readRoundStatusRows, readRecentCollegeSearchRows } from './dashboard-readers';
import { summarizeRoundDecisions } from './recruitment/round-status';
import { getRoundStatusDisplay } from './recruitment/status-display';

it.skipIf(process.env.WMO_READONLY_REHEARSAL !== 'true')('compact page reads preserve every restored user outcome and activity date', async () => {
  const url = process.env.RESTORE_SUPABASE_URL!;
  if (process.env.RESTORE_PROJECT_REF !== 'nvkxyeugonjevmbvxirm' || new URL(url).hostname !== 'nvkxyeugonjevmbvxirm.supabase.co') throw Error('Mumbai rehearsal only');
  let bytes = 0;
  const admin = createClient(url, process.env.RESTORE_SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input, init) => {
      const target = new URL(String(input)), method = init?.method || 'GET';
      if (target.origin !== new URL(url).origin || !(method === 'GET' || method === 'HEAD' || method === 'POST' &&
          ['/rest/v1/rpc/get_user_round_status_rows','/rest/v1/rpc/get_user_drive_activity','/rest/v1/rpc/get_recent_college_search_rows'].includes(target.pathname))) throw Error(`Read-only rehearsal blocked ${method} ${target.pathname}`);
      const response = await fetch(input, init);
      bytes += Buffer.byteLength(await response.clone().text());
      return response;
    } },
  }) as ReturnType<typeof createAdminClient>;
  const { data: users, error } = await admin.from('users').select('id');
  if (error) throw error;
  let baselineBytes = 0, compactBytes = 0, verdictRows = 0, applicationComparisons = 0;
  const normalizeActivity = (rows: Awaited<ReturnType<typeof readDriveActivity>>) => {
    const dates = new Map<string,string>();
    for (const row of rows) if (row.placement_drive_id && row.received_at) {
      const date = new Date(row.received_at).toISOString(), previous = dates.get(row.placement_drive_id);
      if (!previous || date > previous) dates.set(row.placement_drive_id,date);
    }
    return [...dates].sort();
  };
  const byDrive = (rows: Awaited<ReturnType<typeof readRoundStatusRows>>, id: string) => rows.filter(row=>row.placement_drive_id===id);
  try {
    for (const user of users || []) {
      vi.stubEnv('COMPACT_DASHBOARD_READS_ENABLED','false'); bytes = 0;
      const legacy = await readRoundStatusRows(admin,user.id);
      const oldActivity = await readDriveActivity(admin,user.id); baselineBytes += bytes;
      vi.stubEnv('COMPACT_DASHBOARD_READS_ENABLED','true'); bytes = 0;
      const compact = await readRoundStatusRows(admin,user.id);
      const activity = await readDriveActivity(admin,user.id); compactBytes += bytes;
      expect(normalizeActivity(activity)).toEqual(normalizeActivity(oldActivity));
      expect(compact).toHaveLength(legacy.length); verdictRows += compact.length;
      const { data: apps, error: appError } = await admin.from('applications').select('placement_drive_id,status,manual_override,notes').eq('user_id',user.id);
      if (appError) throw appError;
      for (const app of apps || []) {
        const oldSummary = summarizeRoundDecisions(byDrive(legacy,app.placement_drive_id));
        const newSummary = summarizeRoundDecisions(byDrive(compact,app.placement_drive_id));
        const sorted = (rows: typeof oldSummary) => [...rows].sort((a,b)=>a.roundKey.localeCompare(b.roundKey));
        expect(sorted(newSummary)).toEqual(sorted(oldSummary));
        expect(getRoundStatusDisplay(app.status,newSummary,Boolean(app.manual_override),app.notes || ''))
          .toEqual(getRoundStatusDisplay(app.status,oldSummary,Boolean(app.manual_override),app.notes || ''));
        applicationComparisons++;
      }
      const detail = await readRoundStatusRows(admin,user.id,undefined,true);
      const states = (rows: typeof detail) => rows.flatMap(row=>(row.verdict.evaluations || []).map(scan=>`${row.placement_drive_id}|${row.verdict.roundKey}|${scan.emailId}|${scan.state}`)).sort();
      expect(states(detail)).toEqual(states(legacy));
      const chosen = compact[0]?.placement_drive_id;
      if (chosen) expect((await readRoundStatusRows(admin,user.id,[chosen],true)).every(row=>row.placement_drive_id===chosen)).toBe(true);
      expect(compact.every(row=>!('evaluations' in row.verdict) && !('rosterKey' in row.verdict))).toBe(true);
    }
    const anon = createClient(url,process.env.RESTORE_SUPABASE_ANON_KEY!,{auth:{persistSession:false,autoRefreshToken:false}});
    for (const name of ['get_user_round_status_rows','get_user_drive_activity']) {
      const response = await anon.rpc(name,{p_user_id:users![0].id});
      expect(response.error).not.toBeNull(); expect(response.data).toBeNull();
    }
    expect(compactBytes).toBeLessThan(baselineBytes);
    vi.stubEnv('COMPACT_DASHBOARD_READS_ENABLED','false'); bytes=0;
    const originalSearch=await readRecentCollegeSearchRows(admin), searchBaselineBytes=bytes;
    vi.stubEnv('COMPACT_DASHBOARD_READS_ENABLED','true'); bytes=0;
    const compactSearch=await readRecentCollegeSearchRows(admin), searchCompactBytes=bytes;
    const snippetRows = (rows: Array<{id:string;body_text:string|null}>) => rows.map(row=>({...row,body_text:row.body_text ? row.body_text.slice(0,500) : null}));
    expect(snippetRows(compactSearch)).toEqual(snippetRows(originalSearch));
    expect(searchCompactBytes).toBeLessThan(searchBaselineBytes);
    const report = {projectRef:process.env.RESTORE_PROJECT_REF,users:users?.length,verdictRows,applicationComparisons,
      baselineBytes,compactBytes,reductionPercent:Math.round(100*(1-compactBytes/baselineBytes)),searchBaselineBytes,searchCompactBytes,
      searchReductionPercent:Math.round(100*(1-searchCompactBytes/searchBaselineBytes)),readOnly:true,productionChanged:false};
    await writeFile('backups/dashboard-read-rehearsal.json',JSON.stringify(report,null,2));
    console.info(JSON.stringify(report));
  } finally { vi.unstubAllEnvs(); }
},180000);
