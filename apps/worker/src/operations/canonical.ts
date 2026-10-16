export function canonicalArgs(args: Record<string, unknown>): string {
  const text = JSON.stringify(args, (_key, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, record[key]])
      )
    }
    return value
  })
  if (new TextEncoder().encode(text).byteLength > 64 * 1024)
    throw new Error('operation_args_too_large')
  return text
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}
