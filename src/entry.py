from workers import WorkerEntrypoint, Response
import json
from ollamafreeapi import OllamaFreeAPI

class Default(WorkerEntrypoint):
    async def fetch(self, request):
        # 1. التعامل مع طلبات CORS الأولية
        if request.method == "OPTIONS":
            return Response(
                "",
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "POST, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type",
                },
            )

        # 2. التأكد من أن الطلب هو POST
        if request.method != "POST":
            return Response(
                json.dumps({"error": "Method not allowed. Use POST."}),
                status=405,
                headers={"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"},
            )

        try:
            # 3. قراءة بيانات الطلب
            body = await request.json()
            prompt = body.get("prompt", "")
            model = body.get("model", "llama3.2:3b") # يمكن تغيير النموذج الافتراضي

            if not prompt:
                return Response(
                    json.dumps({"error": "Prompt is required"}),
                    status=400,
                    headers={"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"},
                )

            # 4. استخدام OllamaFreeAPI للحصول على الرد
            client = OllamaFreeAPI()
            reply = client.chat(model=model, prompt=prompt)

            # 5. إرجاع الرد بنجاح
            return Response(
                json.dumps({"reply": reply}),
                headers={"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"},
            )

        except Exception as e:
            # 6. التعامل مع أي أخطاء محتملة
            return Response(
                json.dumps({"error": str(e)}),
                status=500,
                headers={"Content-Type": "application/json", "Access-Control-Allow-Origin": "*"},
          )
