/**
 * Doordash Orders Parser
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
 * Parse Doordash orders JSON file
 * @param {string} filePath - Path to the doordash_orders.json file
 * @returns {object} Parsed JSON data
 */
function parseDoordashFile(filePath) {
  try {
    const rawData = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(rawData);
  } catch (error) {
    console.error(`Error reading/parsing file: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Convert Doordash order to ORDERS table format
 * @param {object} order - Raw Doordash order object
 * @returns {object} Formatted order for ORDERS table
 */
function formatOrder(order) {
  // Extract store name from store_id: "str_downtown_001" -> "downtown"
  const storeMatch = order.store_id.match(/^str_(.+?)_\d+$/);
  const storeName = storeMatch ? storeMatch[1] : order.store_id;

  // Convert fulfillment method: "MERCHANT_DELIVERY" -> "DELIVERY"
  const fulfillmentMethod = order.order_fulfillment_method === 'MERCHANT_DELIVERY' 
    ? 'DELIVERY' 
    : order.order_fulfillment_method;

  return {
    order_id: order.external_delivery_id,
    store_id: storeName,
    fulfillment_method: fulfillmentMethod,
    created_at: order.created_at,
    tip: order.dasher_tip ? (order.dasher_tip / 100).toFixed(2) : 0, // Convert cents to dollars
    tax: order.tax_amount ? (order.tax_amount / 100).toFixed(2) : 0,
    total: order.total_charged_to_consumer ? (order.total_charged_to_consumer / 100).toFixed(2) : 0,
    pos: 'Doordash'
  };
}

/**
 * Convert Doordash order items to ORDER_ITEMS table format
 * @param {string} orderId - Order ID
 * @param {array} items - Raw Doordash order items
 * @returns {array} Formatted items for ORDER_ITEMS table
 */
async function formatOrderItems(orderId, items) {
  const results = [];

  for (const item of items) {
    const canonicalItemId = await resolveCanonical(supabase, item.name, 'item');
    const canonicalCategoryId = await resolveCanonical(supabase, item.category, 'category');

    results.push({
      order_id: orderId,
      item_id: item.item_id,
      name: item.name,
      quantity: item.quantity,
      unit_price: item.unit_price ? (item.unit_price / 100).toFixed(2) : 0,
      special_instructions: item.special_instructions || null,
      category: item.category || null,
      canonical_item_id: canonicalItemId,
      canonical_category_id: canonicalCategoryId
    });
  }

  return results;
}

/**
 * Convert Doordash order item options to ORDER_ITEM_OPTIONS table format
 * @param {string} orderId - Order ID
 * @param {number} orderItemId - Order item ID from database
 * @param {string} itemId - Item ID
 * @param {array} options - Raw Doordash options
 * @returns {array} Formatted options for ORDER_ITEM_OPTIONS table
 */
function formatOrderItemOptions(orderId, orderItemId, itemId, options) {
  if (!options || options.length === 0) {
    return [];
  }

  return options.map(option => ({
    order_id: orderId,
    order_item_id: orderItemId,
    item_id: itemId,
    name: option.name,
    price: option.price ? (option.price / 100).toFixed(2) : 0
  }));
}

/**
 * Insert order data into Supabase
 * @param {object} order - Formatted order object
 * @param {array} items - Raw Doordash order items
 */
async function insertOrder(order, items) {
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

    console.log(`Inserted order ${order.order_id}`);

    // Insert order items
    const formattedItems = await formatOrderItems(order.order_id, items);
    
    for (const item of formattedItems) {
      const { data: itemData, error: itemError } = await supabase
        .from('order_items')
        .insert([item])
        .select();

      if (itemError) {
        console.error(`Error inserting order item for ${order.order_id}:`, itemError.message);
        continue;
      }

      // Insert order item options
      const rawItem = items.find(i => i.item_id === item.item_id);
      if (rawItem && rawItem.options) {
        const formattedOptions = formatOrderItemOptions(
          order.order_id,
          itemData[0].order_item_id,
          item.item_id,
          rawItem.options
        );

        if (formattedOptions.length > 0) {
          const { error: optionError } = await supabase
            .from('order_item_options')
            .insert(formattedOptions);

          if (optionError) {
            console.error(`Error inserting options for item ${item.item_id}:`, optionError.message);
          }
        }
      }
    }

  } catch (error) {
    console.error(`Unexpected error processing order ${order.order_id}:`, error.message);
  }
}

/**
 * Main function to parse and insert all Doordash orders
 */
async function main() {
  const filePath = path.join(__dirname, 'data', 'sources', 'doordash_orders.json');

  console.log(`Reading Doordash orders from: ${filePath}\n`);

  // Test database connection first
  const connectionOk = await testDatabaseConnection();
  if (!connectionOk) {
    console.error('Error: Database tables are not accessible. Check your Supabase credentials.');
    process.exit(1);
  }

  const data = parseDoordashFile(filePath);

  if (!data.orders || data.orders.length === 0) {
    console.error('No orders found in the Doordash file');
    process.exit(1);
  }

  console.log(`Found ${data.orders.length} orders to process`);

  // Process each order
  for (const order of data.orders) {
    const formattedOrder = formatOrder(order);
    await insertOrder(formattedOrder, order.order_items);
  }

  console.log(`\nSuccessfully processed ${data.orders.length} orders`);
}

// Run the main function
main().catch(error => {
  console.error('Fatal error:', error.message);
  process.exit(1);
});
