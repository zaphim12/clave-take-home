/**
 * Toast Orders Parser
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
 * Parse Toast orders JSON file
 * @param {string} filePath - Path to the toast_pos_export.json file
 * @returns {object} Parsed JSON data
 */
function parseToastFile(filePath) {
  try {
    const rawData = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(rawData);
  } catch (error) {
    console.error(`Error reading/parsing file: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Extract store name from restaurantGuid
 * @param {string} guid - Restaurant GUID
 * @param {array} locations - Array of location objects from Toast data
 * @returns {string} Store name or guid if not found
 */
function getStoreName(guid, locations) {
  const location = locations.find(loc => loc.guid === guid);
  return location ? location.name.toLowerCase().replace(/\s+/g, '_') : guid;
}

/**
 * Convert Toast order to ORDERS table format
 * @param {object} order - Raw Toast order object
 * @param {array} locations - Array of location objects from Toast data
 * @returns {object} Formatted order for ORDERS table
 */
function formatOrder(order, locations) {
  const check = order.checks[0]; // Use first check for order data
  const payment = check.payments && check.payments.length > 0 ? check.payments[0] : {};

  const storeName = getStoreName(order.restaurantGuid, locations);

  return {
    order_id: order.guid,
    store_id: storeName,
    fulfillment_method: order.diningOption.behavior,
    created_at: check.openedDate,
    tip: payment.tipAmount ? (payment.tipAmount / 100).toFixed(2) : 0, // Convert cents to dollars
    tax: check.taxAmount ? (check.taxAmount / 100).toFixed(2) : 0,
    total: check.totalAmount ? (check.totalAmount / 100).toFixed(2) : 0,
    pos: 'Toast'
  };
}

/**
 * Convert Toast order items to ORDER_ITEMS table format
 * @param {string} orderId - Order ID
 * @param {array} selections - Raw Toast order selections (items)
 * @returns {array} Formatted items for ORDER_ITEMS table
 */
async function formatOrderItems(orderId, selections) {
  const results = [];

  for (const selection of selections) {
    const canonicalItemId = await resolveCanonical(supabase, selection.displayName, 'item');
    const categoryName = selection.itemGroup ? selection.itemGroup.name : null;
    const canonicalCategoryId = await resolveCanonical(supabase, categoryName, 'category');

    results.push({
      order_id: orderId,
      item_id: selection.guid,
      name: selection.displayName,
      quantity: selection.quantity,
      unit_price: selection.price ? (selection.price / 100).toFixed(2) : 0,
      special_instructions: selection.specialInstructions || null,
      category: categoryName,
      canonical_item_id: canonicalItemId,
      canonical_category_id: canonicalCategoryId
    });
  }

  return results;
}

/**
 * Convert Toast order item modifiers to ORDER_ITEM_OPTIONS table format
 * @param {string} orderId - Order ID
 * @param {number} orderItemId - Order item ID from database
 * @param {string} itemId - Item ID
 * @param {array} modifiers - Raw Toast modifiers
 * @returns {array} Formatted options for ORDER_ITEM_OPTIONS table
 */
function formatOrderItemOptions(orderId, orderItemId, itemId, modifiers) {
  if (!modifiers || modifiers.length === 0) {
    return [];
  }

  return modifiers.map(modifier => ({
    order_id: orderId,
    order_item_id: orderItemId,
    item_id: itemId,
    name: modifier.displayName,
    price: modifier.price ? (modifier.price / 100).toFixed(2) : 0
  }));
}

/**
 * Insert order data into Supabase
 * @param {object} order - Formatted order object
 * @param {array} selections - Raw Toast order selections (items)
 */
async function insertOrder(order, selections) {
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
    const formattedItems = await formatOrderItems(order.order_id, selections);
    
    for (const item of formattedItems) {
      const { data: itemData, error: itemError } = await supabase
        .from('order_items')
        .insert([item])
        .select();

      if (itemError) {
        console.error(`Error inserting order item for ${order.order_id}:`, itemError.message);
        continue;
      }

      // Insert order item options/modifiers
      const rawSelection = selections.find(s => s.guid === item.item_id);
      if (rawSelection && rawSelection.modifiers) {
        const formattedOptions = formatOrderItemOptions(
          order.order_id,
          itemData[0].order_item_id,
          item.item_id,
          rawSelection.modifiers
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
 * Main function to parse and insert all Toast orders
 */
async function main() {
  const filePath = path.join(__dirname, 'data', 'sources', 'toast_pos_export.json');

  console.log(`Reading Toast orders from: ${filePath}\n`);

  // Test database connection first
  const connectionOk = await testDatabaseConnection();
  if (!connectionOk) {
    console.error('Error: Database tables are not accessible. Check your Supabase credentials.');
    process.exit(1);
  }

  const data = parseToastFile(filePath);

  if (!data.orders || data.orders.length === 0) {
    console.error('No orders found in the Toast file');
    process.exit(1);
  }

  console.log(`Found ${data.orders.length} orders to process`);

  // Process each order
  for (const order of data.orders) {
    const check = order.checks[0]; // Use first check
    if (!check) {
      console.warn(`⚠️  Skipping order ${order.guid} - no checks found`);
      continue;
    }

    const formattedOrder = formatOrder(order, data.locations);
    await insertOrder(formattedOrder, check.selections);
  }

  console.log(`\nSuccessfully processed ${data.orders.length} orders`);
}

// Run the main function
main().catch(error => {
  console.error('Fatal error:', error.message);
  process.exit(1);
});
