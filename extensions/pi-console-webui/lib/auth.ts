import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { getConfig } from "./config";

const COOKIE = "pi_console_auth";
const token = (secret: string) => createHmac("sha256", secret).update("pi-console").digest("base64url");
export async function authenticated(): Promise<boolean> {
  const config = await getConfig();
  const value = (await cookies()).get(COOKIE)?.value;
  if (!value) return false;
  const expected = token(config.secret);
  const a = Buffer.from(value), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function loginValid(username: string, password: string): Promise<boolean> {
  const config = await getConfig();
  const a = Buffer.from(`${username}:${password}`), b = Buffer.from(`${config.username}:${config.password}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function authToken(): Promise<string> { return token((await getConfig()).secret); }
export { COOKIE };
