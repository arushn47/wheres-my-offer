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
    const error = Object.assign(new Error('Unauthorized: Authentication required'), { status: 401 });
    throw error;
  }

  const supabase = createAdminClient();
  const { data: user, error: lookupError } = await supabase
    .from('users')
    .select('role, email')
    .eq('id', session.userId)
    .maybeSingle();

  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  const isEmailAdmin = Boolean(!lookupError && user?.email && user.email.toLowerCase() === session.email.toLowerCase() && adminEmails.includes(user.email.toLowerCase()));
  const isRoleAdmin = user?.role === 'admin';

  if (lookupError || (!isRoleAdmin && !isEmailAdmin)) {
    const error = Object.assign(new Error('Forbidden: Admin role required'), { status: 403 });
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

  const supabase = createAdminClient();
  const { data: user, error } = await supabase
    .from('users')
    .select('role, email')
    .eq('id', userId)
    .maybeSingle();

  return !error && Boolean(user && (user.role === 'admin' || (email && user.email?.toLowerCase() === email.toLowerCase() && adminEmails.includes(email.toLowerCase()))));
}
