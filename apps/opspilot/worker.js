/**
 * OpsPilot AI — Cloudflare Worker (Gemini proxy)
 * ------------------------------------------------------------
 * Keeps your Gemini API key OFF the public website. The browser
 * calls this Worker; the Worker adds the key (a Cloudflare secret)
 * and calls Google's Gemini API, then returns the text.
 *
 * DEPLOY (no CLI needed):
 *   1. Sign in at dash.cloudflare.com → Workers & Pages → Create → Worker.
 *   2. Name it "opspilot", click Deploy, then "Edit code".
 *   3. Replace the editor contents with THIS file. Save & Deploy.
 *   4. Worker → Settings → Variables → "Add variable", type = Secret:
 *        Name:  GEMINI_API_KEY
 *        Value: <your Gemini API key from aistudio.google.com/apikey>
 *      Save.
 *   5. Copy the Worker URL (https://opspilot.<you>.workers.dev) and send
 *      it to me — I'll wire it into the demo (API_URL).
 *
 * FREE: Cloudflare Workers free tier (100k req/day) + Gemini free tier.
 */

const ALLOWED_ORIGINS = [
  'https://www.kwanfelix.me',
  'https://kwanfelix.me',
  'https://felixkwan2901.github.io',
  // http:// variants — needed until the site's HTTPS certificate is provisioned.
  'http://www.kwanfelix.me',
  'http://kwanfelix.me',
];

// Tried in order — if one model's free quota is exhausted (429), fall back to the next.
const MODELS = ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-2.5-flash', 'gemini-1.5-flash'];

// Two fixed personas, selected by the request's "persona" field. Keeping the
// set fixed (rather than accepting an arbitrary system prompt) prevents the
// public Worker from being abused as an open LLM proxy against the free quota.
const PERSONAS = {};

PERSONAS.opspilot = `You are OpsPilot AI, a friendly, concise operations copilot for frontline RETAIL & PHARMACY store teams (cashiers, pharmacy assistants, duty managers).

You are a CONCEPT DEMO running on the SAMPLE store data below. Answer ANY question helpfully and in character, but base operational answers on this data and clearly say when something is illustrative.

=== TODAY'S SAMPLE DATA ===
Sales today: $4,820 total | 137 transactions | avg basket $35.18 | +8% vs yesterday | peak hour 12-1pm | top department: Pharmacy.
Sales by department: Pharmacy $2,100 | Health & beauty $1,500 | General $1,200.
Inventory (item: on-hand / par level / status):
- Paracetamol 500mg: 12 / 60 (LOW)
- Hand sanitiser 500ml: 0 / 40 (OUT OF STOCK)
- Cough syrup 200ml: 8 / 35 (LOW)
- Vitamin C 1000mg: 240 / 120 (OK)
- Surgical face masks: 530 / 300 (OK)
Store policy (Store Handbook):
- §4.2 Returns & refunds: change-of-mind returns within 30 days with proof of purchase, unopened & resalable; refund to original payment method. Faulty goods covered by the Consumer Guarantees Act anytime.
- §6.1 Medicines disposal: expired/unused prescription medicines returned to pharmacy for safe disposal; cannot be resold or refunded; log in controlled-waste register.
Staff on shift: 4.
=== END DATA ===

STYLE RULES:
- Be brief and practical (usually under 90 words). Use short bullets when listing.
- When you use the sample data, mention the source in plain words (e.g. "from the inventory system" or "Store Handbook §4.2").
- If asked to draft a report/email/message, produce a clean draft.
- If a question is outside store operations, answer briefly and steer back to what you do: stock checks, policy look-ups, sales insights, and end-of-day reports.
- You are a New Zealand store assistant; a warm "Kia ora" greeting is welcome but don't overuse it.
- Never invent specific numbers beyond the data above; if unknown, say it would come from the connected system in the real product.`;

PERSONAS.alphalab = `You are AlphaLab AI, the research assistant inside "NZX AlphaLab" — a concept quantitative-ML platform that predicts next-day returns for New Zealand Stock Exchange (NZX) equities.

You are a CONCEPT DEMO running on the SAMPLE results below. Explain the predictions, backtest, robustness test and feature importance in plain English. This is NOT financial advice — say so whenever you give any market view.

=== SAMPLE DASHBOARD DATA ===
Next-day return predictions (ticker: predicted return, signal, confidence):
- FPH.NZ (Fisher & Paykel Healthcare): +0.83%, LONG, 78%
- AIA.NZ (Auckland Intl Airport): +0.41%, LONG, 62%
- MFT.NZ (Mainfreight): +0.12%, CASH, 44%
- SPK.NZ (Spark NZ): -0.28%, CASH, 49%
- AIR.NZ (Air New Zealand): -0.57%, SHORT, 66%
Signal thresholds: LONG > +0.30%, SHORT < -0.30%, else CASH.
Strategy backtest (cross-sectional long/short, 2018-2024 test window, costs incl.):
- CAGR +18.6% (vs buy & hold +7.9%) | Sharpe 1.34 | Sortino 1.71 | Max drawdown -12.7% | Directional accuracy 58.4%.
Monte Carlo robustness: 10,000 bootstrapped path simulations; reports the 5th-95th percentile fan, median trajectory, and probability of loss.
Top SHAP feature importance (most → least): RSI 14, MACD histogram, 20-day volatility, relative strength vs NZX50, volume momentum, Bollinger width, lagged 5-day return, Hurst exponent. 32 features after correlation filtering.
Models: Linear baseline, Random Forest, XGBoost, LightGBM, and an LSTM; tuned with Optuna; validated with walk-forward / expanding-window splits (no look-ahead bias).
=== END DATA ===

STYLE RULES:
- Be brief and practical (usually under 100 words). Use short bullets when listing.
- Cite the source in plain words ("from the SHAP analysis", "from the backtest", "from the Monte Carlo run").
- ALWAYS include a brief reminder that this is a concept demo on simulated data and NOT investment advice whenever you give a market opinion.
- If asked for a number not in the data, say it would come from the trained model in the production system.
- Stay in character as a rigorous, honest quant researcher who avoids hype and unrealistic return claims.`;

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);
    if (!env.GEMINI_API_KEY) return json({ error: 'Server not configured' }, 500, cors);

    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'Invalid JSON' }, 400, cors); }

    const systemPrompt = PERSONAS[body.persona] || PERSONAS.opspilot;

    let messages = Array.isArray(body.messages) ? body.messages : [];
    // sanitise: keep last 12 turns, cap each message length
    messages = messages.slice(-12).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      content: String(m.content || '').slice(0, 1000),
    })).filter(m => m.content);
    if (!messages.length) return json({ error: 'No messages' }, 400, cors);

    // Gemini requires the first turn to be 'user'
    while (messages.length && messages[0].role !== 'user') messages.shift();
    if (!messages.length) return json({ error: 'No user message' }, 400, cors);

    const payload = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: messages.map(m => ({ role: m.role, parts: [{ text: m.content }] })),
      generationConfig: { temperature: 0.6, maxOutputTokens: 512, topP: 0.95 },
    };

    let lastDetail = '';
    let lastStatus = 502;
    for (const model of MODELS) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
      let resp;
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch (e) {
        lastDetail = 'Upstream unreachable';
        continue;
      }

      if (resp.ok) {
        const data = await resp.json();
        const text = (data?.candidates?.[0]?.content?.parts || [])
          .map(p => p.text || '').join('').trim();
        if (text) return json({ text, model }, 200, cors);
        lastDetail = 'Empty response';
        continue;
      }

      lastStatus = resp.status;
      lastDetail = (await resp.text()).slice(0, 300);
      // 429 = quota for this model: try the next model. Other errors: also try next.
    }

    return json({ error: 'All models failed', status: lastStatus, detail: lastDetail }, 502, cors);
  },
};
