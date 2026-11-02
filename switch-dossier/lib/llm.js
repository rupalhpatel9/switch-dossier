// Thin Anthropic Messages API client. Schema-enforced output via forced tool use.
const KEY = process.env.ANTHROPIC_API_KEY;
export const MODEL = process.env.SWITCH_MODEL || 'claude-sonnet-5-5';
export const llmEnabled = Boolean(KEY);

export async function llmJSON({ system, user, schema, name = 'emit', maxTokens = 4096 }) {
  if (!llmEnabled) throw new Error('LLM not configured');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
      tools: [{ name, description: 'Return the structured result.', input_schema: schema }],
      tool_choice: { type: 'tool', name },
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  const block = body.content?.find((b) => b.type === 'tool_use');
  if (!block) throw new Error('No structured output returned');
  return block.input;
}
