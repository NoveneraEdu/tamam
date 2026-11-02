// تمام → OpenRouter: بياخد كلام مكتوب أو فويس نوت ويرجّع تاسكات مترتبة.
// صاحب الحساب بس (is_owner()) يقدر يناديها. مفتاح OpenRouter متخزن في الجدول الخاص integration_keys
// (مفيش وصول له من المتصفح)، فعمره ما بيوصل للصفحة أو للـ repo.
// Body:
//   { action: "status" }                          → { configured, model }
//   { action: "set_key", key, model? }            → يحفظ المفتاح (والموديل لو اتبعت)
//   { action: "parse", text?, audio?: {data, format}, now, weekday }
//        → { items: [...], transcript, reply }
import { createClient } from "npm:@supabase/supabase-js@2";

const DEFAULT_MODEL = "google/gemini-3.6-flash";
const FALLBACK_MODELS = ["google/gemini-2.5-flash"];
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const AREAS = ["work", "study", "personal", "money"];
const KINDS = ["task", "deadline", "exam", "submission", "payment", "meeting", "reminder"];

function systemPrompt(now: string, weekday: string) {
  return `إنت مساعد بيرتّب مهام شخص بيشتغل وبيدرس في نفس الوقت في مصر.
هيبعتلك كلام (مكتوب أو فويس نوت، غالباً بالعامية المصرية، وممكن فيه كلمات إنجليزي).
استخرج منه كل حاجة محتاجة تتعمل أو تتفتكر، وكل حاجة لوحدها عنصر منفصل.

الوقت دلوقتي: ${now} (${weekday})، بتوقيت القاهرة.
حوّل أي تاريخ نسبي لتاريخ فعلي: "بكره"، "بعد بكره"، "الخميس الجاي"، "آخر الشهر"، "كمان أسبوعين".
لو اليوم اتقال من غير "الجاي" وهو لسه مجاش الأسبوع ده، يبقى الأسبوع ده؛ لو عدّى، يبقى الأسبوع الجاي.
لو مفيش تاريخ خالص، خلّي due_date = null. ولو مفيش ساعة، due_time = null.
"الصبح" من غير ساعة = 09:00، "الضهر" = 13:00، "بالليل" = 21:00، بس لو اتقال كده صريح.

لكل عنصر:
- title: عنوان قصير وواضح بالعربي (من غير التاريخ أو المبلغ).
- notes: أي تفاصيل زيادة مفيدة، أو null.
- area: واحد من work (شغل) / study (دراسة، جامعة، كورسات) / personal (شخصي) / money (فلوس ومدفوعات).
- kind: واحد من:
  task (حاجة تتعمل) / deadline (ميعاد نهائي لحاجة في الشغل) / exam (امتحان أو كويز) /
  submission (تسليم: أسايمنت، بروجكت، شيت) / payment (دفع فلوس: إيجار، فاتورة، مصاريف، قسط، اشتراك) /
  meeting (اجتماع أو مقابلة أو محاضرة بميعاد) / reminder (حاجة تتفتكر بس).
  أي دفع فلوس يبقى kind = payment و area = money.
- due_date: "YYYY-MM-DD" أو null.
- due_time: "HH:MM" بنظام 24 ساعة أو null.
- amount: المبلغ كرقم لو اتذكر (بالجنيه)، أو null.
- priority: 1 عاجل/مهم جداً، 2 عادي، 3 مش مستعجل. الامتحانات والتسليمات والمدفوعات القريبة غالباً 1.

رجّع JSON بس، بالشكل ده بالظبط:
{"transcript": "<نص اللي اتقال بالظبط لو كان صوت، أو null لو مكتوب>",
 "reply": "<جملة واحدة قصيرة بالعامية تأكد فيها اللي ضفته>",
 "items": [ {"title": "...", "notes": null, "area": "...", "kind": "...", "due_date": null, "due_time": null, "amount": null, "priority": 2} ]}
لو الكلام مفيهوش أي مهمة، رجّع items فاضية واشرح في reply.`;
}

function clean(raw: any) {
  const items = Array.isArray(raw?.items) ? raw.items : [];
  const dateRe = /^\d{4}-\d{2}-\d{2}$/, timeRe = /^\d{2}:\d{2}$/;
  return items
    .filter((i: any) => i && typeof i.title === "string" && i.title.trim())
    .slice(0, 20)
    .map((i: any) => {
      const kind = KINDS.includes(i.kind) ? i.kind : "task";
      let area = AREAS.includes(i.area) ? i.area : "personal";
      if (kind === "payment") area = "money";
      const amt = Number(i.amount);
      const pr = Number(i.priority);
      return {
        title: i.title.trim().slice(0, 300),
        notes: typeof i.notes === "string" && i.notes.trim() ? i.notes.trim().slice(0, 2000) : null,
        area,
        kind,
        due_date: typeof i.due_date === "string" && dateRe.test(i.due_date) ? i.due_date : null,
        due_time: typeof i.due_time === "string" && timeRe.test(i.due_time) ? i.due_time : null,
        amount: Number.isFinite(amt) && amt > 0 ? Math.round(amt * 100) / 100 : null,
        priority: [1, 2, 3].includes(pr) ? pr : 2,
      };
    });
}

function parseJSON(s: string) {
  try { return JSON.parse(s); } catch { /* try to cut the object out */ }
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* fall through */ } }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const auth = req.headers.get("Authorization") ?? "";
  const user = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
  });
  const { data: owner } = await user.rpc("is_owner");
  if (owner !== true) return json({ error: "forbidden" }, 403);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  const getRow = async (id: string) =>
    (await admin.from("integration_keys").select("secret").eq("id", id).maybeSingle()).data?.secret ?? null;

  if (body.action === "status") {
    return json({ configured: !!(await getRow("openrouter")), model: (await getRow("openrouter_model")) ?? DEFAULT_MODEL });
  }

  if (body.action === "set_key") {
    const key = typeof body.key === "string" ? body.key.trim() : "";
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (key) {
      if (!/^sk-or-[A-Za-z0-9_-]{20,}$/.test(key)) return json({ error: "bad_key" }, 400);
      const { error } = await admin.from("integration_keys").upsert({ id: "openrouter", secret: key });
      if (error) return json({ error: "save_failed" }, 500);
    }
    if (model) {
      if (!/^[a-z0-9._-]+\/[a-z0-9._:-]+$/i.test(model)) return json({ error: "bad_model" }, 400);
      await admin.from("integration_keys").upsert({ id: "openrouter_model", secret: model });
    }
    return json({ ok: true });
  }

  if (body.action !== "parse") return json({ error: "unknown_action" }, 400);

  const key = await getRow("openrouter");
  if (!key) return json({ error: "not_configured" }, 400);
  const chosen = (await getRow("openrouter_model")) ?? DEFAULT_MODEL;

  const text = typeof body.text === "string" ? body.text.trim().slice(0, 4000) : "";
  const audio = body.audio && typeof body.audio.data === "string" ? body.audio : null;
  if (!text && !audio) return json({ error: "empty" }, 400);
  if (audio && audio.data.length > 12_000_000) return json({ error: "audio_too_long" }, 413);

  const content: any[] = [];
  if (text) content.push({ type: "text", text });
  if (audio) {
    content.push({ type: "text", text: "دي فويس نوت، اسمعها واكتب نصها في transcript وطلّع منها المهام:" });
    content.push({ type: "input_audio", input_audio: { data: audio.data, format: audio.format === "mp3" ? "mp3" : "wav" } });
  }
  const now = typeof body.now === "string" ? body.now.slice(0, 40) : new Date().toISOString();
  const weekday = typeof body.weekday === "string" ? body.weekday.slice(0, 20) : "";

  const models = [chosen, ...FALLBACK_MODELS.filter((m) => m !== chosen)];
  let lastErr = "ai_failed";
  for (const model of models) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://noveneraedu.github.io/tamam/",
          "X-Title": "Tamam",
        },
        body: JSON.stringify({
          model,
          temperature: 0.1,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt(now, weekday) },
            { role: "user", content },
          ],
        }),
      });
      if (r.status === 401 || r.status === 402) return json({ error: r.status === 401 ? "bad_key" : "no_credit" }, 502);
      if (!r.ok) { lastErr = "openrouter_" + r.status; continue; }
      const out = await r.json();
      const msg = out?.choices?.[0]?.message?.content;
      const parsed = parseJSON(typeof msg === "string" ? msg : JSON.stringify(msg ?? {}));
      if (!parsed) { lastErr = "bad_ai_output"; continue; }
      return json({
        items: clean(parsed),
        transcript: typeof parsed.transcript === "string" ? parsed.transcript.slice(0, 4000) : null,
        reply: typeof parsed.reply === "string" ? parsed.reply.slice(0, 300) : "",
        model,
      });
    } catch {
      lastErr = "openrouter_unreachable";
    }
  }
  return json({ error: lastErr }, 502);
});
