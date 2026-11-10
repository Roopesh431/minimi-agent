import "dotenv/config";
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { initializeSchema } from "./schema";

const dbPath = process.env.DB_PATH || "./data/minimi.db";

const absolutePath = path.resolve(process.cwd(), dbPath);

fs.mkdirSync(path.dirname(absolutePath), {
  recursive: true
});

const db = new Database(absolutePath);

// Database configuration
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

// Initialize tables
initializeSchema(db);

console.log("SQLite database initialized:", absolutePath);

export default db;
