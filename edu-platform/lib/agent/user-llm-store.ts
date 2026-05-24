/**
 * Per-user LLM configuration feature has been removed.
 * runWithUserLlm is kept as a passthrough for call-site compatibility.
 */
export async function runWithUserLlm<T>(_userId: string, fn: () => Promise<T>): Promise<T> {
  return fn();
}
