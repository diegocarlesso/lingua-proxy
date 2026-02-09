import { NextResponse } from "next/server";

export const runtime = "nodejs";

function json(data: unknown, status = 200) {
  return new NextResponse(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // CORS (não é obrigatório para Android, mas não atrapalha)
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, x-app-token",
      "access-control-allow-methods": "POST, OPTIONS",
    },
  });
}

function buildInstructions(lang: string) {
  const target = lang === "it" ? "Italiano" : "Espanhol (rioplatense neutro)";
  return `
Você é um tutor de idiomas.
Idioma alvo: ${target}.
Idioma das explicações: Português (Brasil).
Regras:
- Responda curto e natural no idioma alvo.
- Depois inclua "Correções" corrigindo a frase do usuário (se necessário).
- Depois inclua "Dica" com 1 dica objetiva.
- Se o usuário escrever em PT-BR, peça para ele tentar no idioma alvo.
`.trim();
}

function extractOutputText(openaiJson: any): string {
  const out = openaiJson?.output ?? [];
  const parts: string[] = [];

  for (const item of out) {
    if (item?.type !== "message") continue;
    const content = item?.content ?? [];
    for (const c of content) {
      if (c?.type === "output_text" && typeof c?.text === "string") {
        parts.push(c.text);
      }
    }
  }
  return parts.join("\n").trim();
}

export async function OPTIONS() {
  return json({ ok: true }, 200);
}

export async function POST(req: Request) {
  try {
    const appToken = process.env.APP_TOKEN || "";
    if (appToken) {
      const sent = req.headers.get("x-app-token") || "";
      if (sent !== appToken) return json({ error: "Unauthorized" }, 401);
    }

    const body = await req.json().catch(() => null);
    const lang = (body?.lang ?? "es").toString(); // "es" ou "it"
    const text = (body?.text ?? "").toString().trim();
    const previous_response_id =
      body?.previous_response_id ? body.previous_response_id.toString() : undefined;

    if (!text) return json({ error: "Missing text" }, 400);
    if (text.length > 1500) return json({ error: "Text too long" }, 400);

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return json({ error: "Server missing OPENAI_API_KEY" }, 500);

    const payload: any = {
      model: process.env.OPENAI_MODEL || "gpt-4.1",
      instructions: buildInstructions(lang),
      input: text,
      max_output_tokens: 280,
      temperature: 0.6,
      store: false,
    };

    // Encadeamento de conversa (multi-turn) via previous_response_id :contentReference[oaicite:1]{index=1}
    if (previous_response_id) payload.previous_response_id = previous_response_id;

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return json({ error: "OpenAI error", status: r.status, details: data }, r.status);
    }

    const tutorText = extractOutputText(data);
    return json({ text: tutorText, response_id: data?.id ?? null }, 200);
  } catch (e: any) {
    return json({ error: "Server error", details: e?.message ?? String(e) }, 500);
  }
}