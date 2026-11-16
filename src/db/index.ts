/**
 * JeevanSetu database entrypoint.
 *
 * MongoDB is the only application database. `getCollection()` returns a cached
 * official-driver collection; `db` is the document query engine used by the
 * service layer (see `src/db/query.ts`).
 */
export {
  getMongo,
  getDb,
  getCollection,
  mongoHealth,
  closeMongo,
  type MongoState,
  type MongoMode,
  type MongoHealth,
} from "./connection";
export {
  db,
  eq,
  ne,
  inArray,
  lt,
  gt,
  and,
  or,
  desc,
  asc,
  defineCollection,
  type Collection,
  type Filter,
  type OrderSpec,
} from "./query";
