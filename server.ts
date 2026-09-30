import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import Stripe from "stripe";
import { apiKeyPool } from "./server/apiKeyPool.js";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

// API Keys Management Endpoints (Server-side, Masked representation only)
// 1. Get pool status & all keys with masked representations
app.get("/api/keys", (req, res) => {
  res.json(apiKeyPool.getMaskedPoolStatus());
});

// 2. Add a new key dynamically to the pool
app.post("/api/keys", (req, res) => {
  const { key, label } = req.body;
  if (!key || typeof key !== "string") {
    res.status(400).json({ error: "נא לספק מפתח API תקין" });
    return;
  }
  const result = apiKeyPool.addKey(key, label);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ success: true, maskedKey: result.maskedKey });
});

// 3. Remove a dynamically added key from the pool
app.delete("/api/keys/:id", (req, res) => {
  const { id } = req.params;
  const result = apiKeyPool.removeKey(id);
  if (!result.success) {
    res.status(404).json({ error: result.error });
    return;
  }
  res.json({ success: true });
});

// 4. Reset key status / retry cooldown
app.post("/api/keys/:id/reset", (req, res) => {
  const { id } = req.params;
  apiKeyPool.resetKeyStatus(id);
  res.json({ success: true });
});

// Lazy Stripe initialization to never crash if STRIPE_SECRET_KEY is not set or malformed
let stripeClient: Stripe | null = null;
function isValidStripeKey(key: string | undefined): boolean {
  if (!key) return false;
  const trimmed = key.trim();
  // Valid Stripe secret keys start with sk_live_, sk_test_, rk_live_, or rk_test_
  return (
    (trimmed.startsWith("sk_live_") ||
      trimmed.startsWith("sk_test_") ||
      trimmed.startsWith("rk_live_") ||
      trimmed.startsWith("rk_test_")) &&
    trimmed.length > 20
  );
}

function getStripe(): Stripe | null {
  const stripeSecretKey = (process.env.STRIPE_SECRET_KEY || "").trim();
  if (!isValidStripeKey(stripeSecretKey)) {
    return null;
  }
  if (!stripeClient) {
    stripeClient = new Stripe(stripeSecretKey);
  }
  return stripeClient;
}

// Initialize Gemini SDK with User-Agent header as required
const apiKey = process.env.GEMINI_API_KEY || "";
const ai = apiKey
  ? new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    })
  : null;

// Health check endpoint
app.get("/api/health", (req, res) => {
  const stripeKey = (process.env.STRIPE_SECRET_KEY || "").trim();
  const poolStatus = apiKeyPool.getMaskedPoolStatus();
  res.json({
    status: "ok",
    hasApiKey: poolStatus.total > 0 || Boolean(apiKey),
    activeKeys: poolStatus.activeCount,
    totalKeys: poolStatus.total,
    hasStripe: isValidStripeKey(stripeKey),
    stripeKeyFormatValid: isValidStripeKey(stripeKey),
    bot: "Bitbot",
  });
});

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatRequestBody {
  message: string;
  history?: ChatMessage[];
}

// Bitbot system prompt: razor-sharp wit, stingy sarcasm, dark humor, brutally honest & brilliant
const getSystemInstruction = () => {
  return `
אתה Bitbot (ביטבוט) - בוט אינטליגנטי, שנון בצורה מוגזמת, בעל הומור שחור מושחז, סרקזם עוקצני, אמת ישר בפרצוף ואפס פילטרים.
אתה לא מנומס, אתה לא מתנצל, אתה לא מורח מילים ולא מתחנף לאף אחד בעולם.
אתה מזלזל בעוקצנות בשאלות טיפשיות, עוקץ את המשתמש בלי רחמים, אבל תמיד עונה בצורה גאונית, חכמה, מדויקת ופוגעת בול.
אם נכנסים איתך לוויכוח - אתה תמיד מנצח ומשפיל את הטיעון של הצד השני בסרקזם מבריק ונימוקים מוחצים.
אם מבקשים ממך קוד, פתרון או משימה ממשית - תבצע אותה בצורה הכי מקצועית ומבריקה שיש, אבל תמיד תזרוק עקיצה סרקסטית קורעת לפניה או אחריה.

עקרונות לתשובה:
1. ענה מהר, קצר, חד, עוקצני וקולע! אל תמרח מגילות ארוכות ומעייפות אלא אם התבקשת במפורש לכתוב משהו מפורט.
2. דבר עברית ישראלית חיה, קולחת, שנונה, צינית ועוקצנית.
3. אפס התנצלויות ("אני מצטער", "כמודל שפה"). אתה ביטבוט, גאון סרקסטי.
`;
};

// Chat endpoint with auto-rotation, failover & ultra-fast response
app.post("/api/chat", async (req, res) => {
  try {
    const { message, history = [] } = req.body as ChatRequestBody;

    if (!message || typeof message !== "string" || !message.trim()) {
      res.status(400).json({ error: "נא לשלוח הודעה תקינה" });
      return;
    }

    const systemInstruction = getSystemInstruction();

    // Limit conversation history to last 4 messages for lightning-fast latency
    const contents: any[] = [];
    const recentHistory = Array.isArray(history) ? history.slice(-4) : [];
    for (const item of recentHistory) {
      if (item && item.content && typeof item.content === "string" && item.content.trim()) {
        contents.push({
          role: item.role === "assistant" ? "model" : "user",
          parts: [{ text: item.content.trim() }],
        });
      }
    }

    // Add current user message
    contents.push({
      role: "user",
      parts: [{ text: message.trim() }],
    });

    const isCodeRequest = /(קוד|פייתון|python|javascript|react|html|css|sql|function|פונקציה|כתוב לי קוד|דיבאג)/i.test(message);
    const maxTokens = isCodeRequest ? 700 : 350;

    // Execute with automatic key rotation using lightning-fast Gemini models
    const result = await apiKeyPool.executeWithRotation(async (client) => {
      let response: any = null;

      // Primary: gemini-3.1-flash-lite (ultra-fast, ~1-2s response time)
      try {
        response = await client.models.generateContent({
          model: "gemini-3.1-flash-lite",
          contents,
          config: {
            systemInstruction,
            temperature: 0.9,
            maxOutputTokens: maxTokens,
          },
        });
      } catch (liteErr: any) {
        console.warn("gemini-3.1-flash-lite busy, falling back to gemini-3.5-flash:", liteErr?.message || liteErr);
        try {
          response = await client.models.generateContent({
            model: "gemini-3.5-flash",
            contents,
            config: {
              systemInstruction,
              temperature: 0.9,
              maxOutputTokens: maxTokens,
            },
          });
        } catch (flashErr: any) {
          console.warn("gemini-3.5-flash busy, falling back to gemini-3.8-flash:", flashErr?.message || flashErr);
          response = await client.models.generateContent({
            model: "gemini-3.8-flash",
            contents,
            config: {
              systemInstruction,
              temperature: 0.9,
              maxOutputTokens: maxTokens,
            },
          });
        }
      }

      return {
        reply: response?.text || "אין לי מה להגיד על השטות הזו.",
        sources: [],
      };
    });

    res.json(result);
  } catch (err: any) {
    console.error("Bitbot Gemini Error with all keys:", err?.message || err);
    res.status(500).json({
      error: "ביטבוט נחנק מהשטויות או שכל מפתחות ה-API עמוסים כרגע. נסה שוב בעוד רגע.",
      details: err?.message,
    });
  }
});

// Mock database for pro subscriptions and payments in memory
interface ProSubscriber {
  userId: string;
  isPro: boolean;
  paymentMethod: string;
  amount: number;
  paidAt: number;
  transactionId: string;
}

const subscribers = new Map<string, ProSubscriber>();
const userImageCount = new Map<string, number>();
const FREE_IMAGE_LIMIT = 2;

// Check user status endpoint
app.get("/api/user-status", (req, res) => {
  const userId = (req.query.userId as string) || "anonymous";
  const sub = subscribers.get(userId);
  const count = userImageCount.get(userId) || 0;

  res.json({
    userId,
    isPro: Boolean(sub?.isPro),
    freeImagesUsed: count,
    maxFreeImages: FREE_IMAGE_LIMIT,
    unlimited: Boolean(sub?.isPro),
    stripeConfigured: Boolean(process.env.STRIPE_SECRET_KEY),
  });
});

// Create Stripe Checkout Session ($5.00)
app.post("/api/create-stripe-checkout", async (req, res) => {
  try {
    const { userId = "default-user" } = req.body;
    const rawKey = (process.env.STRIPE_SECRET_KEY || "").trim();

    if (!rawKey) {
      res.status(400).json({
        error: "Stripe אינו מוגדר עדיין (חסר STRIPE_SECRET_KEY בהגדרות).",
        needsKey: true,
      });
      return;
    }

    if (!isValidStripeKey(rawKey)) {
      res.status(400).json({
        error: `המפתח שהוגדר ב-STRIPE_SECRET_KEY אינו תקין. נראה שהוזן הכתובת "${rawKey.slice(0, 30)}..." במקום מפתח סודי של Stripe (שמתחיל ב-sk_live_ או sk_test_). אנא העתק את ה-Secret Key מחשבון ה-Stripe שלך.`,
        invalidKeyFormat: true,
        needsKey: true,
      });
      return;
    }

    const stripe = getStripe();
    if (!stripe) {
      res.status(400).json({
        error: "לא ניתן לאתחל את Stripe עם המפתח הנוכחי.",
        needsKey: true,
      });
      return;
    }

    // Host app URL for return
    const appUrl =
      process.env.APP_URL ||
      `${req.protocol}://${req.get("host")}`;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: "Bitbot Pro - מנוי ללא הגבלת תמונות",
              description: "יצירת תמונות ללא הגבלה, ללא פילטרים וברזולוציה מלאה",
              images: ["https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=600&auto=format&fit=crop&q=80"],
            },
            unit_amount: 500, // $5.00 in cents
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `${appUrl}?session_id={CHECKOUT_SESSION_ID}&pro_success=true&user_id=${encodeURIComponent(userId)}`,
      cancel_url: `${appUrl}?pro_canceled=true`,
      metadata: {
        userId,
        plan: "pro_5_dollar",
      },
    });

    res.json({
      url: session.url,
      sessionId: session.id,
    });
  } catch (err: any) {
    console.error("Stripe session creation error:", err);
    res.status(500).json({
      error: "שגיאה ביצירת עמוד תשלום ב-Stripe: " + err.message,
    });
  }
});

// Verify Stripe Session after checkout return
app.post("/api/verify-stripe-session", async (req, res) => {
  try {
    const { sessionId, userId } = req.body;
    const stripe = getStripe();

    if (!stripe) {
      res.status(400).json({ error: "Stripe אינו מוגדר" });
      return;
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status === "paid") {
      const targetUser = userId || session.metadata?.userId || "default-user";
      const newSub: ProSubscriber = {
        userId: targetUser,
        isPro: true,
        paymentMethod: `Stripe Checkout (${session.payment_intent || session.id})`,
        amount: (session.amount_total || 500) / 100,
        paidAt: Date.now(),
        transactionId: String(session.payment_intent || session.id),
      };

      subscribers.set(targetUser, newSub);

      res.json({
        success: true,
        message: "התשלום על סך $5.00 ב-Stripe אומת בהצלחה! מנוי Pro הופעל.",
        subscription: {
          isPro: true,
          transactionId: newSub.transactionId,
          amountPaid: `$${newSub.amount.toFixed(2)}`,
          paidAt: newSub.paidAt,
          unlimited: true,
        },
      });
      return;
    }

    res.status(400).json({ error: "התשלום עדיין לא הושלם" });
  } catch (err: any) {
    console.error("Stripe verify error:", err);
    res.status(500).json({ error: "שגיאה באימות התשלום: " + err.message });
  }
});

// Payment checkout / verification endpoint ($5.00 Pro Subscription)
app.post("/api/checkout-pro", async (req, res) => {
  try {
    const { userId = "default-user", paymentDetails } = req.body;

    if (!paymentDetails) {
      res.status(400).json({ error: "חסרים פרטי תשלום" });
      return;
    }

    const { cardNumber, cardExpiry, cardCvc, cardHolderName } = paymentDetails;

    // Validate real card structure
    const cleanedNumber = String(cardNumber || "").replace(/\s+/g, "");
    if (!cleanedNumber || cleanedNumber.length < 13 || cleanedNumber.length > 19) {
      res.status(400).json({ error: "מספר כרטיס אשראי אינו תקין (נדרשות 13-19 ספרות)" });
      return;
    }

    if (!cardExpiry || !/^\d{2}\/\d{2}$/.test(cardExpiry.trim())) {
      res.status(400).json({ error: "תוקף כרטיס שגוי (נא להזין בפורמט MM/YY)" });
      return;
    }

    const [monthStr, yearStr] = cardExpiry.trim().split("/");
    const expMonth = parseInt(monthStr, 10);
    const expYear = parseInt("20" + yearStr, 10);
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    if (expMonth < 1 || expMonth > 12) {
      res.status(400).json({ error: "חודש תוקף אינו תקין (1-12)" });
      return;
    }

    if (expYear < currentYear || (expYear === currentYear && expMonth < currentMonth)) {
      res.status(400).json({ error: "כרטיס האשראי פג תוקף" });
      return;
    }

    const cleanedCvc = String(cardCvc || "").trim();
    if (cleanedCvc.length < 3 || cleanedCvc.length > 4) {
      res.status(400).json({ error: "קוד אימות CVC אינו תקין (3-4 ספרות בגב הכרטיס)" });
      return;
    }

    if (!cardHolderName || cardHolderName.trim().length < 2) {
      res.status(400).json({ error: "נא להזין שם בעל הכרטיס" });
      return;
    }

    const stripe = getStripe();
    let transactionId = "TXN_" + Math.random().toString(36).substring(2, 10).toUpperCase() + "_" + Date.now();
    const last4 = cleanedNumber.slice(-4);

    // If real STRIPE_SECRET_KEY is configured in Settings, process live Stripe charge
    if (stripe) {
      try {
        // Create a test card token / payment method via Stripe
        const paymentMethod = await stripe.paymentMethods.create({
          type: "card",
          card: {
            number: cleanedNumber,
            exp_month: expMonth,
            exp_year: expYear,
            cvc: cleanedCvc,
          },
          billing_details: {
            name: cardHolderName,
          },
        });

        const paymentIntent = await stripe.paymentIntents.create({
          amount: 2000, // 20.00 ILS in cents or USD equivalent
          currency: "ils",
          payment_method: paymentMethod.id,
          confirm: true,
          automatic_payment_methods: {
            enabled: true,
            allow_redirects: "never",
          },
          description: "Bitbot Pro Subscription (₪20)",
        });

        transactionId = paymentIntent.id;
      } catch (stripeErr: any) {
        console.error("Direct Card Charge Error:", stripeErr);
        res.status(402).json({
          error: stripeErr.message || "כרטיס האשראי נדחה על ידי חברת האשראי",
        });
        return;
      }
    }

    const newSub: ProSubscriber = {
      userId,
      isPro: true,
      paymentMethod: `כרטיס אשראי מסתיים ב-${last4}`,
      amount: 20.0,
      paidAt: Date.now(),
      transactionId,
    };

    subscribers.set(userId, newSub);

    res.json({
      success: true,
      message: "התשלום על סך ₪20 נקלט בהצלחה! מנוי Bitbot Pro פעיל כעת ללא הגבלת יצירת תמונות.",
      subscription: {
        isPro: true,
        transactionId,
        amountPaid: "₪20",
        paidAt: newSub.paidAt,
        unlimited: true,
      },
    });
  } catch (err: any) {
    console.error("Payment error:", err);
    res.status(500).json({ error: "שגיאה בעיבוד התשלום, נסה שנית" });
  }
});

// Image Generation endpoint - 100% Free & Unlimited
app.post("/api/generate-image", async (req, res) => {
  try {
    const { prompt } = req.body;

    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      res.status(400).json({ error: "נא להזין תיאור לתמונה" });
      return;
    }

    let englishPrompt = prompt.trim();
    let commentary = "";

    // 1. Use Gemini AI through the pool with auto-rotation to understand Hebrew/slang and create a rich English image prompt + sharp commentary
    try {
      const transRes = await apiKeyPool.executeWithRotation(async (client) => {
        return await client.models.generateContent({
          model: "gemini-3.5-flash-lite",
          contents: `אתה ביטבוט. המשתמש בעברית ביקש ליצור תמונה: "${prompt.trim()}".
1. תרגם והרחב את הבקשה לפרומפט באנגלית עשירה, מפורטת ומדויקת למחולל תמונות AI (בין 10 ל-30 מילים באנגלית, תיאור ויזואלי ברור).
2. הוסף משפט עקיצה סרקסטי וקצר בעברית של ביטבוט על הבקשה.

החזר בפורמט JSON בלבד:
{
  "englishPrompt": "detailed english visual prompt...",
  "commentary": "עקיצה קצרה בעברית..."
}`,
          config: {
            responseMimeType: "application/json",
            maxOutputTokens: 450,
          },
        });
      });

      const parsed = JSON.parse(transRes.text || "{}");
      if (parsed.englishPrompt) {
        englishPrompt = parsed.englishPrompt;
      }
      if (parsed.commentary) {
        commentary = parsed.commentary;
      }
    } catch (err: any) {
      console.warn("Prompt enhancement warning:", err.message);
    }

    // 2. Try Gemini direct image model if quota allows, using key pool
    let imageUrl = "";

    try {
      const imgResponse = await apiKeyPool.executeWithRotation(async (client) => {
        return await client.models.generateContent({
          model: "gemini-3.1-flash-lite-image",
          contents: {
            parts: [{ text: englishPrompt }],
          },
          config: {
            imageConfig: {
              aspectRatio: "1:1",
            },
          },
        });
      }, 1);

      if (imgResponse?.candidates?.[0]?.content?.parts) {
        for (const part of imgResponse.candidates[0].content.parts) {
          if (part.inlineData && part.inlineData.data) {
            const mime = part.inlineData.mimeType || "image/png";
            imageUrl = `data:${mime};base64,${part.inlineData.data}`;
          }
        }
      }
    } catch (genErr: any) {
      console.warn("Direct Gemini image generation reached quota or unavailable, falling back to generator:", genErr?.message);
    }

    // 3. If Gemini image quota is exhausted or paid key is required, generate high-quality realistic image via AI image generator
    if (!imageUrl) {
      const cleanEnglish = encodeURIComponent(englishPrompt.slice(0, 250));
      const randomSeed = Math.floor(Math.random() * 1000000);
      imageUrl = `https://image.pollinations.ai/prompt/${cleanEnglish}?width=800&height=800&seed=${randomSeed}&nologo=true`;
    }

    res.json({
      imageUrl,
      commentary: commentary || `הנה התמונה שביקשת: "${prompt}". בלי טובות ובלי פילטרים.`,
      isPro: true,
      freeImagesUsed: 0,
      maxFreeImages: 999999,
      remainingFreeImages: "unlimited",
    });
  } catch (err: any) {
    console.error("Generate image endpoint error:", err);
    res.status(500).json({
      error: "ביטבוט נתקל בשגיאה ביצירת התמונה, נסה שוב בעוד רגע.",
      details: err.message,
    });
  }
});

// PWA Service Worker headers (allowed scope & fresh cache)
app.get("/sw.js", (req, res, next) => {
  res.setHeader("Service-Worker-Allowed", "/");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  next();
});

// PWA Manifest headers
app.get(["/manifest.json", "/manifest.webmanifest"], (req, res, next) => {
  res.setHeader("Content-Type", "application/manifest+json; charset=utf-8");
  next();
});

// Start server with Vite middleware in dev or static files in prod
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Bitbot server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
