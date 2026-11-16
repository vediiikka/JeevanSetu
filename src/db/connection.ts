/**
 * JeevanSetu MongoDB connection layer.
 *
 * Connection order:
 *   1. `MONGODB_URI` (Atlas, Docker Compose, or a local mongod) when reachable.
 *   2. Otherwise an embedded MongoDB server (`mongodb-memory-server`, a real
 *      mongod binary) so the application always runs on MongoDB.
 *
 * The client is cached on `globalThis` so Next.js hot reloads reuse one pool.
 */
import { MongoClient, type Collection as MongoCollection, type Db } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";

export type MongoMode = "uri" | "embedded";

export type MongoState = {
  client: MongoClient;
  db: Db;
  mode: MongoMode;
  database: string;
  uri: string;
  startedAt: string;
  warning?: string;
};

const globalForMongo = globalThis as typeof globalThis & {
  __jeevansetuMongo?: Promise<MongoState>;
  __jeevansetuMongoServer?: MongoMemoryServer;
};

async function connect(): Promise<MongoState> {
  const database = process.env.MONGODB_DATABASE?.trim() || "jeevansetu_db";
  const configuredUri = process.env.MONGODB_URI?.trim();
  let lastError = "MONGODB_URI is not set";

  if (configuredUri) {
    try {
      const client = new MongoClient(configuredUri, {
        serverSelectionTimeoutMS: 2500,
        connectTimeoutMS: 2500,
        socketTimeoutMS: 20000,
      });
      await client.connect();
      await client.db(database).command({ ping: 1 });
      return {
        client,
        db: client.db(database),
        mode: "uri",
        database,
        uri: configuredUri,
        startedAt: new Date().toISOString(),
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  // No reachable MONGODB_URI: start a real mongod for this process.
  const server = await MongoMemoryServer.create();
  globalForMongo.__jeevansetuMongoServer = server;
  const uri = server.getUri();
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  await client.db(database).command({ ping: 1 });

  return {
    client,
    db: client.db(database),
    mode: "embedded",
    database,
    uri,
    startedAt: new Date().toISOString(),
    warning: `MONGODB_URI unreachable (${lastError}). Started an embedded MongoDB instance instead — set MONGODB_URI to use your own deployment.`,
  };
}

/** Cached, hot-reload-safe connection promise. */
export function getMongo(): Promise<MongoState> {
  if (!globalForMongo.__jeevansetuMongo) {
    globalForMongo.__jeevansetuMongo = connect().catch((error) => {
      globalForMongo.__jeevansetuMongo = undefined;
      throw error;
    });
  }
  return globalForMongo.__jeevansetuMongo;
}

export async function getDb(): Promise<Db> {
  const state = await getMongo();
  return state.db;
}

export async function getCollection<T = Record<string, any>>(
  name: string,
): Promise<MongoCollection<Record<string, any>>> {
  const database = await getDb();
  void (null as unknown as T);
  return database.collection(name) as unknown as MongoCollection<Record<string, any>>;
}

export type MongoHealth = {
  ok: boolean;
  mode: MongoMode;
  database: string;
  latencyMs: number;
  warning?: string;
  error?: string;
};

/** Used by `/api/health` and the admin source panel. */
export async function mongoHealth(): Promise<MongoHealth> {
  const started = Date.now();
  try {
    const state = await getMongo();
    await state.db.command({ ping: 1 });
    return {
      ok: true,
      mode: state.mode,
      database: state.database,
      latencyMs: Date.now() - started,
      warning: state.warning,
    };
  } catch (error) {
    return {
      ok: false,
      mode: "embedded",
      database: process.env.MONGODB_DATABASE?.trim() || "jeevansetu_db",
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function closeMongo(): Promise<void> {
  const state = await getMongo().catch(() => null);
  if (state) await state.client.close();
  if (globalForMongo.__jeevansetuMongoServer) {
    await globalForMongo.__jeevansetuMongoServer.stop().catch(() => undefined);
    globalForMongo.__jeevansetuMongoServer = undefined;
  }
  globalForMongo.__jeevansetuMongo = undefined;
}
