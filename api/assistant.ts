import type { VercelRequest, VercelResponse } from "@vercel/node";

const MAX_BODY = 7 * 1024 * 1024;
const IMAGE_ACTIONS = new Set(["vision", "ocr", "ask", "obstacles", "currency", "product", "colors", "people", "place"]);
const TEXT_ACTIONS = new Set(["simplify", "explain", "chat"]);
const MODEL = process.env.MOONDREAM_MODEL || "moondream3.1-9B-A2B";

function send(res: VercelResponse, status: number, payload: object) {
  return res.status(status).json(payload);
}

function promptFor(action: string, text = "") {
  const base = "أجب بالعربية المصرية الواضحة والمختصرة المناسبة لقارئ الشاشة. صف فقط ما تدعمه الصورة، وصرّح بوضوح عندما لا تستطيع التأكد. لا تستنتج هوية الأشخاص أو صفاتهم الحساسة.";
  const prompts: Record<string, string> = {
    ocr: `${base} استخرج كل النصوص الظاهرة في الصورة كما هي وبالترتيب، وميّز بين النص المقروء وغير الواضح. لا تخترع كلمات.`,
    vision: `${base} صف المشهد كاملًا: المكان الظاهر، الأشياء المهمة، مواضعها النسبية، وأي نص واضح. ابدأ بالأهم للمستخدم الكفيف.`,
    ask: `${base} أجب عن سؤال المستخدم اعتمادًا على الصورة فقط. إذا لم تكن المعلومة ظاهرة فقل ذلك. سؤال المستخدم: ${text}`,
    obstacles: `${base} افحص الصورة بحثًا عن أشياء قد تعيق الحركة مثل الكراسي والطاولات والصناديق والسلالم والحواف والأجسام على الأرض. اذكر موضع كل شيء بالنسبة للصورة (يمين/وسط/يسار وقريب/بعيد إذا أمكن). لا تقدم تعليمات ملاحة أو ضمانًا بعدم وجود خطر.`,
    currency: `${base} افحص العملة الظاهرة. حاول تحديد البلد والفئة والعملة اعتمادًا على العلامات المقروءة والوجهين إن ظهرا. إذا لم تكن الصورة كافية فاطلب تصوير الوجهين بوضوح. لا تؤكد القيمة عند الشك.`,
    product: `${base} اقرأ اسم المنتج والعلامة والمكونات والتحذيرات وتاريخ الصلاحية والباركود إن كانت ظاهرة. لا تخمّن أي بيانات غير مقروءة.`,
    colors: `${base} صف ألوان الأشياء والملابس بوضوح، واربط كل لون بالشيء الذي يظهر عليه. اذكر أن الإضاءة قد تؤثر في اللون.`,
    people: `${base} صف المشهد الاجتماعي بشكل عام فقط: عدد الأشخاص التقريبي، مواقعهم، ووضعياتهم الظاهرة. لا تتعرف على الهوية ولا تخمّن العمر أو المشاعر أو السمات الحساسة.`,
    place: `${base} اقرأ اللافتات والإشارات الظاهرة وحدد ما يمكن استنتاجه عن المداخل والمصاعد ومكاتب الاستقبال. لا تدّع معرفة موقع شيء خارج إطار الصورة.`,
  };
  return prompts[action] || prompts.vision;
}

async function moondream(action: string, image: string, text = "") {
  const key = process.env.MOONDREAM_API_KEY;
  if (!key) throw new Error("MOONDREAM_API_KEY_MISSING");
  const endpoint = action === "vision" ? "caption" : "query";
  const payload = action === "vision"
    ? { model: MODEL, image_url: image, length: "normal", stream: false }
    : { model: MODEL, image_url: image, question: promptFor(action, text) };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(`https://api.moondream.ai/v1/${endpoint}`, {
      method: "POST",
      headers: { "X-Moondream-Auth": key, "Content-Type": "application/json" },
      body: JSON.stringify(payload), signal: controller.signal,
    });
    const data: any = await response.json();
    if (!response.ok) {
      console.error("Moondream error", response.status, data?.error || data?.detail || "");
      throw new Error("MOONDREAM_UPSTREAM_ERROR");
    }
    return action === "vision" ? data.caption : data.answer;
  } finally { clearTimeout(timer); }
}

async function openai(action: string, text: string, image?: string) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("NO_VISION_PROVIDER");
  const prompts: Record<string, string> = {
    vision: promptFor("vision"), ocr: "استخرج النصوص الظاهرة كما هي وبالترتيب، ولا تخترع كلمات.",
    ask: promptFor("ask", text), obstacles: promptFor("obstacles"), currency: promptFor("currency"),
    product: promptFor("product"), colors: promptFor("colors"), people: promptFor("people"), place: promptFor("place"),
    simplify: "بسّط النص بالعربية مع الحفاظ على المعنى ثم اذكر أهم النقاط.",
    explain: "اشرح الموضوع بالعربية السهلة خطوة بخطوة مع مثال.",
    chat: "أنت مساعد سند العربي. أجب بوضوح واحترام واختصار مناسب.",
  };
  const content: any[] = [{ type: "input_text", text: `${prompts[action] || prompts.chat}\n\n${TEXT_ACTIONS.has(action) ? text : text ? `سؤال المستخدم: ${text}` : ""}` }];
  if (image) content.push({ type: "input_image", image_url: image, detail: "high" });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: process.env.OPENAI_MODEL || "gpt-4.1-mini", input: [{ role: "user", content }], store: false, max_output_tokens: 800 }),
      signal: controller.signal,
    });
    const data: any = await response.json();
    if (!response.ok) { console.error("OpenAI error", response.status); throw new Error("UPSTREAM_ERROR"); }
    return (data.output || []).flatMap((item: any) => item.content || []).filter((part: any) => part.type === "output_text").map((part: any) => part.text).join("\n").trim();
  } finally { clearTimeout(timer); }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") return send(res, 405, { error: "الطلب غير مسموح." });
  let body: any = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { return send(res, 400, { error: "بيانات الطلب غير مفهومة." }); } }
  if (!body || Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_BODY) return send(res, 413, { error: "حجم البيانات أكبر من المسموح." });
  const { action, text = "", image } = body;
  if (!IMAGE_ACTIONS.has(action) && !TEXT_ACTIONS.has(action)) return send(res, 400, { error: "الخدمة المطلوبة غير معروفة." });
  if (typeof text !== "string" || text.length > 12000) return send(res, 400, { error: "النص طويل جدًا أو غير صالح." });
  if (IMAGE_ACTIONS.has(action) && (typeof image !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(image) || image.length > MAX_BODY))
    return send(res, 400, { error: "الصورة غير صالحة أو حجمها كبير." });
  try {
    let answer = "";
    if (IMAGE_ACTIONS.has(action) && process.env.MOONDREAM_API_KEY) {
      try { answer = await moondream(action, image, text); }
      catch (error) {
        if (!process.env.OPENAI_API_KEY) throw error;
        console.warn("Falling back to OpenAI vision provider");
        answer = await openai(action, text, image);
      }
    } else {
      answer = await openai(action, text, image);
    }
    if (!answer) return send(res, 502, { error: "لم يصل رد واضح. حاول مرة أخرى." });
    return send(res, 200, { answer, provider: IMAGE_ACTIONS.has(action) && process.env.MOONDREAM_API_KEY ? "moondream" : "openai" });
  } catch (error) {
    console.error("Assistant request failed", error);
    const message = error instanceof Error && error.message === "NO_VISION_PROVIDER"
      ? (TEXT_ACTIONS.has(action)
          ? "أضف OPENAI_API_KEY في إعدادات Vercel لتفعيل المحادثة ومساعد التعلّم."
          : "أضف MOONDREAM_API_KEY أو OPENAI_API_KEY في إعدادات Vercel لتفعيل الرؤية.")
      : "تعذر إكمال الطلب الآن. تحقق من مفاتيح الخدمة والاتصال ثم حاول مرة أخرى.";
    return send(res, 502, { error: message });
  }
}
