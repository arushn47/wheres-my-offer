import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin';
import { createAdminClient } from '@/lib/supabase/admin';
import { performReprocess } from '@/app/api/sync/reprocess/route';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // Allow sufficient time for multi-user reprocess

export async function POST(req: NextRequest) {
  try {
    await requireAdmin();
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Unauthorized' },
      { status: err.status || 401 }
    );
  }

  const supabase = createAdminClient();
  const isStream =
    req.headers.get('accept')?.includes('text/event-stream') ||
    req.nextUrl.searchParams.get('stream') === 'true';

  try {
    const [{ data: users, error: usersErr }, { data: connectedAccounts }] = await Promise.all([
      supabase
        .from('users')
        .select('id, email, name, role')
        .order('created_at', { ascending: false }),
      supabase
        .from('gmail_accounts')
        .select('user_id')
        .eq('is_connected', true),
    ]);

    if (usersErr || !users) {
      return NextResponse.json({ error: usersErr?.message || 'Failed to fetch users' }, { status: 500 });
    }

    const connectedUserIds = new Set((connectedAccounts || []).map((a) => a.user_id));
    // Include all non-admin users, plus admin accounts if they actually have connected inboxes
    const usersToProcess = users.filter((u) => u.role !== 'admin' || connectedUserIds.has(u.id));

    if (isStream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const sendEvent = (event: string, data: any) => {
            try {
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            } catch {
              // Client disconnected
            }
          };

          const interval = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(`: keep-alive\n\n`));
            } catch {
              clearInterval(interval);
            }
          }, 2000);

          try {
            sendEvent('start', {
              message: `Starting global placement reprocess across ${usersToProcess.length} student accounts…`,
              totalUsers: usersToProcess.length,
            });

            const summary: Array<{
              userId: string;
              email: string;
              userName: string;
              updatedApplications: number;
              neoPatDrivesCount: number;
              collegeCircularsLinked: number;
              error?: string;
            }> = [];

            let totalUpdated = 0;

            for (let i = 0; i < usersToProcess.length; i++) {
              const u = usersToProcess[i];
              const displayName = u.name || u.email.split('@')[0];

              sendEvent('user_start', {
                userIndex: i + 1,
                totalUsers: usersToProcess.length,
                userId: u.id,
                userName: displayName,
                userEmail: u.email,
                message: `Reprocessing ${displayName} (${i + 1} of ${usersToProcess.length})…`,
              });

              try {
                const result = await performReprocess(u.id, (p) => {
                  sendEvent('stage', {
                    userIndex: i + 1,
                    totalUsers: usersToProcess.length,
                    userId: u.id,
                    userName: displayName,
                    step: p.step,
                    totalSteps: p.totalSteps,
                    message: p.message,
                  });
                });

                const appsUpdated = result?.updatedApplications ?? 0;
                totalUpdated += appsUpdated;
                summary.push({
                  userId: u.id,
                  email: u.email,
                  userName: displayName,
                  updatedApplications: appsUpdated,
                  neoPatDrivesCount: result?.neoPatDrivesCount ?? 0,
                  collegeCircularsLinked: result?.collegeCircularsLinked ?? 0,
                });

                sendEvent('user_complete', {
                  userIndex: i + 1,
                  totalUsers: usersToProcess.length,
                  userId: u.id,
                  userName: displayName,
                  userEmail: u.email,
                  updatedApplications: appsUpdated,
                  neoPatDrivesCount: result?.neoPatDrivesCount ?? 0,
                  collegeCircularsLinked: result?.collegeCircularsLinked ?? 0,
                  message: `${displayName}: updated ${appsUpdated} applications (${result?.neoPatDrivesCount ?? 0} drives).`,
                });
              } catch (err: any) {
                console.error(`[Admin Reprocess All Stream] Error for ${u.email}:`, err);
                summary.push({
                  userId: u.id,
                  email: u.email,
                  userName: displayName,
                  updatedApplications: 0,
                  neoPatDrivesCount: 0,
                  collegeCircularsLinked: 0,
                  error: err.message,
                });

                sendEvent('user_error', {
                  userIndex: i + 1,
                  totalUsers: usersToProcess.length,
                  userId: u.id,
                  userName: displayName,
                  error: err.message,
                  message: `Error reprocessing ${displayName}: ${err.message}`,
                });
              }
            }

            sendEvent('complete', {
              success: true,
              totalUsersProcessed: summary.length,
              totalApplicationsUpdated: totalUpdated,
              usersProcessed: summary.length,
              applicationsUpdated: totalUpdated,
              summary,
              message: `Global reprocess completed for ${summary.length} students! ${totalUpdated} application stage(s) re-evaluated.`,
            });
          } catch (err: any) {
            sendEvent('error', { message: err.message || 'Global reprocess failed' });
          } finally {
            clearInterval(interval);
            try {
              controller.close();
            } catch {
              // already closed
            }
          }
        },
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'Content-Encoding': 'none',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    // Fallback standard JSON response
    const summary: Array<{
      userId: string;
      email: string;
      updatedApplications: number;
      neoPatDrivesCount: number;
      collegeCircularsLinked: number;
      error?: string;
    }> = [];

    let totalUpdated = 0;

    for (const u of usersToProcess) {
      try {
        const result = await performReprocess(u.id);
        const appsUpdated = result?.updatedApplications ?? 0;
        totalUpdated += appsUpdated;
        summary.push({
          userId: u.id,
          email: u.email,
          updatedApplications: appsUpdated,
          neoPatDrivesCount: result?.neoPatDrivesCount ?? 0,
          collegeCircularsLinked: result?.collegeCircularsLinked ?? 0,
        });
      } catch (err: any) {
        console.error(`[Admin Reprocess All] Error for user ${u.email}:`, err);
        summary.push({
          userId: u.id,
          email: u.email,
          updatedApplications: 0,
          neoPatDrivesCount: 0,
          collegeCircularsLinked: 0,
          error: err.message,
        });
      }
    }

    return NextResponse.json({
      success: true,
      totalUsersProcessed: summary.length,
      totalApplicationsUpdated: totalUpdated,
      usersProcessed: summary.length,
      applicationsUpdated: totalUpdated,
      result: {
        usersProcessed: summary.length,
        applicationsUpdated: totalUpdated,
        summary,
      },
      summary,
      message: `Global reprocess completed for ${summary.length} users. ${totalUpdated} application stage(s) re-evaluated.`,
    });
  } catch (err: any) {
    console.error('[Admin Reprocess All API] Unexpected error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
