import type { VercelRequest, VercelResponse } from "@vercel/node";

const MAX_BODY = 7 * 1024 * 1024;
const allowedActions = new Set(["vision", "ocr", "simplify", "explain", "chat"]);

function send(res: VercelResponse, status: number, payload: object) {
  return res.status(status).json(payload);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return send(res, 405, { error: "الطلب غير مسموح." });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return send(res, 503, { error: "خدمة الذكاء الاصطناعي غير مفعّلة بعد. يحتاج مسؤول الموقع لإضافة OPENAI_API_KEY في إعدادات Vercel." });

  let body: any = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return send(res, 400, { error: "بيانات الطلب غير مفهومة." }); }
  }
  if (!body || Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_BODY) {
    return send(res, 413, { error: "حجم البيانات أكبر من المسموح." });
  }

  const { action, text, image } = body;
  if (!allowedActions.has(action)) return send(res, 400, { error: "الخدمة المطلوبة غير معروفة." });
  if (typeof text !== "undefined" && (typeof text !== "string" || text.length > 12000))
    return send(res, 400, { error: "النص طويل جدًا أو غير صالح." });
  if (["vision", "ocr"].includes(action) &&
      (typeof image !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(image) || image.length > MAX_BODY))
    return send(res, 400, { error: "الصورة غير صالحة أو حجمها كبير." });

  const prompts: Record<string, string> = {
    vision: "أنت مساعد إتاحة عربي. صف ما يظهر في الصورة بلغة عربية واضحة ومختصرة، واذكر الأشياء والعلامات والنصوص المقروءة. لا تخمّن ما لا تستطيع رؤيته. نبّه المستخدم إلى أن الوصف قد يخطئ ولا يعتمد عليه لعبور الطريق أو تجنب المخاطر.",
    ocr: "استخرج النصوص الظاهرة في الصورة كما هي قدر الإمكان، مع الحفاظ على ترتيب الأسطر. إذا لم يوجد نص واضح فقل ذلك. لا تخترع كلمات.",
    simplify: "بسّط النص التالي بالعربية السهلة مع الحفاظ على المعنى، ثم اذكر أهم النقاط في نقاط قصيرة.",
    explain: "اشرح الموضوع التالي بالعربية السهلة خطوة بخطوة، مع مثال بسيط إن أمكن. لا تفترض عمر أو مستوى المستخدم.",
    chat: "أنت مساعد سند العربي. أجب بوضوح واحترام وباختصار مناسب. لا تدّع أنك إنسان أو مختص، واذكر حدودك عند الحاجة."
  };

  const content: any[] = [{ type: "input_text", text: action === "chat"
    ? `${prompts.chat}\n\nرسالة المستخدم: ${text || ""}`
    : action === "simplify" || action === "explain"
      ? `${prompts[action]}\n\n${text || ""}`
      : prompts[action] }];
  if (action === "vision" || action === "ocr") {
    content.push({ type: "input_image", image_url: image, detail: "high" });
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        input: [{ role: "user", content }],
        store: false,
        max_output_tokens: 700
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    const data: any = await upstream.json();
    if (!upstream.ok) {
      console.error("AI provider error", upstream.status);
      return send(res, 502, { error: "تعذر إكمال الطلب الآن. حاول مرة أخرى لاحقًا." });
    }
    const answer = (data.output || []).flatMap((item: any) => item.content || [])
      .filter((part: any) => part.type === "output_text")
      .map((part: any) => part.text).join("\n").trim();
    if (!answer) return send(res, 502, { error: "لم يصل رد واضح. حاول مرة أخرى." });
    return send(res, 200, { answer });
  } catch (error) {
    console.error("Assistant request failed", error);
    return send(res, 504, { error: "انتهى وقت الطلب أو حدث اتصال غير متوقع." });
  }
}