import { useEffect, useState } from 'react'
import { Alert, Button, Select, Stack, Text, Textarea } from '@mantine/core'
import { InvocationPolicy, type InvocationPolicyResponse, type ProductRef } from '@ctxlayer/shared'
import { fetchInvocationPolicy, saveInvocationPolicy } from '../../../lib/api/upstreams'
import { Section, explain } from './helpers'

export function InvocationPolicySection({
  upstreamId,
  products
}: {
  upstreamId: string
  products: ProductRef[] | null
}) {
  const [snapshot, setSnapshot] = useState<InvocationPolicyResponse | null>(null)
  const [productId, setProductId] = useState<string | null>(null)
  const [rules, setRules] = useState('[]')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    const ctrl = new AbortController()
    setSnapshot(null)
    setError(null)
    setSaved(false)
    fetchInvocationPolicy(upstreamId, ctrl.signal)
      .then((value) => {
        if (ctrl.signal.aborted) return
        setSnapshot(value)
        setProductId(value.policy?.productId ?? null)
        setRules(JSON.stringify(value.policy?.rules ?? [], null, 2))
      })
      .catch((err: unknown) => {
        if (!ctrl.signal.aborted)
          setError(err instanceof Error ? err.message : 'Could not load policy')
      })
    return () => ctrl.abort()
  }, [upstreamId])

  async function save() {
    if (!snapshot) return
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const policy = InvocationPolicy.parse({ productId, rules: JSON.parse(rules) })
      const result = await saveInvocationPolicy(upstreamId, {
        expectedVersion: snapshot.version,
        policy
      })
      setSnapshot(result)
      setSaved(true)
    } catch (err) {
      setError(explain(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title="Invocation policy">
      <Stack gap="sm">
        {error && <Alert color="red">{error}</Alert>}
        {saved && (
          <Alert color="green">
            Policy saved. It applies to existing sessions and queued calls.
          </Alert>
        )}
        {snapshot && !snapshot.policy && (
          <Alert color="yellow">
            Legacy access: upstream visibility and tool ACL apply. Configure a project and explicit
            rules to restrict actions and resources.
          </Alert>
        )}
        <Select
          label="Project (existing product)"
          description="Only members of teams assigned to this product may execute calls."
          data={(products ?? []).map((p) => ({ value: p.id, label: p.displayName }))}
          value={productId}
          onChange={(v) => {
            setProductId(v)
            setSaved(false)
          }}
          disabled={!snapshot || busy}
        />
        <Textarea
          label="Tool and action rules (JSON)"
          autosize
          minRows={7}
          maxRows={20}
          description="An empty list blocks every tool. Rules must explicitly name each allowed action; resource arguments are exact allowlists."
          value={rules}
          onChange={(e) => {
            setRules(e.currentTarget.value)
            setSaved(false)
          }}
          disabled={!snapshot || busy}
        />
        <Text size="xs" c="dimmed">
          Example:{' '}
          {JSON.stringify([
            {
              tool: 'manage_orders',
              action: 'list',
              principals: [{ principalKind: 'everyone', principalId: null }],
              resources: [{ argument: 'shop_id', values: ['your-shop-id'] }],
              effect: 'allow'
            }
          ])}
        </Text>
        <Text size="xs" c="dimmed">
          Use a separate upstream per fixed-account credential. Leave resources empty when account
          scope is fixed by the connector instead of a tool argument.
        </Text>
        <Text size="xs" c="dimmed">
          Approval-required rules block execution until a verified approval flow is available.
          Saving a policy cannot revert to legacy access.
        </Text>
        <Button onClick={() => void save()} loading={busy} disabled={!snapshot || !productId}>
          Save invocation policy
        </Button>
      </Stack>
    </Section>
  )
}
