/** Independent sync jobs all finish; failures remain attributable instead of hiding behind the first 404. */
export async function settleSyncJobs(jobs: { label: string; run: () => Promise<unknown> }[]): Promise<void> {
  const results = await Promise.allSettled(jobs.map((job) => Promise.resolve().then(job.run)));
  const errors = results.flatMap((r, i) => r.status === 'rejected'
    ? [`${jobs[i]!.label}：${r.reason instanceof Error ? r.reason.message : String(r.reason)}`] : []);
  if (errors.length) throw new Error(errors.join('\n'));
}
