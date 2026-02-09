// app/api/tutor/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";

function json(data: unknown, status = 200) {
  return new NextResponse(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // CORS (não é obrigatório para Android, mas ajuda em testes no browser)
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, x-app-token",
      "access-control-allow-methods": "POST, OPTIONS",
      "cache-control": "no-store",
    },
  });
}

function normalizeLang(input: string): "es" | "it" {
  const v = (input || "").toLowerCase().trim();
  if (v === "it" || v.includes("ital")) return "it";
  return "es";
}

function buildInstructions(lang: "es" | "it") {
  const target = lang === "it" ? "Italiano" : "Espanhol (rioplatense neutro)";
  return `
Você é um tutor de idiomas.
Idioma alvo: ${target}.
Idioma da interface/explicações: Português (Brasil).

Regras:
- Responda curto e natural no idioma alvo.
- Depois inclua uma seção "Correções" corrigindo a frase do usuário (se necessário).
- Depois inclua uma seção "Dica" com 1 dica objetiva.
- Se o usuário escrever em PT-BR, peça para ele tentar no idioma alvo.
`.trim();
}

type HistoryMsg = { role: "user" | "assistant" | "model"; text: string };

function buildContents(history: HistoryMsg[] | undefined, userText: string) {
  // Gemini Developer API usa roles "user" e "model".
  // Aceitamos "assistant" por compatibilidade com o app.
  const contents: any[] = [];

  if (Array.isArray(history)) {
    for (const m of history) {
      const t = (m?.text ?? "").toString().trim();
      if (!t) continue;

      const roleRaw = (m?.role ?? "user").toString();
      const role = roleRaw === "assistant" || roleRaw === "model" ? "model" : "user";

      contents.push({
        role,
        parts: [{ text: t }],
      });
    }
  }

  contents.push({
    role: "user",
    parts: [{ text: userText }],
  });

  return contents;
}

function extractTextFromGemini(data: any): string {
  const cand = data?.candidates?.[0];
  const parts = cand?.content?.parts;
  if (!Array.isArray(parts)) return "";

  const out: string[] = [];
  for (const p of parts) {
    if (p?.text && typeof p.text === "string") out.push(p.text);
  }
  return out.join("\n").trim();
}

async function safeParseJson(req: Request): Promise<any | null> {
  // req.json() pode falhar em alguns cenários de encoding.
  // Fallback: req.text() + JSON.parse.
  try {
    return await req.json();
  } catch {
    try {
      const t = await req.text();
      if (!t) return null;
      return JSON.parse(t);
    } catch {
      return null;
    }
  }
}

export async function OPTIONS() {
  return json({ ok: true }, 200);
}

export async function POST(req: Request) {
  try {
    // Auth simples via APP_TOKEN (opcional)
    const appToken = (process.env.APP_TOKEN || "").trim();
    if (appToken) {
      const sent = (req.headers.get("x-app-token") || "").trim();
      if (sent !== appToken) return json({ error: "Unauthorized" }, 401);
    }

    const body = await safeParseJson(req);

    const lang = normalizeLang((body?.lang ?? "es").toString());
    const text = (body?.text ?? "").toString().trim();

    // Opcional: histórico para multi-turn (recomendado se você quiser contexto)
    const history = body?.history as HistoryMsg[] | undefined;

    if (!text) return json({ error: "Missing text" }, 400);
    if (text.length > 1500) return json({ error: "Text too long" }, 400);

    const apiKey = (process.env.GEMINI_API_KEY || "").trim();
    if (!apiKey) return json({ error: "Server missing GEMINI_API_KEY" }, 500);

    const model = (process.env.GEMINI_MODEL || "gemini-2.0-flash").trim();

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent`;

    const payload = {
      system_instruction: {
        parts: [{ text: buildInstructions(lang) }],
      },
      contents: buildContents(history, text),
      generationConfig: {
        temperature: 0.6,
        maxOutputTokens: 280,
      },
    };

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      return json(
        {
          error: "Gemini error",
          status: r.status,
          details: data,
        },
        r.status
      );
    }

    const tutorText = extractTextFromGemini(data);

    // Gemini nem sempre retorna um id estável; geramos um para o cliente
    const response_id =
      (data?.responseId && String(data.responseId)) ||
      (globalThis.crypto?.randomUUID?.() ?? `r_${Date.now()}`);

    if (!tutorText) {
      // Pode acontecer quando há bloqueio/safety ou resposta vazia
      return json(
        {
          error: "Empty response",
          response_id,
          details: data,
        },
        502
      );
    }

    return json({ text: tutorText, response_id }, 200);
  } catch (e: any) {
    return json({ error: "Server error", details: e?.message ?? String(e) }, 500);
  }
}
