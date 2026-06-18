// ── calc — silent QuickBooks-style calculator on money/amount fields ──────────
// Ported from the Muse app. Type an arithmetic expression into any amount field
// ("40+5*2") and it evaluates LEFT-TO-RIGHT (40+5*2 = 90, like a cash register) on
// blur / Enter, with a small live receipt-tape popup under the field. Plain dollar
// fields also auto-fill cents on blur ("5014" → "5014.00"). Install once at boot.
// Safe: a hand-written tokenizer, never eval(). Fields marked data-nocents (percent
// / count fields) still get the calculator but are NOT cents-formatted.
const OPS = { '+': '+', '-': '−', '*': '×', '/': '÷' };

export function evalAmountExpression(str) {
  const norm = String(str == null ? '' : str).replace(/×/g, '*').replace(/÷/g, '/').replace(/[^0-9.+\-*/]/g, '');
  if (!/\d\s*[+\-*/]/.test(norm)) return null;   // a number then an operator → it's an expression
  const tokens = norm.match(/(\d+\.?\d*|\.\d+|[+\-*/])/g);
  if (!tokens) return null;
  let acc = parseFloat(tokens[0]); if (isNaN(acc)) return null;
  for (let i = 1; i + 1 < tokens.length; i += 2) {
    const op = tokens[i], n = parseFloat(tokens[i + 1]); if (isNaN(n)) break;
    acc = op === '+' ? acc + n : op === '-' ? acc - n : op === '*' ? acc * n : op === '/' ? (n === 0 ? acc : acc / n) : acc;
  }
  return Math.round(acc * 100) / 100;
}

const isAmountField = (el) => !!el && el.tagName === 'INPUT' && el.type !== 'tel' && ['none', 'decimal'].includes((el.getAttribute('inputmode') || '').toLowerCase());
const wantsCents = (el) => isAmountField(el) && el.dataset.nocents == null;

// Build the running tape (left-to-right) for the live popup: ['40','+ 5','× 2'] + result.
function calcSteps(str) {
  const norm = String(str == null ? '' : str).replace(/×/g, '*').replace(/÷/g, '/').replace(/[^0-9.+\-*/]/g, '');
  const tokens = norm.match(/(\d+\.?\d*|\.\d+|[+\-*/])/g);
  if (!tokens) return null;
  let acc = parseFloat(tokens[0]); if (isNaN(acc)) return null;
  const lines = [tokens[0]];
  for (let i = 1; i + 1 < tokens.length; i += 2) {
    const op = tokens[i], n = parseFloat(tokens[i + 1]); if (isNaN(n)) break;
    acc = op === '+' ? acc + n : op === '-' ? acc - n : op === '*' ? acc * n : op === '/' ? (n === 0 ? acc : acc / n) : acc;
    lines.push((OPS[op] || op) + ' ' + tokens[i + 1]);
  }
  return { lines, result: Math.round(acc * 100) / 100 };
}

function hideCalcPop() { const p = document.getElementById('amt-calc-pop'); if (p) p.style.display = 'none'; }
function showCalcPop(el) {
  if (!/\d\s*[+\-*/×÷]/.test(el.value)) { hideCalcPop(); return; }
  const steps = calcSteps(el.value); if (!steps) { hideCalcPop(); return; }
  let pop = document.getElementById('amt-calc-pop');
  if (!pop) {
    pop = document.createElement('div'); pop.id = 'amt-calc-pop';
    pop.style.cssText = 'position:fixed;z-index:300;pointer-events:none;background:#fff;border:1px solid #d2d6e0;border-radius:9px;box-shadow:0 10px 28px rgba(20,30,55,.20);padding:7px 12px;font-family:Inter,sans-serif;font-variant-numeric:tabular-nums;text-align:right;min-width:110px';
    document.body.appendChild(pop);
  }
  pop.innerHTML = steps.lines.map(l => `<div style="font-size:12px;color:#6b6e78;line-height:1.55">${l}</div>`).join('')
    + `<div style="border-top:1px solid #e6e7ec;margin-top:3px;padding-top:3px;font-size:15px;font-weight:800;color:#2456a6">$${steps.result.toFixed(2)}</div>`;
  pop.style.display = 'block';
  const r = el.getBoundingClientRect();
  pop.style.left = Math.max(4, Math.min(r.left, window.innerWidth - pop.offsetWidth - 6)) + 'px';
  pop.style.top = (r.bottom + 4) + 'px';
}

// Commit an expression in the field to its result; fire `input` so totals recompute.
function commitExpr(el) {
  const result = evalAmountExpression(el.value);
  if (result == null || String(result) === el.value) return false;
  el.value = String(result);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}
// Auto-fill cents on a plain dollar field ("5014" → "5014.00").
function formatCents(el) {
  const s = (el.value || '').replace(/[$,\s]/g, '');
  if (s === '' || isNaN(parseFloat(s))) return;
  const f = parseFloat(s).toFixed(2);
  if (el.value !== f) { el.value = f; el.dispatchEvent(new Event('input', { bubbles: true })); }
}

let _installed = false;
export function initAmountCalc() {
  if (_installed) return; _installed = true;
  let selectPending = null;
  // Focus selects the existing value (type to replace), like the QuickBooks register.
  document.addEventListener('focusin', (e) => {
    if (!isAmountField(e.target)) return;
    const el = e.target; selectPending = el;
    setTimeout(() => { if (document.activeElement === el) { try { el.select(); } catch { /* ignore */ } } }, 0);
  });
  // A click after focus would collapse the selection — keep it highlighted.
  document.addEventListener('mouseup', (e) => { if (e.target === selectPending) { e.preventDefault(); selectPending = null; } });
  document.addEventListener('input', (e) => { if (isAmountField(e.target)) showCalcPop(e.target); });
  document.addEventListener('focusout', (e) => {
    if (!isAmountField(e.target)) return;
    commitExpr(e.target); hideCalcPop();
    if (wantsCents(e.target)) formatCents(e.target);
  });
  // Enter commits a running calc (and fills cents) without also saving the modal.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !isAmountField(e.target)) return;
    if (evalAmountExpression(e.target.value) == null) return;
    e.preventDefault(); e.stopPropagation();
    commitExpr(e.target); hideCalcPop();
    if (wantsCents(e.target)) formatCents(e.target);
    try { e.target.select(); } catch { /* ignore */ }
  });
  window.addEventListener('scroll', hideCalcPop, true);
}
