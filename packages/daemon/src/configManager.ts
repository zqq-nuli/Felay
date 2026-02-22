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
  InputSettings,
  DefaultBotSettings,
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
        defaults: { ...defaultAppConfig.defaults, ...parsed.defaults },
        input: { ...defaultAppConfig.input, ...parsed.input },
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
      // Clear default if the deleted bot was the default
      if (this.config.defaults.defaultInteractiveBotId === botId) {
        this.config.defaults.defaultInteractiveBotId = undefined;
      }
    } else {
      const before = this.config.bots.push.length;
      this.config.bots.push = this.config.bots.push.filter((b) => b.id !== botId);
      if (this.config.bots.push.length === before) return false;
      // Clear default if the deleted bot was the default
      if (this.config.defaults.defaultPushBotId === botId) {
        this.config.defaults.defaultPushBotId = undefined;
      }
    }
    await this.save();
    return true;
  }

  getSettings(): { reconnect: ReconnectSettings; push: PushSettings; input: InputSettings } {
    return {
      reconnect: this.config.reconnect,
      push: this.config.push,
      input: this.config.input ?? { enterRetryCount: 2, enterRetryInterval: 500 },
    };
  }

  async saveSettings(config: AppConfig): Promise<void> {
    // Preserve existing defaults if not provided (backward compatibility)
    this.config = {
      ...config,
      defaults: config.defaults ?? this.config.defaults,
    };
    await this.save();
  }

  /* ── Default bot helpers ── */

  getDefaults(): DefaultBotSettings {
    return this.config.defaults;
  }

  async setDefaultBot(botType: BotType, botId: string | null): Promise<boolean> {
    if (botType === "interactive") {
      if (botId !== null) {
        // Verify the bot exists
        const exists = this.config.bots.interactive.some((b) => b.id === botId);
        if (!exists) return false;
      }
      this.config.defaults.defaultInteractiveBotId = botId ?? undefined;
    } else {
      if (botId !== null) {
        const exists = this.config.bots.push.some((b) => b.id === botId);
        if (!exists) return false;
      }
      this.config.defaults.defaultPushBotId = botId ?? undefined;
    }
    await this.save();
    return true;
  }
}
