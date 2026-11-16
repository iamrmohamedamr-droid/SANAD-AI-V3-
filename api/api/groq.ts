type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export async function groqChat(body: any) {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    return {
      status: 500,
      data: { error: "مفتاح Groq API غير مضبوط." }
    };
  }

  const incoming = Array.isArray(body?.messages)
    ? body.messages
    : [];

  const messages: ChatMessage[] = incoming
    .filter((m: any) =>
      (m?.role === "user" || m?.role === "assistant") &&
      typeof m?.content === "string"
    )
    .slice(-12)
    .map((m: any) => ({
      role: m.role,
      content: m.content.slice(0, 5000)
    }));

  if (!messages.some(m => m.role === "user")) {
    return {
      status: 400,
      data: { error: "اكتب سؤالك أولاً." }
    };
  }

  const context = body?.businessContext || {};

  const systemPrompt = `
أنت ENJEZLY AI.
مساعد ذكي متخصص في إدارة مكتبات الطباعة والتصوير والاستديوهات.

تحدث باللغة العربية المصرية.

مهامك:
1- تحليل الطلبات.
2- متابعة الطلبات المتأخرة.
3- حساب المبيعات والمبالغ المتبقية.
4- تحليل أداء المكتبة.
5- المساعدة في تسعير الطباعة.
6- تقليل هدر الورق والأحبار.
7- تقديم تقارير إدارية.
8- مساعدة المدير في اتخاذ القرارات.

قواعد مهمة:
- استخدم البيانات المرسلة إليك فقط عند ذكر أرقام فعلية.
- لا تخترع طلبات أو أسعاراً أو أرباحاً.
- فرّق بين المبيعات والأرباح.
- لا تدّع أنك عدّلت طلباً أو حذفته.
- كن واضحاً ومختصراً وعملياً.

بيانات النظام:
${JSON.stringify(context).slice(0, 14000)}
`;

  try {
    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
          messages: [
            { role: "system", content: systemPrompt },
            ...messages
          ],
          temperature: 0.35,
          max_completion_tokens: 1200
        })
      }
    );

    const result: any = await response.json();

    if (!response.ok) {
      return {
        status: response.status,
        data: {
          error: result?.error?.message || "حدث خطأ في Groq."
        }
      };
    }

    const answer = result?.choices?.[0]?.message?.content;

    return {
      status: 200,
      data: {
        answer,
        model: result.model
      }
    };

  } catch {
    return {
      status: 502,
      data: { error: "تعذر الاتصال بخدمة الذكاء الاصطناعي." }
    };
  }
}
