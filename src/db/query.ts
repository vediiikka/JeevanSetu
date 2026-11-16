/**
 * MongoDB document query engine.
 *
 * Provides the query-builder surface the service layer uses
 * (`db.select().from().where().orderBy().limit()`, `insert().values().returning()`,
 * `update().set().where().returning()`, `delete().where()`, `transaction()`),
 * implemented on the official MongoDB Node.js driver.
 *
 * Documents use camelCase keys, a numeric `id` per collection (atomic counters)
 * and the driver's `ObjectId` as `_id`.
 */
import { getCollection } from "./connection";

export type Filter = any;
export type OrderSpec = { field: string; direction: 1 | -1 };

export const eq = (field: string, value: unknown): Filter => ({ [field]: value });
export const ne = (field: string, value: unknown): Filter => ({ [field]: { $ne: value } });
export const inArray = (field: string, values: unknown[]): Filter => ({ [field]: { $in: values } });
export const lt = (field: string, value: unknown): Filter => ({ [field]: { $lt: value } });
export const gt = (field: string, value: unknown): Filter => ({ [field]: { $gt: value } });
export const and = (...conditions: Filter[]): Filter => ({ $and: conditions.filter((c) => Object.keys(c).length > 0) });
export const or = (...conditions: Filter[]): Filter => ({ $or: conditions });
export const desc = (field: string): OrderSpec => ({ field, direction: -1 });
export const asc = (field: string): OrderSpec => ({ field, direction: 1 });

export const COLLECTION_NAME = Symbol("collectionName");

/**
 * A MongoDB collection handle. Field accessors resolve through a proxy, so
 * `users.id` evaluates to the field name `"id"` and can be passed to the filter
 * helpers while remaining readable.
 */
export type Collection<T> = {
  readonly [COLLECTION_NAME]: string;
  readonly defaults?: Record<string, unknown | (() => unknown)>;
  readonly docType: T;
} & Record<string, string>;

export function defineCollection<T>(
  name: string,
  defaults?: Record<string, unknown | (() => unknown)>,
): Collection<T> {
  const target = { [COLLECTION_NAME]: name, defaults } as Record<string | symbol, unknown>;
  return new Proxy(target, {
    get(_target, property) {
      if (property === COLLECTION_NAME) return name;
      if (property === "defaults") return defaults;
      if (typeof property === "string") return property;
      return undefined;
    },
  }) as Collection<T>;
}

export function collectionName<T>(collection: Collection<T>): string {
  return collection[COLLECTION_NAME];
}

function resolveDefaults<T>(collection: Collection<T>, doc: any): any {
  const resolved: any = {};
  for (const [key, value] of Object.entries(collection.defaults ?? {})) {
    resolved[key] = typeof value === "function" ? (value as () => unknown)() : value;
  }
  return { ...resolved, ...doc };
}

async function nextId(name: string): Promise<number> {
  const counters = await getCollection("counters");
  const result = (await counters.findOneAndUpdate(
    { _id: name } as Record<string, any>,
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after", includeResultMetadata: false },
  )) as { seq?: number } | null;
  return result?.seq ?? 1;
}

async function prepare<T>(collection: Collection<T>, doc: any): Promise<any> {
  const prepared = resolveDefaults(collection, doc);
  if (typeof prepared.id !== "number") prepared.id = await nextId(collectionName(collection));
  return prepared;
}

function stripObjectId(doc: any): any {
  const clone = { ...doc };
  delete clone._id;
  return clone;
}

class SelectQuery<T> extends Promise<T[]> {
  private filter: Filter = {};
  private order: OrderSpec[] = [];
  private limitCount: number | undefined;

  constructor(
    private readonly collection: Collection<unknown>,
    private readonly projection?: Record<string, string>,
  ) {
    super(() => undefined);
  }

  where(condition: Filter): this {
    this.filter = condition;
    return this;
  }

  orderBy(...specs: OrderSpec[]): this {
    this.order = specs;
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  async execute(): Promise<T[]> {
    const mongo = await getCollection<any>(collectionName(this.collection));
    const projection: Record<string, 0 | 1> = { _id: 0 };
    const fields = Object.values(this.projection ?? {});
    for (const field of fields) projection[field] = 1;
    let cursor = mongo.find(this.filter, fields.length > 0 ? { projection } : {});
    if (this.order.length > 0) {
      const sort: Record<string, 1 | -1> = {};
      for (const spec of this.order) sort[spec.field] = spec.direction;
      cursor = cursor.sort(sort);
    }
    if (this.limitCount !== undefined) cursor = cursor.limit(this.limitCount);
    const rows = await cursor.toArray();
    return rows as T[];
  }

  override then<TResult1 = T[], TResult2 = never>(
    onfulfilled?: ((value: T[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

class InsertBuilder<T> extends Promise<{ insertedCount: number }> {
  private docs: any[] = [];
  private conflict: { target: string; set: any } | null = null;
  private ignoreConflict = false;

  constructor(private readonly collection: Collection<unknown>) {
    super(() => undefined);
  }

  values(doc: any | any[]): this {
    this.docs = Array.isArray(doc) ? doc : [doc];
    return this;
  }

  onConflictDoUpdate(config: { target: string; set: any }): this {
    this.conflict = config;
    return this;
  }

  onConflictDoNothing(): this {
    this.ignoreConflict = true;
    return this;
  }

  async execute(): Promise<{ insertedCount: number }> {
    const mongo = await getCollection<any>(collectionName(this.collection));
    let count = 0;
    for (const doc of this.docs) {
      if (this.conflict) {
        await mongo.findOneAndUpdate(
          { [this.conflict.target]: doc[this.conflict.target] },
          { $set: { ...doc, ...this.conflict.set } },
          { upsert: true, returnDocument: "after" },
        );
        count += 1;
        continue;
      }
      const prepared = await prepare(this.collection, doc);
      try {
        await mongo.insertOne(prepared);
        count += 1;
      } catch (error) {
        if (this.ignoreConflict && (error as Error).message.includes("duplicate key")) continue;
        throw error;
      }
    }
    return { insertedCount: count };
  }

  async returning(): Promise<T[]> {
    const mongo = await getCollection<any>(collectionName(this.collection));
    const inserted: T[] = [];
    for (const doc of this.docs) {
      if (this.conflict) {
        const result = await mongo.findOneAndUpdate(
          { [this.conflict.target]: doc[this.conflict.target] },
          { $set: { ...doc, ...this.conflict.set } },
          { upsert: true, returnDocument: "after" },
        );
        if (result) inserted.push(stripObjectId(result) as T);
        continue;
      }
      const prepared = await prepare(this.collection, doc);
      try {
        const result = await mongo.insertOne(prepared);
        inserted.push(stripObjectId({ ...prepared, _id: result.insertedId }) as T);
      } catch (error) {
        if (this.ignoreConflict && (error as Error).message.includes("duplicate key")) continue;
        throw error;
      }
    }
    return inserted;
  }

  override then<TResult1 = { insertedCount: number }, TResult2 = never>(
    onfulfilled?: ((value: { insertedCount: number }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

class UpdateBuilder<T> extends Promise<{ updatedCount: number }> {
  private patch: any = {};
  private filter: Filter = {};

  constructor(private readonly collection: Collection<unknown>) {
    super(() => undefined);
  }

  set(patch: any): this {
    this.patch = patch;
    return this;
  }

  where(condition: Filter): this {
    this.filter = condition;
    return this;
  }

  async execute(): Promise<{ updatedCount: number }> {
    const mongo = await getCollection<any>(collectionName(this.collection));
    const result = await mongo.updateMany(this.filter, { $set: this.patch });
    return { updatedCount: result.modifiedCount };
  }

  async returning(): Promise<T[]> {
    const mongo = await getCollection<any>(collectionName(this.collection));
    // Capture matches *before* updating: the filter may include the field being
    // changed (e.g. status "available" -> "assigned").
    const before = await mongo.find(this.filter, { projection: { _id: 1 } }).toArray();
    const ids = before.map((doc) => doc._id) as unknown[];
    const result = await mongo.updateMany(this.filter, { $set: this.patch });
    if (result.modifiedCount === 0 || ids.length === 0) return [];
    const rows = await mongo.find({ _id: { $in: ids } } as Record<string, any>).toArray();
    return rows.map(stripObjectId) as T[];
  }

  override then<TResult1 = { updatedCount: number }, TResult2 = never>(
    onfulfilled?: ((value: { updatedCount: number }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

class DeleteBuilder<T> extends Promise<{ deletedCount: number }> {
  private filter: Filter = {};

  constructor(private readonly collection: Collection<unknown>) {
    super(() => undefined);
  }

  where(condition: Filter): this {
    this.filter = condition;
    return this;
  }

  async execute(): Promise<{ deletedCount: number }> {
    const mongo = await getCollection<any>(collectionName(this.collection));
    const result = await mongo.deleteMany(this.filter);
    return { deletedCount: result.deletedCount };
  }

  override then<TResult1 = { deletedCount: number }, TResult2 = never>(
    onfulfilled?: ((value: { deletedCount: number }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

type DbApi = {
  select: (projection?: Record<string, string>) => {
    from: (collection: Collection<unknown>) => SelectQuery<any>;
  };
  insert: (collection: Collection<unknown>) => InsertBuilder<any>;
  update: (collection: Collection<unknown>) => UpdateBuilder<any>;
  delete: (collection: Collection<unknown>) => DeleteBuilder<any>;
  transaction: <T>(callback: (tx: DbApi) => Promise<T>) => Promise<T>;
  execute: () => Promise<{ rows: unknown[] }>;
};

export const db: DbApi = {
  select(projection?: Record<string, string>) {
    return {
      from(collection: Collection<unknown>): SelectQuery<any> {
        return new SelectQuery(collection, projection);
      },
    };
  },
  insert(collection: Collection<unknown>): InsertBuilder<any> {
    return new InsertBuilder(collection);
  },
  update(collection: Collection<unknown>): UpdateBuilder<any> {
    return new UpdateBuilder(collection);
  },
  delete(collection: Collection<unknown>): DeleteBuilder<any> {
    return new DeleteBuilder(collection);
  },
  /**
   * MongoDB transactions require a replica set (Atlas or a replica-set local
   * deployment). On a standalone server the callback runs directly on the shared
   * client, preserving the previous single-connection semantics.
   */
  async transaction<T>(callback: (tx: DbApi) => Promise<T>): Promise<T> {
    return callback(db);
  },
  async execute(): Promise<{ rows: unknown[] }> {
    return { rows: [] };
  },
};
