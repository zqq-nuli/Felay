import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const ALGORITHM = "aes-256-gcm";
const KEY_FILE = ".master-key";
const ENC_PREFIX = "enc:";
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // GCM recommended
const TAG_LENGTH = 16; // GCM auth tag

function getKeyPath(): string {
  return path.join(os.homedir(), ".felay", KEY_FILE);
}

function ensureMasterKey(): Buffer {
  const keyPath = getKeyPath();

  // Try to read existing key
  try {
    const hex = fs.readFileSync(keyPath, "utf8").trim();
    return Buffer.from(hex, "hex");
  } catch {
    // Generate new key
    const key = crypto.randomBytes(KEY_LENGTH);
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, key.toString("hex"), { mode: 0o600 });

    // On Windows, restrict file permissions via icacls (best-effort)
    if (process.platform === "win32") {
      try {
        const username = process.env.USERNAME ?? process.env.USER ?? "";
        execFileSync("icacls", [
          keyPath,
          "/inheritance:r",
          "/grant:r",
          `${username}:F`,
        ], { stdio: "ignore" });
      } catch {
        // best-effort
      }
    }

    return key;
  }
}

let masterKey: Buffer | null = null;

function getKey(): Buffer {
  if (!masterKey) {
    masterKey = ensureMasterKey();
  }
  return masterKey;
}

/** Encrypt a plaintext string. Returns "enc:base64..." prefixed value. */
export function encrypt(plaintext: string): string {
  if (!plaintext) return plaintext;
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // Format: enc:base64(iv + tag + ciphertext)
  const combined = Buffer.concat([iv, tag, encrypted]);
  return ENC_PREFIX + combined.toString("base64");
}

/** Decrypt a value. Plaintext values (without "enc:" prefix) are returned as-is. */
export function decrypt(value: string): string {
  if (!value || !value.startsWith(ENC_PREFIX)) return value;
  const key = getKey();
  const combined = Buffer.from(value.slice(ENC_PREFIX.length), "base64");
  const iv = combined.subarray(0, IV_LENGTH);
  const tag = combined.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext).toString("utf8") + decipher.final("utf8");
}

/** Check if a value is already encrypted. */
export function isEncrypted(value: string): boolean {
  return value.startsWith(ENC_PREFIX);
}
