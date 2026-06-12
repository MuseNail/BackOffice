// ── route: /b/:biz/processor/helcim/transactions — payout matching feed (M13) ──
// Mirrors the Muse Worker's field-verified reconcile route (HELCIM-MIGRATION.md):
// GET https://api.helcim.com/v2/card-transactions?dateFrom&dateTo&limit=1000 with
// the api-token header. The HELCIM_API_TOKEN secret stays server-side; without it
// the route answers 501 and the Review match button explains. Membership was
// already checked by the router; this is read-only, so any member may ask.
// (Square payouts intentionally absent — Square is being retired in Muse; its
// bank deposits keep using the manual % fee-split until then.)

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function handleHelcimTransactions(req, env) {
  if (!env.HELCIM_API_TOKEN) return json({ error: 'helcim_not_configured' }, 501);
  const url = new URL(req.url);
  const dateFrom = url.searchParams.get('dateFrom') || '';
  const dateTo = url.searchParams.get('dateTo') || '';
  if (!DATE_RE.test(dateFrom) || !DATE_RE.test(dateTo)) return json({ error: 'dateFrom/dateTo required (YYYY-MM-DD)' }, 400);
  try {
    const qs = new URLSearchParams({ dateFrom, dateTo, limit: '1000' });
    const r = await fetch(`https://api.helcim.com/v2/card-transactions?${qs}`, {
      headers: { 'api-token': env.HELCIM_API_TOKEN, 'accept': 'application/json' },
    });
    const body = await r.text();
    if (r.status >= 400) console.error('[helcim transactions]', r.status, body.slice(0, 200));
    return new Response(body, { status: r.status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  } catch {
    return json({ error: 'helcim unreachable' }, 502);
  }
}
