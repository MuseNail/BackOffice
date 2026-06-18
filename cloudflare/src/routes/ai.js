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
          vendor: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          confidence: { type: 'integer' },
        },
        required: ['id', 'categoryId', 'vendor', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['suggestions'],
  additionalProperties: false,
};

const SYSTEM = `You are a bookkeeping assistant for small businesses. You receive bank-statement transactions and the business's chart of accounts. For each transaction, pick the single most appropriate category account id from the provided list, or null when genuinely unclear — never guess a stretch. Use the merchant/description, the amount sign (negative = money out, so expense/cogs/asset categories; positive = money in, so income/liability categories), and each account's type. confidence is 0-100: 90+ only for unmistakable merchants, below 60 means you are mostly guessing. You are also given "examples": how THIS business has already categorized past transactions (description → categoryId). Treat these as your strongest signal — when a transaction's description resembles an example (same merchant, or a clear shared pattern), assign the SAME categoryId with high confidence. Fall back to general reasoning only when no example is similar.

Also return "vendor": a short, clean merchant or payee name pulled from the description — e.g. "SALLY BEAUTY SUPPLY #1234 LA CA" → "Sally Beauty Supply"; "PYMT SENT VENMO *RAUL ALEXANDER M" → "Raul Alexander"; "POS DEBIT NETFLIX COM LOS GATOS CA" → "Netflix". Strip store numbers, cities, states, card last-4, and payment-rail noise (POS DEBIT, ACH, PYMT SENT, ORIG CO NAME, ENTRY DESCR, IND ID, etc.). You are given "vendors": the names this business already uses — when your cleaned name is clearly the same merchant as one of them, return that EXACT existing name (case and spelling) so it is not duplicated. Use null only when there is no meaningful payee (e.g. a bank fee or internal transfer).`;

// $/1M tokens → microdollars per token. Stamped onto each usage record at call
// time so history stays correct if prices change later.
const PRICES = {
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

export async function handleCategorize(req, env, bizId) {
  const stub = env.BUSINESS_DO.get(env.BUSINESS_DO.idFromName(bizId));

  // the kill switches live in the business's own data — checked BEFORE any money is spent
  const gate = await (await stub.fetch('https://do/b/x/_ai/check')).json();
  if (gate.paused) return json({ error: 'ai_paused' }, 403);
  if (gate.budgetMicros > 0 && gate.spentMicros >= gate.budgetMicros) {
    return json({ error: 'ai_budget_reached', spentMicros: gate.spentMicros, budgetMicros: gate.budgetMicros }, 403);
  }

  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ai_not_configured' }, 501);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad request' }, 400); }
  const { rows, categories, examples, vendors } = body || {};
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_ROWS || !Array.isArray(categories) || !categories.length) {
    return json({ error: `bad request — 1..${MAX_ROWS} rows + categories required` }, 400);
  }
  const catIds = new Set(categories.map(c => String(c.id)));
  // Few-shot: how THIS business has categorized past rows (desc → categoryId), so the
  // model learns the user's own patterns. Validated against the known accounts; capped.
  const exampleList = (Array.isArray(examples) ? examples : [])
    .filter(e => e && typeof e.desc === 'string' && e.desc.trim() && catIds.has(String(e.categoryId)))
    .slice(0, 100)
    .map(e => ({ description: String(e.desc).slice(0, 200), categoryId: String(e.categoryId) }));

  const payload = {
    transactions: rows.map(r => ({
      id: String(r.id),
      description: String(r.desc || '').slice(0, 200),
      amount: (r.amountCents || 0) / 100,
      date: r.date,
    })),
    categories: categories.map(c => ({ id: String(c.id), name: String(c.name || ''), type: String(c.type || '') })),
    examples: exampleList,
    vendors: (Array.isArray(vendors) ? vendors : []).filter(n => typeof n === 'string' && n.trim()).map(n => n.trim().slice(0, 60)).slice(0, 200),
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
      tools: [{ name: 'suggest_categories', description: 'Return category suggestions for the provided transactions', input_schema: SCHEMA }],
      tool_choice: { type: 'tool', name: 'suggest_categories' },
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    }),
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    console.error('[ai] anthropic', res.status, raw);
    // Surface the real upstream error so failures are diagnosable (the Anthropic
    // error body carries a type/message but never the API key) — e.g. 401
    // authentication_error (bad key), 404 not_found_error (model), 403 permission_error.
    let type = '', message = '';
    try { const e = JSON.parse(raw)?.error; type = e?.type || ''; message = String(e?.message || '').slice(0, 300); }
    catch { message = raw.slice(0, 300); }
    return json({ error: 'ai_failed', upstream: res.status, type, message }, 502);
  }

  const data = await res.json();
  let parsed;
  try {
    parsed = data.content?.find(b => b.type === 'tool_use')?.input;
    if (!parsed) throw new Error('no tool_use block');
  } catch { return json({ error: 'ai_failed', upstream: 200, type: 'no_tool_use', message: 'model returned no suggestions block' }, 502); }

  // Trust nothing: only known row ids, only known category ids, clamped confidence.
  const rowIds = new Set(payload.transactions.map(t => t.id));
  const suggestions = (parsed.suggestions || [])
    .filter(s => rowIds.has(s.id) && (s.categoryId === null || catIds.has(s.categoryId)))
    .map(s => ({ id: s.id, categoryId: s.categoryId, vendor: (typeof s.vendor === 'string' && s.vendor.trim()) ? s.vendor.trim().slice(0, 60) : null, confidence: Math.max(0, Math.min(100, s.confidence | 0)) }));

  // record the spend in the business's own books (broadcasts live to the app)
  const model = env.AI_MODEL || 'claude-opus-4-8';
  const usage = data.usage || {};
  if (!PRICES[model]) console.warn('[ai] unknown model for pricing, defaulting to opus rates:', model);
  const price = PRICES[model] || PRICES['claude-opus-4-8'];
  const costMicros = Math.round((usage.input_tokens || 0) * price.in + (usage.output_tokens || 0) * price.out);
  await stub.fetch('https://do/b/x/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: 'entity.upsert', kind: 'aiusage', value: {
      id: 'ai-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      month: new Date().toISOString().slice(0, 7),
      at: Date.now(), model, rows: payload.transactions.length,
      inputTokens: usage.input_tokens || 0, outputTokens: usage.output_tokens || 0,
      costMicros, updatedAt: Date.now(),
    } }),
  });

  return json({ suggestions, usage });
}
