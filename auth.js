import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);
const secret = process.env.SESSION_SECRET || "development-only-change-this-secret";

export const normalizeName = (value) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase("pt-PT");

export async function hashPin(pin, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = await scrypt(String(pin), salt, 64);
  return { salt, hash: Buffer.from(hash).toString("hex") };
}

export async function verifyPin(pin, salt, expected) {
  const { hash } = await hashPin(pin, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(expected, "hex"));
}

export function createSession(user) {
  const body = Buffer.from(JSON.stringify({ id: user.id, role: user.role, exp: Date.now() + 30 * 864e5 })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function readSession(token) {
  if (!token?.includes(".")) return null;
  const [body, signature] = token.split(".");
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const data = JSON.parse(Buffer.from(body, "base64url").toString());
  return data.exp > Date.now() ? data : null;
}
