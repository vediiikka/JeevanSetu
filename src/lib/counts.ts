import { getCollection } from "@/db";
import { COLLECTION_NAME, type Collection } from "@/db/query";

/** Document count for a collection (used by the landing page statistics). */
export async function countDocuments<T>(collection: Collection<T>): Promise<number> {
  const mongo = await getCollection(collection[COLLECTION_NAME]);
  return mongo.countDocuments();
}
