// Resolve the documented server/.env independently of the launch directory.
// Injected deployment environment always wins; preserve the legacy cwd .env fallback.
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
dotenv.config({ path: fileURLToPath(new URL('./.env', import.meta.url)) });
dotenv.config();
