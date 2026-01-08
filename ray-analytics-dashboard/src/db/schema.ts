import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  decimal,
  integer,
  numeric,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const orders = pgTable("orders", {
  orderId: varchar("order_id", { length: 255 }).primaryKey(),
  storeId: varchar("store_id", { length: 255 }).notNull(),
  fulfillmentMethod: varchar("fulfillment_method", { length: 100 }),
  createdAt: timestamp("created_at"),
  tip: decimal("tip", { precision: 10, scale: 2 }),
  tax: decimal("tax", { precision: 10, scale: 2 }),
  total: decimal("total", { precision: 10, scale: 2 }),
  provider: varchar("provider", { length: 100 }),
});

export const canonicalItems = pgTable(
  "canonical_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    canonicalName: text("canonical_name").notNull(),
    normalizedName: text("normalized_name").notNull(),
  },
  (table) => ({
    normalizedIdx: uniqueIndex("canonical_items_normalized_name_idx").on(
      table.normalizedName
    ),
  })
);

export const itemMappings = pgTable(
  "item_mappings",
  {
    rawName: text("raw_name").notNull(),
    normalizedRawName: text("normalized_raw_name").notNull(),
    canonicalItemId: uuid("canonical_item_id").references(
      () => canonicalItems.id
    ),
    mappingMethod: text("mapping_method"),
    confidence: numeric("confidence"),
  },
  (table) => ({
    normalizedIdx: uniqueIndex("item_mappings_normalized_raw_name_idx").on(
      table.normalizedRawName
    ),
  })
);

export const canonicalCategories = pgTable(
  "canonical_categories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    canonicalName: text("canonical_name").notNull(),
    normalizedName: text("normalized_name").notNull(),
  },
  (table) => ({
    normalizedIdx: uniqueIndex("canonical_categories_normalized_name_idx").on(
      table.normalizedName
    ),
  })
);

export const categoryMappings = pgTable(
  "category_mappings",
  {
    rawCategory: text("raw_category").notNull(),
    normalizedRawCategory: text("normalized_raw_category").notNull(),
    canonicalCategoryId: uuid("canonical_category_id").references(
      () => canonicalCategories.id
    ),
    mappingMethod: text("mapping_method"),
    confidence: numeric("confidence"),
  },
  (table) => ({
    normalizedIdx: uniqueIndex("category_mappings_normalized_name_idx").on(
      table.normalizedRawCategory
    ),
  })
);

export const orderItems = pgTable("order_items", {
  orderItemId: uuid("order_item_id").defaultRandom().primaryKey(),
  orderId: varchar("order_id", { length: 255 })
    .notNull()
    .references(() => orders.orderId),
  itemId: varchar("item_id", { length: 255 }).notNull(),
  name: varchar("name", { length: 255 }),
  quantity: integer("quantity"),
  unitPrice: decimal("unit_price", { precision: 10, scale: 2 }),
  specialInstructions: varchar("special_instructions", { length: 255 }),
  category: varchar("category", { length: 100 }),
  canonicalItemId: uuid("canonical_item_id").references(
    () => canonicalItems.id
  ),
  canonicalCategoryId: uuid("canonical_category_id").references(
    () => canonicalCategories.id
  ),
});

export const orderItemOptions = pgTable("order_item_options", {
  orderItemOptionsId: uuid("order_item_options_id")
    .defaultRandom()
    .primaryKey(),
  orderId: varchar("order_id", { length: 255 })
    .notNull()
    .references(() => orders.orderId),
  orderItemId: uuid("order_item_id")
    .notNull()
    .references(() => orderItems.orderItemId),
  itemId: varchar("item_id", { length: 255 }).notNull(),
  name: varchar("name", { length: 255 }),
  price: decimal("price", { precision: 10, scale: 2 }),
});
