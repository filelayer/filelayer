import { openDb } from './db.mjs';
import { openStorage } from './storage.mjs';
import { createApp } from './app.mjs';

const env = process.env;
const db = await openDb(env.DATABASE_URL);
const storage = openStorage(env);
const app = createApp({ db, storage, baseUrl: env.BASE_URL, adminToken: env.ADMIN_TOKEN });
const port = Number(env.PORT ?? 3000);
app.listen(port, '127.0.0.1', () => console.log(`listening on ${port}`));
