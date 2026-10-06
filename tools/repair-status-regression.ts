import fs from 'node:fs';
import pg from 'pg';
import { recalculateApplicationStatuses } from '@/lib/sync/reprocess';
import { createAdminClient } from '@/lib/supabase/admin';
import { loadUserCandidateIdentity,getStrongIdentityTokens } from '@/lib/sync/user-identity';
import { inlineShortlistRoster } from '@/lib/sync/placement-evidence';
import { evaluateCachedShortlistRosters } from '@/lib/sync/shortlist-verification';
import { getEvidenceMessageText } from '@/lib/sync/body';

const apply=process.argv.includes('--apply');
const projectRef=new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split('.')[0];
const db=new pg.Client({host:process.env.DB_POOLER_HOST || 'aws-0-ap-southeast-1.pooler.supabase.com',port:5432,user:'postgres.'+projectRef,password:process.env.db_pass,database:'postgres',ssl:{rejectUnauthorized:false}});
await db.connect();
try {
  const requested=process.argv.find(value=>/^--user=/.test(value))?.slice(7);
  const excluded=process.argv.find(value=>/^--except=/.test(value))?.slice(9);
  const requestedDrives=process.argv.filter(value=>/^--drive=/.test(value)).map(value=>value.slice(8));
  const users=(await db.query(`select distinct u.id,u.name from users u join applications a on a.user_id=u.id where ($1::uuid is null or u.id=$1::uuid) and ($2::uuid[] is null or a.placement_drive_id=any($2::uuid[])) order by u.name`,[requested||null,requestedDrives.length?requestedDrives:null])).rows;
  for(const user of users) {
    if(user.id===excluded)continue;
    let targeted:string[]|undefined;
    if(process.argv.includes('--inline-only')) {
      const tokens=getStrongIdentityTokens(await loadUserCandidateIdentity(createAdminClient(),user.id));
      const evidence=(await db.query(`select v.placement_drive_id,scan->>'state' state,e.subject,e.body_text from round_verdicts v cross join lateral jsonb_array_elements(v.verdict->'evaluations') scan join college_emails e on e.id::text=scan->>'emailId' where v.user_id=$1 and v.is_current`,[user.id])).rows;
      targeted=[...new Set<string>(evidence.filter(e=>{
        const body=getEvidenceMessageText({subject:e.subject,bodyPlain:e.body_text,bodySnippet:'',bodyHtml:''});
        const roster=inlineShortlistRoster(e.subject,body);
        return roster && evaluateCachedShortlistRosters({rosters:[roster],shortlistContext:true,identityTokens:tokens}).state!==e.state;
      }).map(e=>e.placement_drive_id))];
      if(!targeted.length) {console.log(JSON.stringify({user:user.name,inlineChanges:0}));continue;}
    }
    const snapshot:Record<string,unknown>={user};
    for(const table of ['applications','events','candidate_matches','round_verdicts','notifications']) snapshot[table]=(await db.query(`select * from public.${table} where user_id=$1`,[user.id])).rows;
    fs.mkdirSync('backups',{recursive:true});
    const file=`backups/status-regression-${user.id}-${Date.now()}.json`;
    fs.writeFileSync(file,JSON.stringify(snapshot,null,2));
    console.log(JSON.stringify({user:user.name,applications:(snapshot.applications as unknown[]).length,mode:apply?'repair':'snapshot',file}));
    if(!apply)continue;
    const ids=targeted || (snapshot.applications as Array<{placement_drive_id:string}>).map(a=>a.placement_drive_id).filter(id=>!requestedDrives.length || requestedDrives.includes(id));
    const repairIds = process.argv.includes('--negative-only')
      ? ids.filter(id => (snapshot.applications as Array<{placement_drive_id:string;status:string;manual_override:boolean}>).some(app => app.placement_drive_id === id && !app.manual_override && ['not_shortlisted','not_shortlisted_post_ppt','rejected','rejected_test','rejected_interview'].includes(app.status))) : ids;
    if (!repairIds.length) continue;
    const result=await recalculateApplicationStatuses(user.id,undefined,{targetPlacementDriveIds:repairIds,recalculateStatusesFromRemainingEvidence:true,suppressNotifications:true,skipBodyRecovery:true,skipGSheetScan:true});
    const after=(await db.query('select placement_drive_id,status from applications where user_id=$1',[user.id])).rows;
    const before=new Map((snapshot.applications as Array<{placement_drive_id:string;status:string}>).map(a=>[a.placement_drive_id,a.status]));
    const changes=after.filter(a=>before.get(a.placement_drive_id)!==a.status).map(a=>({drive:a.placement_drive_id,before:before.get(a.placement_drive_id),after:a.status}));
    console.log(JSON.stringify({user:user.name,updated:result.updatedCount,changes}));
  }
} finally {await db.end();}
