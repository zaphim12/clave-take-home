/**
 * Square Orders Parser
 * 
 * Prerequisites:
 * - npm install @supabase/supabase-js
 * - Set SUPABASE_URL and SUPABASE_KEY environment variables
 */


const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { resolveCanonical } = require('./lib/itemNormalizer');

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Error: SUPABASE_URL and SUPABASE_KEY environment variables must be set');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Test connection and table accessibility
 */
async function testDatabaseConnection() {
  // Test ORDERS table to make sure we're connected properly
  const { error: ordersError } = await supabase
    .from('orders')
    .select('*')
    .limit(1);

  if (ordersError) {
    console.error('Error: Could not access orders table');
    return false;
  }

  return true;
}

/**
 * Parse JSON file
 * @param {string} filePath - Path to JSON file
 * @returns {object} Parsed JSON data
 */
function parseJsonFile(filePath) {
  try {
    const rawData = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(rawData);
  } catch (error) {
    console.error(`Error reading/parsing file: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Build a catalog lookup map from Square catalog.json
 * Maps variation_id to item details (name, price, category)
 * @param {object} catalogData - Parsed catalog.json data
 * @returns {object} Map of variation_id -> {name, price, category_id}
 */
function buildCatalogMap(catalogData) {
  const catalogMap = {};

  for (const obj of catalogData.objects || []) {
    if (obj.type === 'ITEM' && obj.item_data) {
      const itemData = obj.item_data;
      
      // Create an entry for each variation
      if (itemData.variations && itemData.variations.length > 0) {
        for (const variation of itemData.variations) {
          if (variation.item_variation_data) {
            const varData = variation.item_variation_data;
            catalogMap[variation.id] = {
              name: itemData.name,
              price: varData.price_money ? varData.price_money.amount : null,
              category_id: itemData.category_id
            };
          }
        }
      }
    }
  }

  return catalogMap;
}

/**
 * Get category name from catalog
 * @param {string} categoryId - Category ID from catalog
 * @param {object} catalogData - Parsed catalog.json data
 * @returns {string|null} Category name or null
 */
function getCategoryName(categoryId, catalogData) {
  if (!categoryId) return null;

  const category = catalogData.objects.find(
    obj => obj.type === 'CATEGORY' && obj.id === categoryId
  );

  return category ? category.category_data.name : null;
}

/**
 * Convert Square order to ORDERS table format
 * @param {object} order - Raw Square order object
 * @returns {object} Formatted order for ORDERS table
 */
function formatOrder(order) {
  // Extract fulfillment method from fulfillments array
  const fulfillment = order.fulfillments && order.fulfillments.length > 0 
    ? order.fulfillments[0].type 
    : null;

  return {
    order_id: order.id,
    store_id: order.location_id,
    fulfillment_method: fulfillment,
    created_at: order.created_at,
    tip: order.total_tip_money ? (order.total_tip_money.amount / 100).toFixed(2) : 0,
    tax: order.total_tax_money ? (order.total_tax_money.amount / 100).toFixed(2) : 0,
    total: order.total_money ? (order.total_money.amount / 100).toFixed(2) : 0,
    pos: 'Square'
  };
}

/**
 * Convert Square order items to ORDER_ITEMS table format
 * @param {string} orderId - Order ID
 * @param {array} lineItems - Raw Square line items
 * @param {object} catalogMap - Catalog lookup map
 * @param {object} catalogData - Full catalog data for category names
 * @returns {array} Formatted items for ORDER_ITEMS table
 */
async function formatOrderItems(orderId, lineItems, catalogMap, catalogData) {
  const results = [];

  for (const lineItem of lineItems || []) {
    // Look up item in catalog
    const catalogItem = catalogMap[lineItem.catalog_object_id];
    
    if (!catalogItem) {
      console.warn(`⚠️  Catalog item not found for ${lineItem.catalog_object_id}`);
      continue;
    }

    const canonicalItemId = await resolveCanonical(supabase, catalogItem.name, 'item');
    const categoryName = getCategoryName(catalogItem.category_id, catalogData);
    const canonicalCategoryId = await resolveCanonical(supabase, categoryName, 'category');

    results.push({
      order_id: orderId,
      item_id: lineItem.uid,
      name: catalogItem.name,
      quantity: lineItem.quantity,
      unit_price: catalogItem.price ? (catalogItem.price / 100).toFixed(2) : 0,
      special_instructions: null,
      category: categoryName,
      canonical_item_id: canonicalItemId,
      canonical_category_id: canonicalCategoryId
    });
  }

  return results;
}

/**
 * Insert order data into Supabase
 * @param {object} order - Formatted order object
 * @param {array} lineItems - Raw Square line items
 * @param {object} catalogMap - Catalog lookup map
 * @param {object} catalogData - Full catalog data
 */
async function insertOrder(order, lineItems, catalogMap, catalogData) {
  try {
    // Insert order into ORDERS table
    const { data: orderData, error: orderError } = await supabase
      .from('orders')
      .insert([order])
      .select();

    if (orderError) {
      console.error(`Error inserting order ${order.order_id}: ${orderError.message}`);
      return;
    }

    console.log(`✓ Inserted order ${order.order_id}`);

    // Insert order items
    const formattedItems = await formatOrderItems(order.order_id, lineItems, catalogMap, catalogData);
    
    for (const item of formattedItems) {
      const { data: itemData, error: itemError } = await supabase
        .from('order_items')
        .insert([item])
        .select();

      if (itemError) {
        console.error(`Error inserting order item for ${order.order_id}:`, itemError.message);
        continue;
      }
    }

  } catch (error) {
    console.error(`Unexpected error processing order ${order.order_id}:`, error.message);
  }
}

/**
 * Main function to parse and insert all Square orders
 */
async function main() {
  const ordersPath = path.join(__dirname, 'data', 'sources', 'square', 'orders.json');
  const catalogPath = path.join(__dirname, 'data', 'sources', 'square', 'catalog.json');

  console.log(`Reading Square orders from: ${ordersPath}`);
  console.log(`Reading Square catalog from: ${catalogPath}\n`);

  // Test database connection first
  const connectionOk = await testDatabaseConnection();
  if (!connectionOk) {
    console.error('Error: Database tables are not accessible. Check your Supabase credentials.');
    process.exit(1);
  }

  // Load both files
  const ordersData = parseJsonFile(ordersPath);
  const catalogData = parseJsonFile(catalogPath);

  // Build catalog lookup map
  const catalogMap = buildCatalogMap(catalogData);

  if (!ordersData.orders || ordersData.orders.length === 0) {
    console.error('No orders found in the Square orders file');
    process.exit(1);
  }

  console.log(`Found ${ordersData.orders.length} orders to process`);

  // Process each order
  for (const order of ordersData.orders) {
    const formattedOrder = formatOrder(order);
    await insertOrder(formattedOrder, order.line_items, catalogMap, catalogData);
  }

  console.log(`\n✅ Successfully processed ${ordersData.orders.length} orders`);
}

// Run the main function
main().catch(error => {
  console.error('Fatal error:', error.message);
  process.exit(1);
});
