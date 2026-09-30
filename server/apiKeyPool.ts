// Server-side Key Pool and Rotation Manager for Bitbot
// Supports unlimited user-provided keys, auto-rotation, retry with exponential backoff,
// rate limit / quota exhaustion cooldowns, and secure masked representation.

import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

export type KeyStatus = "active" | "rate_limited" | "error" | "disabled";

export interface ManagedKeyInfo {
  id: string;
  source: "env" | "config" | "dynamic";
  maskedKey: string;
  status: KeyStatus;
  successCount: number;
  failureCount: number;
  rateLimitHits: number;
  lastUsedAt: number | null;
  lastErrorAt: number | null;
  lastErrorMessage?: string;
  cooldownUntil: number | null;
  addedAt: number;
  label?: string;
}

interface InternalKeyItem {
  id: string;
  key: string;
  source: "env" | "config" | "dynamic";
  label: string;
  status: KeyStatus;
  successCount: number;
  failureCount: number;
  rateLimitHits: number;
  lastUsedAt: number | null;
  lastErrorAt: number | null;
  lastErrorMessage?: string;
  cooldownUntil: number | null;
  addedAt: number;
  client?: GoogleGenAI;
}

class ApiKeyPoolManager {
  private keys: InternalKeyItem[] = [];
  private currentIndex: number = 0;
  private readonly configFilePath: string;
  private readonly rateLimitCooldownMs: number = 60 * 1000; // 60 seconds backoff for rate limit

  constructor() {
    this.configFilePath = path.join(process.cwd(), "api-keys.json");
    this.initializePool();
  }

  // Mask key safely (e.g. AIzaSy...ABCD -> AIza...ABCD)
  public static maskKey(key: string): string {
    const trimmed = (key || "").trim();
    if (trimmed.length <= 8) {
      return "****";
    }
    const prefix = trimmed.slice(0, 4);
    const suffix = trimmed.slice(-4);
    return `${prefix}...${suffix}`;
  }

  // Load keys from environment variables and optional configuration file
  private initializePool() {
    this.keys = [];

    // 1. Primary GEMINI_API_KEY
    const primary = (process.env.GEMINI_API_KEY || "").trim();
    if (primary && !primary.startsWith("MY_GEMINI_API_KEY")) {
      this.addInternalKey(primary, "env", "מפתח ראשי (GEMINI_API_KEY)");
    }

    // 2. Comma/newline-separated list: GEMINI_API_KEYS
    const multiple = (process.env.GEMINI_API_KEYS || "").trim();
    if (multiple) {
      const splitKeys = multiple.split(/[\r\n,;]+/).map((k) => k.trim()).filter(Boolean);
      splitKeys.forEach((k, idx) => {
        if (!this.hasKey(k)) {
          this.addInternalKey(k, "env", `מפתח סביבה #${idx + 1}`);
        }
      });
    }

    // 3. Sequenced environment variables: GEMINI_API_KEY_1, GEMINI_API_KEY_2, etc.
    for (let i = 1; i <= 50; i++) {
      const k = (process.env[`GEMINI_API_KEY_${i}`] || "").trim();
      if (k && !this.hasKey(k)) {
        this.addInternalKey(k, "env", `מפתח סביבה GEMINI_API_KEY_${i}`);
      }
    }

    // 4. Load persisted keys from api-keys.json if present
    this.loadFromConfigFile();
  }

  private hasKey(rawKey: string): boolean {
    return this.keys.some((k) => k.key === rawKey.trim());
  }

  private addInternalKey(rawKey: string, source: "env" | "config" | "dynamic", label: string): InternalKeyItem {
    const trimmed = rawKey.trim();
    const id = `key_${Math.random().toString(36).substring(2, 9)}_${Date.now().toString(36)}`;
    const item: InternalKeyItem = {
      id,
      key: trimmed,
      source,
      label,
      status: "active",
      successCount: 0,
      failureCount: 0,
      rateLimitHits: 0,
      lastUsedAt: null,
      lastErrorAt: null,
      cooldownUntil: null,
      addedAt: Date.now(),
      client: new GoogleGenAI({
        apiKey: trimmed,
        httpOptions: {
          headers: { "User-Agent": "aistudio-build" },
        },
      }),
    };
    this.keys.push(item);
    return item;
  }

  private loadFromConfigFile() {
    try {
      if (fs.existsSync(this.configFilePath)) {
        const data = JSON.parse(fs.readFileSync(this.configFilePath, "utf8"));
        if (Array.isArray(data)) {
          for (const entry of data) {
            const rawKey = (entry.key || "").trim();
            if (rawKey && !this.hasKey(rawKey)) {
              this.addInternalKey(rawKey, "config", entry.label || "מפתח מקובץ הגדרות");
            }
          }
        }
      }
    } catch (e) {
      console.warn("Failed to read api-keys.json config file:", (e as any).message);
    }
  }

  private saveToConfigFile() {
    try {
      const persisted = this.keys
        .filter((k) => k.source === "config" || k.source === "dynamic")
        .map((k) => ({
          key: k.key,
          label: k.label,
          addedAt: k.addedAt,
        }));
      fs.writeFileSync(this.configFilePath, JSON.stringify(persisted, null, 2), "utf8");
    } catch (e) {
      console.warn("Failed to write api-keys.json:", (e as any).message);
    }
  }

  // Check cooldowns and reactivate keys whose cooldown has expired
  private updateCooldownStatuses() {
    const now = Date.now();
    for (const item of this.keys) {
      if (item.status === "rate_limited" && item.cooldownUntil && now >= item.cooldownUntil) {
        item.status = "active";
        item.cooldownUntil = null;
      }
    }
  }

  // Get next available active key with round-robin rotation
  public getNextActiveKey(): InternalKeyItem | null {
    this.updateCooldownStatuses();

    const total = this.keys.length;
    if (total === 0) return null;

    // Search starting from currentIndex
    for (let attempt = 0; attempt < total; attempt++) {
      const idx = (this.currentIndex + attempt) % total;
      const candidate = this.keys[idx];
      if (candidate.status === "active") {
        this.currentIndex = (idx + 1) % total;
        candidate.lastUsedAt = Date.now();
        return candidate;
      }
    }

    // If no active key, check if any rate-limited key has least remaining cooldown
    const rateLimited = this.keys.filter((k) => k.status === "rate_limited");
    if (rateLimited.length > 0) {
      rateLimited.sort((a, b) => (a.cooldownUntil || 0) - (b.cooldownUntil || 0));
      return rateLimited[0]; // fallback
    }

    return null;
  }

  // Record operation success for key
  public markSuccess(id: string) {
    const item = this.keys.find((k) => k.id === id);
    if (item) {
      item.successCount++;
      item.rateLimitHits = 0;
      item.status = "active";
      item.cooldownUntil = null;
    }
  }

  // Record failure / rate-limit and set cooldown
  public markFailure(id: string, error: any) {
    const item = this.keys.find((k) => k.id === id);
    if (!item) return;

    const errMsg = (error?.message || String(error)).toLowerCase();
    const isRateLimit =
      errMsg.includes("429") ||
      errMsg.includes("resource_exhausted") ||
      errMsg.includes("quota") ||
      errMsg.includes("rate limit") ||
      errMsg.includes("exceeded your current quota");

    item.failureCount++;
    item.lastErrorAt = Date.now();
    item.lastErrorMessage = error?.message || "Unknown error";

    if (isRateLimit) {
      item.rateLimitHits++;
      item.status = "rate_limited";
      // If only 1 key exists in pool, use minimal 5s cooldown to avoid long lockouts
      const backoffSec = this.keys.length <= 1 ? 5 : Math.min(item.rateLimitHits, 3) * 15;
      item.cooldownUntil = Date.now() + backoffSec * 1000;
    } else if (errMsg.includes("api_key_invalid") || errMsg.includes("invalid api key") || errMsg.includes("403")) {
      item.status = "error";
    }
  }

  // Execute Gemini request with intelligent automatic key rotation and retry
  public async executeWithRotation<T>(
    operation: (client: GoogleGenAI, keyInfo: InternalKeyItem) => Promise<T>,
    maxRetries: number = 3
  ): Promise<T> {
    const totalKeys = this.keys.length;
    if (totalKeys === 0) {
      throw new Error("לא מוגדרים מפתחות API פעילים במערכת.");
    }

    const maxAttempts = Math.min(Math.max(maxRetries, totalKeys), 8);
    const attemptedKeyIds = new Set<string>();
    let lastError: any = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const keyItem = this.getNextActiveKey();
      if (!keyItem) {
        break;
      }

      attemptedKeyIds.add(keyItem.id);

      if (!keyItem.client) {
        keyItem.client = new GoogleGenAI({
          apiKey: keyItem.key,
          httpOptions: { headers: { "User-Agent": "aistudio-build" } },
        });
      }

      try {
        const result = await operation(keyItem.client, keyItem);
        this.markSuccess(keyItem.id);
        return result;
      } catch (err: any) {
        lastError = err;
        this.markFailure(keyItem.id, err);

        // Check if there are other keys available
        const activeAvailable = this.keys.some((k) => k.status === "active" && !attemptedKeyIds.has(k.id));
        if (activeAvailable) {
          // Brief exponential backoff before rotating to next key (150ms * attempt)
          await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
          continue;
        }

        // If we exhausted fresh active keys, pause briefly before retrying
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    throw lastError || new Error("כל מפתחות ה-API נכשלו או הגיעו למגבלת הקצב (Rate Limit).");
  }

  // Public safe info for UI dashboard (NEVER exposes raw keys!)
  public getMaskedPoolStatus(): {
    total: number;
    activeCount: number;
    rateLimitedCount: number;
    errorCount: number;
    keys: ManagedKeyInfo[];
  } {
    this.updateCooldownStatuses();
    const masked = this.keys.map((k) => ({
      id: k.id,
      source: k.source,
      maskedKey: ApiKeyPoolManager.maskKey(k.key),
      status: k.status,
      successCount: k.successCount,
      failureCount: k.failureCount,
      rateLimitHits: k.rateLimitHits,
      lastUsedAt: k.lastUsedAt,
      lastErrorAt: k.lastErrorAt,
      lastErrorMessage: k.lastErrorMessage,
      cooldownUntil: k.cooldownUntil,
      addedAt: k.addedAt,
      label: k.label,
    }));

    return {
      total: masked.length,
      activeCount: masked.filter((k) => k.status === "active").length,
      rateLimitedCount: masked.filter((k) => k.status === "rate_limited").length,
      errorCount: masked.filter((k) => k.status === "error" || k.status === "disabled").length,
      keys: masked,
    };
  }

  // Add new key dynamically
  public addKey(rawKey: string, label?: string): { success: boolean; maskedKey?: string; error?: string } {
    const trimmed = (rawKey || "").trim();
    if (!trimmed || trimmed.length < 15) {
      return { success: false, error: "מפתח API לא תקין (קצר מדי או ריק)" };
    }

    if (this.hasKey(trimmed)) {
      return { success: false, error: "מפתח זה כבר קיים במאגר" };
    }

    const item = this.addInternalKey(trimmed, "dynamic", label || `מפתח נוסף #${this.keys.length + 1}`);
    this.saveToConfigFile();
    return {
      success: true,
      maskedKey: ApiKeyPoolManager.maskKey(trimmed),
    };
  }

  // Remove key dynamically
  public removeKey(id: string): { success: boolean; error?: string } {
    const idx = this.keys.findIndex((k) => k.id === id);
    if (idx === -1) {
      return { success: false, error: "מפתח לא נמצא" };
    }

    const removed = this.keys.splice(idx, 1)[0];
    if (removed.source !== "env") {
      this.saveToConfigFile();
    }
    return { success: true };
  }

  // Test a specific key or reset status
  public resetKeyStatus(id: string) {
    const item = this.keys.find((k) => k.id === id);
    if (item) {
      item.status = "active";
      item.cooldownUntil = null;
      item.lastErrorMessage = undefined;
    }
  }
}

export const apiKeyPool = new ApiKeyPoolManager();
