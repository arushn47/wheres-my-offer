import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/admin';
import { performReprocess } from '@/app/api/sync/reprocess/route';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    await requireAdmin();
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Unauthorized' },
      { status: err.status || 401 }
    );
  }

  const { userId } = await params;
  if (!userId) {
    return NextResponse.json({ error: 'Missing userId parameter' }, { status: 400 });
  }

  const isStream =
    req.headers.get('accept')?.includes('text/event-stream') ||
    req.nextUrl.searchParams.get('stream') === 'true';

  if (isStream) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const sendEvent = (event: string, data: any) => {
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            // Client closed
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
          sendEvent('start', { message: 'Analyzing placement archive & recalculating drives…' });

          const statusResult = await performReprocess(userId, (progress) => {
            sendEvent('stage', progress);
          });

          sendEvent('complete', {
            success: true,
            updatedApplications: statusResult.updatedApplications,
            neoPatDrivesCount: statusResult.neoPatDrivesCount,
            collegeCircularsLinked: statusResult.collegeCircularsLinked,
            collegeCircularsDiscarded: statusResult.collegeCircularsDiscarded,
            companiesUpdated: statusResult.updatedApplications,
            fixed: statusResult.updatedApplications,
            message: `Reprocess complete: ${statusResult.updatedApplications} applications updated across ${statusResult.neoPatDrivesCount} drives.`,
          });
        } catch (err: any) {
          sendEvent('error', { message: err?.message || 'Placement re-indexing failed' });
        } finally {
          clearInterval(interval);
          try {
            controller.close();
          } catch {
            // Closed
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

  try {
    const result = await performReprocess(userId);
    return NextResponse.json({
      success: true,
      result,
      updatedApplications: result.updatedApplications,
      companiesUpdated: result.updatedApplications,
      fixed: result.updatedApplications,
      message: `Reprocess complete: ${result.updatedApplications} applications updated.`,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Admin reprocess failed' },
      { status: 500 }
    );
  }
}
