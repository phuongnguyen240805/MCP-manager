import {
  OperationDecision,
  OperationView,
  OperationsResponse,
  RequestOperation
} from '@ctxlayer/shared'
import { request } from './core'

export function createOperation(input: RequestOperation): Promise<OperationView> {
  return request('/api/operations', (raw) => OperationView.parse(raw), {
    method: 'POST',
    body: JSON.stringify(RequestOperation.parse(input))
  })
}
export function fetchOperation(id: string, signal?: AbortSignal): Promise<OperationView> {
  return request(`/api/operations/${encodeURIComponent(id)}`, (raw) => OperationView.parse(raw), {
    signal
  })
}
export function executeApprovedOperation(id: string): Promise<OperationView> {
  return request(
    `/api/operations/${encodeURIComponent(id)}/execute`,
    (raw) => OperationView.parse(raw),
    { method: 'POST' }
  )
}

export function fetchUpstreamOperations(
  upstreamId: string,
  signal?: AbortSignal
): Promise<OperationsResponse> {
  return request(
    `/api/admin/upstreams/${encodeURIComponent(upstreamId)}/operations`,
    (raw) => OperationsResponse.parse(raw),
    { signal }
  )
}

export function decideUpstreamOperation(
  upstreamId: string,
  id: string,
  input: OperationDecision
): Promise<OperationView> {
  return request(
    `/api/admin/upstreams/${encodeURIComponent(upstreamId)}/operations/${encodeURIComponent(id)}/decision`,
    (raw) => OperationView.parse(raw),
    { method: 'POST', body: JSON.stringify(OperationDecision.parse(input)) }
  )
}
