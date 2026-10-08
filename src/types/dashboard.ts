/** Statistics returned by the dashboard's existing server reader. */
export interface DashboardStats {
  total_companies: number;
  active_applications: number;
  total_applied?: number;
  applied: number;
  shortlisted: number;
  total_shortlisted?: number;
  active_shortlisted?: number;
  not_shortlisted: number;
  upcoming_tests: number;
  upcoming_interviews: number;
  test_shortlists: number;
  interview_shortlists: number;
  rejected: number;
  withdrawn: number;
  selected: number;
}
