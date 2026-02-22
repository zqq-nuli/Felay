import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
  AppConfig,
  InteractiveBotConfig,
  PushBotConfig,
  BotType,
  ReconnectSettings,
  PushSettings,
} from "@felay/shared";
import { defaultAppConfig } from "@felay/shared";
import { encrypt, decrypt, isEncrypted } from "./secretStore.js";

function getConfigPath(): string {
  return path.join(os.homedir(), ".felay", "config.json");
}

export class ConfigManager {
  private config: AppConfig = structuredClone(defaultAppConfig);

  async load(): Promise<void> {
    const configPath = getConfigPath();
    try {
      const raw = await fs.promises.readFile(configPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<AppConfig>;
      this.config = {
        bots: this.decryptBots({
          interactive: parsed.bots?.interactive ?? [],
          push: parsed.bots?.push ?? [],
        }),
        reconnect: { ...defaultAppConfig.reconnect, ...parsed.reconnect },
        push: { ...defaultAppConfig.push, ...parsed.push },
      };
    } catch {
      // File doesn't exist or is invalid – use defaults
      this.config = structuredClone(defaultAppConfig);
      await this.save();
    }
  }

  async save(): Promise<void> {
    const configPath = getConfigPath();
    await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
    // Encrypt secrets before writing to disk; in-memory config stays plaintext
    const toWrite: AppConfig = {
      ...this.config,
      bots: this.encryptBots(this.config.bots),
    };
    await fs.promises.writeFile(configPath, JSON.stringify(toWrite, null, 2), "utf8");
  }

  /* ── Secret encryption helpers ── */

  private decryptBots(bots: AppConfig["bots"]): AppConfig["bots"] {
    return {
      interactive: bots.interactive.map((b) => ({
        ...b,
        appSecret: decrypt(b.appSecret),
        encryptKey: b.encryptKey ? decrypt(b.encryptKey) : undefined,
      })),
      push: bots.push.map((b) => ({
        ...b,
        secret: b.secret ? decrypt(b.secret) : undefined,
      })),
    };
  }

  private encryptBots(bots: AppConfig["bots"]): AppConfig["bots"] {
    return {
      interactive: bots.interactive.map((b) => ({
        ...b,
        appSecret: isEncrypted(b.appSecret) ? b.appSecret : encrypt(b.appSecret),
        encryptKey: b.encryptKey
          ? isEncrypted(b.encryptKey) ? b.encryptKey : encrypt(b.encryptKey)
          : undefined,
      })),
      push: bots.push.map((b) => ({
        ...b,
        secret: b.secret
          ? isEncrypted(b.secret) ? b.secret : encrypt(b.secret)
          : undefined,
      })),
    };
  }

  getConfig(): AppConfig {
    return this.config;
  }

  getBots(): { interactive: InteractiveBotConfig[]; push: PushBotConfig[] } {
    return this.config.bots;
  }

  async saveBotInteractive(bot: InteractiveBotConfig): Promise<void> {
    const idx = this.config.bots.interactive.findIndex((b) => b.id === bot.id);
    if (idx >= 0) {
      this.config.bots.interactive[idx] = bot;
    } else {
      this.config.bots.interactive.push(bot);
    }
    await this.save();
  }

  async saveBotPush(bot: PushBotConfig): Promise<void> {
    const idx = this.config.bots.push.findIndex((b) => b.id === bot.id);
    if (idx >= 0) {
      this.config.bots.push[idx] = bot;
    } else {
      this.config.bots.push.push(bot);
    }
    await this.save();
  }

  async deleteBot(botType: BotType, botId: string): Promise<boolean> {
    if (botType === "interactive") {
      const before = this.config.bots.interactive.length;
      this.config.bots.interactive = this.config.bots.interactive.filter((b) => b.id !== botId);
      if (this.config.bots.interactive.length === before) return false;
    } else {
      const before = this.config.bots.push.length;
      this.config.bots.push = this.config.bots.push.filter((b) => b.id !== botId);
      if (this.config.bots.push.length === before) return false;
    }
    await this.save();
    return true;
  }

  getSettings(): { reconnect: ReconnectSettings; push: PushSettings } {
    return { reconnect: this.config.reconnect, push: this.config.push };
  }

  async saveSettings(config: AppConfig): Promise<void> {
    this.config = config;
    await this.save();
  }
}
