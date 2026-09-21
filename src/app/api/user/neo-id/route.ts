import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * PATCH /api/user/neo-id
 * 
 * Updates the user's Neo ID.
 * Body: { neo_id: string | null }
 */
export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { error: { message: 'Unauthorized', code: 'unauthorized' } },
      { status: 401 }
    );
  }

  const body = await request.json();
  const { neo_id } = body;
  const rawNeoId = typeof neo_id === 'string' ? neo_id.trim().toUpperCase() : null;
  const normalizedNeoId = rawNeoId || null;

  // Validate Neo ID format if provided
  if (normalizedNeoId !== null) {
    if (!/^[A-Z0-9]{6,12}$/.test(normalizedNeoId)) {
      return NextResponse.json(
        { error: { message: 'Invalid Neo ID format. Must be 6-12 alphanumeric characters.', code: 'invalid_neo_id' } },
        { status: 400 }
      );
    }
  }

  const supabase = createAdminClient();

  // Check if this Neo ID is already claimed by another student account
  if (normalizedNeoId !== null) {
    const { data: existingUser, error: checkError } = await supabase
      .from('users')
      .select('id, name')
      .ilike('neo_id', normalizedNeoId)
      .neq('id', session.userId)
      .maybeSingle();

    if (checkError) {
      console.error('[neo-id] Error checking existing Neo ID:', checkError);
    }

    if (existingUser) {
      return NextResponse.json(
        {
          error: {
            message: 'This Candidate Registration ID is already linked to another student account.',
            code: 'duplicate_neo_id',
          },
        },
        { status: 409 }
      );
    }
  }

  const { error } = await supabase
    .from('users')
    .update({ neo_id: normalizedNeoId })
    .eq('id', session.userId);

  if (error) {
    // Postgres unique constraint violation (code 23505)
    if (error.code === '23505') {
      return NextResponse.json(
        {
          error: {
            message: 'This Candidate Registration ID is already linked to another student account.',
            code: 'duplicate_neo_id',
          },
        },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { error: { message: 'Failed to update Neo ID', code: 'db_error' } },
      { status: 500 }
    );
  }

  return NextResponse.json({ data: { neo_id: normalizedNeoId }, error: null });
}
