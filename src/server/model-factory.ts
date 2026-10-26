import mongoose from 'mongoose';
import type { Connection, Model, Mongoose, Schema } from 'mongoose';
// The document shape lives in the PUBLISHED declarations, not here. Hosts type
// their own queries against it, so `types/index.d.ts` is the single source of
// truth and the source imports it — not the other way round. See traps #9.
import type { LinkDoc } from '../../types/index.js';

export function buildLinkSchema(
  { userRef = 'User' }: { userRef?: string } = {},
): Schema<LinkDoc> {
  const schema = new mongoose.Schema<LinkDoc>({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: userRef, index: true },
    createdAt: { type: Date, default: Date.now, index: true },
    updatedAt: { type: Date, default: Date.now },
  });

  return schema;
}

export interface CreateLinkModelOptions {
  connection?: Mongoose | Connection;
  modelName?: string;
  collection?: string;
  userRef?: string;
}

/**
 * Model factory.
 *
 * Mongoose keeps compiled models in a registry on the connection, so calling
 * `connection.model(name, schema)` twice for the same name throws
 * OverwriteModelError. A library cannot own that global name unconditionally —
 * the host may already have a model by this name, or the package may be loaded
 * twice through a hoisting mismatch. So: reuse an already-compiled model when
 * the name is taken, and let the host pick both the model name and the
 * connection.
 *
 * The tradeoff, which belongs in the docs: if that existing model isn't ours,
 * queries fail confusingly. Tell hosts to set `modelName` when a collision is
 * plausible. See standards/traps.md #2.
 */
export function createLinkModel({
  connection = mongoose,
  modelName = 'Link',
  collection,
  userRef = 'User',
}: CreateLinkModelOptions = {}): Model<LinkDoc> {
  const existing = connection.models?.[modelName] as Model<LinkDoc> | undefined;
  if (existing) return existing;
  // Cast, not a generic argument: mongoose's `model()` overloads infer a
  // hydrated-document type from the schema, and pinning the doc type through
  // the generic slot fights that inference instead of describing it. The
  // published `Model<LinkDoc>` is what hosts see, and `buildLinkSchema`
  // is already typed against the same interface.
  return connection.model(
    modelName,
    buildLinkSchema({ userRef }),
    collection,
  ) as unknown as Model<LinkDoc>;
}
