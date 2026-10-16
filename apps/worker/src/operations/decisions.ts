import type { OperationDecision } from '@ctxlayer/shared'
import type { Env } from '../env'
import { findOperation, transitionOperation } from '../db/queries/operations'
import { approvalSnapshot, assertApprover, OperationError } from './access'
import { expireOperation } from './requests'

export async function decideOperation(
  env: Env,
  actorId: string,
  id: string,
  decision: OperationDecision
) {
  const found = await findOperation(env, id)
  if (!found) throw new OperationError('not_found', 404)
  await assertApprover(env, actorId, found)
  const row = await expireOperation(env, found)
  if (decision.action === 'resolve') {
    if (
      !(await transitionOperation(env, id, 'unknown', decision.outcome, actorId, {
        resolution: JSON.stringify({ note: decision.note, reference: decision.reference }),
        errorCode: 'manually_reconciled'
      }))
    )
      throw new OperationError('operation_state_conflict', 409)
  } else {
    if (row.state !== 'pending') throw new OperationError('operation_state_conflict', 409)
    if (decision.action === 'approve') {
      const snapshot = await approvalSnapshot(
        env,
        row.requester_id,
        row.upstream_id,
        row.tool,
        JSON.parse(row.args_json)
      )
      if (
        snapshot.version !== row.policy_version ||
        snapshot.connectionHash !== row.connection_hash
      ) {
        throw new OperationError('approval_snapshot_changed', 409)
      }
    }
    if (
      !(await transitionOperation(
        env,
        id,
        'pending',
        decision.action === 'approve' ? 'approved' : 'rejected',
        actorId
      ))
    ) {
      throw new OperationError('operation_state_conflict', 409)
    }
  }
  const updated = await findOperation(env, id)
  if (!updated) throw new OperationError('not_found', 404)
  return updated
}
