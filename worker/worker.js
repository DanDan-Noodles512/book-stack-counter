// book-stack-counter — backend (Cloudflare Worker)
//
// Endpoints:
//   POST /count  { image: "data:image/jpeg;base64,..." } -> { books, magazines, total, stacks, notes }
//
// Secrets / vars (set in the Worker dashboard — never commit keys):
//   GEMINI_API_KEY    required (free tier via Google AI Studio)
//   AI_MODEL          optional override (default: gemini-3-flash-preview)
//   ALLOWED_ORIGIN    the web app origin allowed to call this worker
//                     (default "*" while testing)

const COUNT_PROMPT = [
  "You are counting physical items in a photograph of one or more stacks of books and magazines.",
  "Look at the spines. Count each individually visible spine.",
  "",
  "Rules:",
  "- Books are bound books: hardcover or paperback, usually thicker spines.",
  "- Magazines are periodicals: thinner, glossier, magazine-sized items.",
  "- Count only items you can actually see. Do not guess hidden items inside a stack.",
  "- If several separate stacks or piles are visible, break the count down per stack.",
  "- If you are unsure whether an item is a book or a magazine, count it as a book and say so in notes.",
  "",
  "Reply with STRICT JSON only, no explanations, no markdown fences:",
  '{"books": 0, "magazines": 0, "total": 0,',
  ' "stacks": [{"label": "Stack 1", "books": 0, "magazines": 0}],',
  ' "notes": "one short sentence about anything uncertain"}'
].join("\n");

const GEMINI_MODELS = [
  "gemini-3-flash-preview", "gemini-3.5-flash", "gemini-3.5-flash-lite",
  "gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.8-flash",
  "gemini-3.1-flash-lite", "gemini-3.1-flash-lite-preview",
  "gemini-flash-latest", "gemini-flash-lite-latest", "gemini-3.1-pro-preview"
];

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || "*";
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return json({ error: "POST only" }, 405, cors);

    const path = new URL(request.url).pathname;
    try {
      if (path === "/count") return await count(request, env, cors);
      return json({ error: "Unknown endpoint" }, 404, cors);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500, cors);
    }
  }
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json", ...(cors || {}) }
  });
}

async function count(request, env, cors) {
  const { image } = await request.json();
  if (!image || typeof image !== "string" || !image.startsWith("data:image/")) {
    throw new Error("An image data URL is required");
  }
  if (image.length > 15 * 1024 * 1024) throw new Error("Image is too large");
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured on the backend yet");

  const models = [...new Set([env.AI_MODEL || "gemini-3-flash-preview", ...GEMINI_MODELS])];
  let lastStatus = 0;
  for (const model of models) {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        model,
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: COUNT_PROMPT },
            { type: "image_url", image_url: { url: image } }
          ]
        }]
      })
    });
    if (!res.ok) {
      lastStatus = res.status;
      if ((res.status === 503 || res.status === 429 || res.status === 404) && model !== models[models.length - 1]) continue;
      throw new Error("Gemini returned " + res.status);
    }
    const data = await res.json();
    let raw = data.choices?.[0]?.message?.content || "";
    raw = raw.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      throw new Error("The AI did not return a countable result");
    }
    const books = Number(parsed.books) || 0;
    const magazines = Number(parsed.magazines) || 0;
    return json({
      books,
      magazines,
      total: Number(parsed.total) || (books + magazines),
      stacks: Array.isArray(parsed.stacks) ? parsed.stacks : [],
      notes: typeof parsed.notes === "string" ? parsed.notes : ""
    }, 200, cors);
  }
  throw new Error("Gemini returned " + lastStatus);
}
