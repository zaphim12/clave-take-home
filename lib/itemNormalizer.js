/**
 * Item and Category Normalization Utilities
 * Shared across all POS provider parsers
 */

const levenshtein = require('fast-levenshtein');

/**
 * Normalize text for comparison
 * Converts to lowercase, removes emojis, special chars, common words
 * @param {string} str - Text to normalize
 * @returns {string} Normalized text
 */
function normalizeText(str) {
  if (!str) return null;
  return str
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, '') // emojis
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s*pcs?\b/g, '')
    .replace(/\b\d+\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Calculate similarity score between two strings (0-1)
 * Uses Levenshtein distance
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {number} Similarity score (0-1, where 1 is identical)
 */
function similarity(a, b) {
  const dist = levenshtein.get(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

/**
 * Find best match in a list of candidates
 * @param {string} normalized - Normalized search string
 * @param {array} candidates - Array of objects with 'normalized_name' property
 * @param {number} minScore - Minimum similarity threshold (default 0.9)
 * @returns {object|null} Best matching candidate or null
 */
function findBestMatch(normalized, candidates, minScore = 0.9) {
  let bestMatch = null;
  let bestScore = 0;

  for (const candidate of candidates || []) {
    const score = similarity(normalized, candidate.normalized_name);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = candidate;
    }
  }

  return bestScore >= minScore ? bestMatch : null;
}

/**
 * Generic resolver for canonical items/categories
 * Handles lookup, fuzzy matching, and creation of canonical entries
 * @param {object} supabase - Supabase client
 * @param {string} rawName - Raw name to resolve
 * @param {string} entityType - Type of entity: 'item' or 'category'
 * @param {number} fuzzyThreshold - Minimum similarity score (default 0.8 for items, 0.75 for categories)
 * @returns {number|null} Canonical ID or null if not found/created
 */
async function resolveCanonical(supabase, rawName, entityType = 'item', fuzzyThreshold = null) {
  if (!rawName) return null;

  // Set default thresholds based on entity type
  if (fuzzyThreshold === null) {
    fuzzyThreshold = entityType === 'item' ? 0.8 : 0.75;
  }

  const normalized = normalizeText(rawName);
  const mappingTable = entityType === 'item' ? 'item_mappings' : 'category_mappings';
  const canonicalTable = entityType === 'item' ? 'canonical_items' : 'canonical_categories';
  const mappingField = entityType === 'item' ? 'normalized_raw_name' : 'normalized_raw_category';
  const canonicalField = entityType === 'item' ? 'canonical_item_id' : 'canonical_category_id';
  const rawField = entityType === 'item' ? 'raw_name' : 'raw_category';

  // 1. Check for existing mapping
  const { data: existingMapping } = await supabase
    .from(mappingTable)
    .select(canonicalField)
    .eq(mappingField, normalized)
    .single();

  if (existingMapping) {
    return existingMapping[canonicalField];
  }

  // 2. Fetch all canonical entries and find best match
  const { data: canonicalEntries } = await supabase
    .from(canonicalTable)
    .select('*');

  let bestMatch = null;
  let bestScore = 0;

  for (const entry of canonicalEntries || []) {
    const score = similarity(normalized, entry.normalized_name);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = entry;
    }
  }

  // 3. Use fuzzy match if confident enough
  if (bestMatch && bestScore >= fuzzyThreshold) {
    await supabase.from(mappingTable).insert({
      [rawField]: rawName,
      [mappingField]: normalized,
      [canonicalField]: bestMatch.id,
      mapping_method: 'fuzzy',
      confidence: bestScore
    });

    return bestMatch.id;
  }

  // 4. Create new canonical entry
  let canonicalName = rawName;
  
  if (entityType === 'category') {
    // Capitalize category names
    canonicalName = normalized
      .split(' ')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  } else {
    // For items, just clean up common patterns
    canonicalName = rawName.replace(/\b\d+\s*pcs?\b/i, '').trim();
  }

  const { data: newEntry, error } = await supabase
    .from(canonicalTable)
    .insert({
      canonical_name: canonicalName,
      normalized_name: normalizeText(canonicalName)
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  // Store the mapping
  await supabase.from(mappingTable).insert({
    [rawField]: rawName,
    [mappingField]: normalized,
    [canonicalField]: newEntry.id,
    mapping_method: 'created',
    confidence: 1
  });

  return newEntry.id;
}

module.exports = {
  normalizeText,
  similarity,
  findBestMatch,
  resolveCanonical
};
