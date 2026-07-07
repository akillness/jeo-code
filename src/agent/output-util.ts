/** One tool execution's performance record (consumed by dev self-analysis's read
 *  path — `.jeo/state/performance-metrics.json`, currently never populated by
 *  any writer in this codebase; the shape is kept as the read-side contract). */
export interface PerfMetric {
  tool: string;
  duration: number;
  success: boolean;
  error?: string;
}
