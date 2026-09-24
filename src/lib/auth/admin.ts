import { getSession } from '@/lib/auth';
import { createAdminClient } from '@/lib/supabase/admin';

export interface AdminContext {
  userId: string;
  email: string;
}

/**
 * Server-side RBAC guard for all admin endpoints and pages.
 * Strictly verifies that the authenticated caller has role === 'admin' in the database,
 * or is listed in the ADMIN_EMAILS environment variable bootstrap.
 * Throws an Error with 401/403 status semantics if unauthenticated or unauthorized.
 */
export async function requireAdmin(): Promise<AdminContext> {
  const session = await getSession();
  if (!session?.userId) {
    const error: any = new Error('Unauthorized: Authentication required');
    error.status = 401;
    throw error;
  }

  const supabase = createAdminClient();
  const { data: user } = await supabase
    .from('users')
    .select('role')
    .eq('id', session.userId)
    .maybeSingle();

  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  const isEmailAdmin = Boolean(session.email && adminEmails.includes(session.email.toLowerCase()));
  const isRoleAdmin = user?.role === 'admin';

  if (!isRoleAdmin && !isEmailAdmin) {
    const error: any = new Error('Forbidden: Admin role required');
    error.status = 403;
    throw error;
  }

  return { userId: session.userId, email: session.email };
}

/**
 * Non-throwing check to determine if a user has admin privileges.
 */
export async function checkIsAdmin(userId: string, email?: string | null): Promise<boolean> {
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  if (email && adminEmails.includes(email.toLowerCase())) {
    return true;
  }

  const supabase = createAdminClient();
  const { data: user } = await supabase
    .from('users')
    .select('role')
    .eq('id', userId)
    .maybeSingle();

  return user?.role === 'admin';
}
