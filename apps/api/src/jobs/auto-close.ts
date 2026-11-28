import { and, eq, isNull, ne } from "drizzle-orm";
import { jobs, segments, tasks, type Database } from "@opsengine/db";

/**
 * Closes a job once the people on it have finished every task. A job with no tasks, a task still
 * open, or someone still on the clock for it stays open. Returns the job when it was closed.
 */
export async function closeJobIfFinished(conn: Database, jobId: string) {
  const [job] = await conn.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job || job.status === "done") return null;
  const jobTasks = await conn.select({ status: tasks.status }).from(tasks).where(eq(tasks.jobId, job.id));
  if (jobTasks.length === 0 || jobTasks.some((task) => task.status !== "done")) return null;
  const running = await conn
    .select({ id: segments.id })
    .from(segments)
    .where(and(eq(segments.jobId, job.id), isNull(segments.endedAt)))
    .limit(1);
  if (running.length > 0) return null;
  const [closed] = await conn
    .update(jobs)
    .set({ status: "done" })
    .where(and(eq(jobs.id, job.id), ne(jobs.status, "done")))
    .returning();
  return closed ?? null;
}
