import type { Env } from '../env'
import type { AsyncJobRow } from '../db/queries/async-jobs'
import { authorizeInvocation } from './authorize-invocation'

/** Apply current scope before exposing stored results or job metadata. */
export async function canReadJob(env: Env, userId: string, job: AsyncJobRow): Promise<boolean> {
  if (job.user_id !== userId) return false
  let args: unknown
  try {
    args = JSON.parse(job.args_json ?? '{}')
  } catch {
    return false
  }
  return (await authorizeInvocation(env, userId, job.upstream_id, job.tool, args)).allowed
}
