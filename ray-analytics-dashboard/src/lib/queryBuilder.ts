import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import {
  eq,
  inArray,
  and,
  gte,
  lte,
  sql,
  asc,
  desc,
  SQL,
} from "drizzle-orm";

import { QueryIntent } from "./queryIntentSchema";
import {
  orders,
  orderItems,
  canonicalItems,
  canonicalCategories,
} from "../db/schema";
import { PgColumn } from 'drizzle-orm/pg-core';

type QueryResult = {
  name: string;
  value: number;
}[];

function getDb() {
  const url = process.env.DATABASE_URL ?? '';

  if (!url) {
    throw new Error("Missing database url env var");
  }

  const client = postgres(url);
  return(drizzle({ client }));
}

export async function executeQueryIntent(
  intent: QueryIntent
): Promise<QueryResult> {
  const db = getDb();

  console.log("Query Intent:", intent);
  const query = buildQueryPlan(db, intent);
  console.log("Executing Query:", query.toSQL().sql);
  const rows = await query;

  console.log("Query Result:");
  for (const row of rows) {
    console.log(row);
  }

  return transformQueryResult(rows as Record<string, string>[], intent.groupBy);
}

function buildQueryPlan(db: ReturnType<typeof getDb>, intent: QueryIntent) {
  const { metric, groupBy, filters, limit, sortBy, sortOrder } = intent;

  // ---- METRIC (aggregation - i.e. the dependent variable on the y-axis) ----
  let valueExpr;
  let fromOrdersTable = false;

  switch (metric) {
    case "revenue":
      valueExpr = sql<number>`sum(${orders.total})`;
      fromOrdersTable = true;
      break;
    case "orders":
      valueExpr = sql<number>`count(${orders.orderId})`;
      fromOrdersTable = true;
      break;
    case "items_sold":
      valueExpr = sql<number>`sum(${orderItems.quantity})`;
      break;
    case "per_item_revenue":
      valueExpr = sql<number>`
        sum(${orderItems.unitPrice} * ${orderItems.quantity})
      `;
      break;
    default:
      throw new Error(`Unknown metric: ${metric}`);
  }

  const selectShape: Record<string, SQL<unknown> | PgColumn> = {
    value: valueExpr,
  };

  if (groupBy.includes("location")) {
    selectShape.store_id = orders.storeId;
  }

  if (groupBy.includes("product")) {
    selectShape.product = canonicalItems.canonicalName;
  }

  if (groupBy.includes("category")) {
    selectShape.category = canonicalCategories.canonicalName;
  }

  if (groupBy.includes("date")) {
    selectShape.created_at = sql`date(${orders.createdAt})`;
  }
  
  if (groupBy.includes("hour")) {
    selectShape.created_at = sql`date_trunc('hour', ${orders.createdAt})`;
  }

  if (groupBy.includes("fulfillment_method")) {
    selectShape.fulfillment_method = orders.fulfillmentMethod;
  }

  if (groupBy.includes("provider")) {
    selectShape.provider = orders.provider;
  }

  let query = db
    .select(selectShape)
    .from(fromOrdersTable ? orders : orderItems)
    .$dynamic();

  // ---- JOINS ----
  if (metric === "items_sold" || metric === "per_item_revenue") {
    const needOrdersJoin =
      filters.locations ||
      filters.fulfillmentMethods ||
      filters.date_range ||
      filters.providers ||
      groupBy.includes("location") ||
      groupBy.includes("fulfillment_method") ||
      groupBy.includes("date") ||
      groupBy.includes("hour") ||
      groupBy.includes("provider");

    if (needOrdersJoin) {
      query = query.innerJoin(
        orders,
        eq(orderItems.orderId, orders.orderId)
      );
    }    
  } else if (metric === "revenue" || metric === "orders") {
    const needOrderItemsJoin =
      filters.products ||
      filters.categories || 
      groupBy.includes("product") ||
      groupBy.includes("category");
    
    if (needOrderItemsJoin) {
      query = query.leftJoin(
        orderItems,
        eq(orderItems.orderId, orders.orderId)
      );
    }
  }

  if (filters.products || groupBy.includes("product")) {
    query = query.leftJoin(
      canonicalItems,
      eq(orderItems.canonicalItemId, canonicalItems.id)
    );
  }

  if (filters.categories || groupBy.includes("category")) {
    query = query.leftJoin(
      canonicalCategories,
      eq(orderItems.canonicalCategoryId, canonicalCategories.id)
    );
  }

  // ---- WHERE ----
  const whereConditions = [];

  if (filters.date_range) {
    // ensure end date includes the whole day
    const endOfDay = new Date(filters.date_range.end);
    endOfDay.setUTCHours(23, 59, 59, 999);

    whereConditions.push(
      and(
        gte(orders.createdAt, new Date(filters.date_range.start)),
        lte(orders.createdAt, endOfDay)
      )
    );
  }

  if (filters.locations?.length) {
    whereConditions.push(
      inArray(orders.storeId, filters.locations)
    );
  }

  if (filters.fulfillmentMethods?.length) {
    whereConditions.push(
      inArray(orders.fulfillmentMethod, filters.fulfillmentMethods)
    );
  }

  if (filters.providers?.length) {
    whereConditions.push(
      inArray(orders.provider, filters.providers)
    );
  }

  if (filters.products?.length) {
    whereConditions.push(
      inArray(canonicalItems.canonicalName, filters.products)
    );
  }

  if (filters.categories?.length) {
    whereConditions.push(
      inArray(canonicalCategories.canonicalName, filters.categories)
    );
  }

  if (whereConditions.length) {
    query = query.where(and(...whereConditions));
  }

  // ---- GROUP BY ----
  // GROUP-BY essentially defines the independent variables which will be plotted on the x-axis
  const groupByColumns = [];
  let groupByTimeExpr;

  for (const dim of groupBy) {
    switch (dim) {
      case "location":
        groupByColumns.push(orders.storeId);
        break;
      case "product":
        groupByColumns.push(canonicalItems.canonicalName);
        break;
      case "category":
        groupByColumns.push(canonicalCategories.canonicalName);
        break;
      case "date":
        groupByTimeExpr = sql`date(${orders.createdAt})`;
        groupByColumns.push(groupByTimeExpr);
        break;
      case "hour":
        groupByTimeExpr = sql`date_trunc('hour', ${orders.createdAt})`;
        groupByColumns.push(sql`date(${orders.createdAt})`);
        break;
      case "fulfillment_method":
        groupByColumns.push(orders.fulfillmentMethod);
        break;
      case "provider":
        groupByColumns.push(orders.provider);
        break;
    }
  }

  if (groupByColumns.length) {
    query = query.groupBy(...groupByColumns);
  }

  // ---- ORDER BY ----
  if (sortBy) {
    let sortColumn;
    switch (sortBy) {
      case "value":
        sortColumn = sql`value`;
        break;
      case "count":
        sortColumn = sql`COUNT(*)`;
        break;
      case "name":
        sortColumn = canonicalItems.canonicalName;
        break;
      case "date":
        sortColumn = groupByTimeExpr;
        break;
    }
    if (sortColumn) {
      if (sortOrder === "desc") {
        query = query.orderBy(desc(sortColumn));
      } else {
        query = query.orderBy(asc(sortColumn));
      }
    }
  }

  if (limit) {
    query = query.limit(limit);
  }

  return query;
}

function transformQueryResult(
  data: Record<string, string>[],
  groupBy: QueryIntent["groupBy"]
): QueryResult {
  return data.map((row) => {
    let name = "Total";

    if (groupBy.length) {
      const parts: string[] = [];

      if (row.store_id) parts.push(row.store_id);
      if (row.canonical_name) parts.push(row.canonical_name);
      if (row.fulfillment_method) parts.push(row.fulfillment_method);
      if (row.provider) parts.push(row.provider);
      if (row.created_at) {
        parts.push(new Date(row.created_at).toLocaleString());
      }

      if (parts.length) name = parts.join(" - ");
    }

    return {
      name,
      value: Number(row.value) || 0,
    };
  });
}
