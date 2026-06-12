// ── route: /b/:biz/ai/categorize — Claude-suggested categories ────────────────
// Stateless: the client sends its pending rows + its chart of accounts; we ask
// Claude once per batch and return validated suggestions. The API key lives
// ONLY here (Worker secret) — suggestions never post anything; approval stays
// with the user (kickoff integrity rule 5).

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });

const MAX_ROWS = 40;

// Structured-output schema: the API guarantees the response text is valid JSON
// matching this shape (no numeric min/max support — confidence is clamped below).
const SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          categoryId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          confidence: { type: 'integer' },
        },
        required: ['id', 'categoryId', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['suggestions'],
  additionalProperties: false,
};

const SYSTEM = `You are a bookkeeping assistant for small businesses. You receive bank-statement transactions and the business's chart of accounts. For each transaction, pick the single most appropriate category account id from the provided list, or null when genuinely unclear — never guess a stretch. Use the merchant/description, the amount sign (negative = money out, so expense/cogs/asset categories; positive = money in, so income/liability categories), and each account's type. confidence is 0-100: 90+ only for unmistakable merchants, below 60 means you are mostly guessing.`;

export async function handleCategorize(req, env) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ai_not_configured' }, 501);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad request' }, 400); }
  const { rows, categories } = body || {};
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_ROWS || !Array.isArray(categories) || !categories.length) {
    return json({ error: `bad request — 1..${MAX_ROWS} rows + categories required` }, 400);
  }

  const payload = {
    transactions: rows.map(r => ({
      id: String(r.id),
      description: String(r.desc || '').slice(0, 200),
      amount: (r.amountCents || 0) / 100,
      date: r.date,
    })),
    categories: categories.map(c => ({ id: String(c.id), name: String(c.name || ''), type: String(c.type || '') })),
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: env.AI_MODEL || 'claude-opus-4-8',
      max_tokens: 4000,
      system: SYSTEM,
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    }),
  });

  if (!res.ok) {
    console.error('[ai] anthropic', res.status, await res.text().catch(() => ''));
    return json({ error: 'ai_failed' }, 502);
  }

  const data = await res.json();
  let parsed;
  try {
    parsed = JSON.parse(data.content?.find(b => b.type === 'text')?.text || '');
  } catch { return json({ error: 'ai_failed' }, 502); }

  // Trust nothing: only known row ids, only known category ids, clamped confidence.
  const rowIds = new Set(payload.transactions.map(t => t.id));
  const catIds = new Set(payload.categories.map(c => c.id));
  const suggestions = (parsed.suggestions || [])
    .filter(s => rowIds.has(s.id) && (s.categoryId === null || catIds.has(s.categoryId)))
    .map(s => ({ id: s.id, categoryId: s.categoryId, confidence: Math.max(0, Math.min(100, s.confidence | 0)) }));

  return json({ suggestions, usage: data.usage });
}
