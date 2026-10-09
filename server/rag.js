// Hybrid Retrieval-Augmented Generation (RAG) Subsystem for Astha
// Combines lexical + semantic retrieval over episodic memories, calibrated rooms, and personal knowledge docs.
import { Router } from 'express';
import { nanoid } from 'nanoid';
import { all, get, run } from './db.js';

export const ragRouter = Router();

// Bilingual synonym map for everyday items, furniture, and rooms
export const SYNONYM_MAP = {
  wallet: ['moneybag', 'purse', 'billfold', 'মানিব্যাগ', 'মানিবেগ', 'ওয়ালেট', 'পকেটবুক'],
  moneybag: ['wallet', 'purse', 'মানিব্যাগ', 'মানিবেগ', 'ওয়ালেট'],
  glasses: ['spectacles', 'sunglasses', 'eyeglasses', 'specs', 'চশমা', 'রোদচশমা'],
  charger: ['adapter', 'power cable', 'usb cable', 'চার্জার', 'এডাপ্টার'],
  'laptop charger': ['laptop adapter', 'power brick', 'ল্যাপটপ চার্জার', 'চার্জার'],
  'phone charger': ['mobile charger', 'usb-c charger', 'ফোন চার্জার', 'চার্জার'],
  phone: ['mobile', 'cellphone', 'smartphone', 'ফোন', 'মোবাইল', 'সেলফোন'],
  keys: ['keychain', 'car key', 'door key', 'চাবি', 'চাবির গোছা'],
  powerbank: ['battery pack', 'portable battery', 'পাওয়ার ব্যাংক', 'পাওয়ারব্যাংক'],
  medicine: ['prescription', 'pills', 'tablets', 'medication', 'ওষুধ', 'ঔষধ', 'ট্যাবলেট'],
  watch: ['wristwatch', 'clock', 'smartwatch', 'ঘড়ি', 'হাতঘড়ি'],
  bottle: ['water bottle', 'flask', 'পানির বোতল', 'বোতল'],
  table: ['desk', 'counter', 'surface', 'টেবিল', 'ডেস্ক'],
  'dressing table': ['vanity', 'dresser', 'mirror table', 'ড্রেসিং টেবিল'],
  'reading table': ['study desk', 'work table', 'পড়ার টেবিল', 'রিডিং টেবিল'],
  bed: ['mattress', 'bedstead', 'বিছানা', 'খাট'],
  sofa: ['couch', 'armchair', 'সোফা'],
  wardrobe: ['almirah', 'closet', 'আলমারি', 'ওয়ারড্রোব'],
  door: ['entrance', 'exit', 'দরজা', 'গেট'],
  window: ['casement', 'জানালা']
};

export function expandQueryTerms(query) {
  const q = String(query || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const words = q.split(/\s+/).filter(w => w.length >= 2);
  const termSet = new Set(words);

  for (const [key, syns] of Object.entries(SYNONYM_MAP)) {
    if (q.includes(key) || syns.some(s => q.includes(s))) {
      termSet.add(key);
      syns.forEach(s => termSet.add(s));
    }
  }
  return Array.from(termSet);
}

function scoreLexical(text, queryTerms) {
  if (!text || !queryTerms.length) return 0;
  const lower = text.toLowerCase();
  let score = 0;
  for (const t of queryTerms) {
    if (lower.includes(t)) {
      score += (t.length >= 4 ? 3 : 1.5);
    }
  }
  return score;
}

export async function searchRAG(userId, query, options = {}) {
  const limit = options.limit || 5;
  const terms = expandQueryTerms(query);
  const now = Date.now();

  // 1. Fetch user memories
  const rawMemories = all('SELECT * FROM memories WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', [userId]);
  const scoredMemories = rawMemories.map(m => {
    const text = `${m.item} ${m.location} ${m.source || ''}`;
    let score = scoreLexical(text, terms);
    // Recency decay boost: up to +2 for very recent memories (< 2 hours)
    const hoursAgo = Math.max(0, (now - m.created_at) / (1000 * 3600));
    if (score > 0 && hoursAgo < 2) score += 2;
    else if (score > 0 && hoursAgo < 24) score += 1;
    return { type: 'memory', id: m.id, title: m.item, content: m.location, source: m.source, time: m.created_at, score };
  }).filter(m => m.score > 0);

  // 2. Associative 2-hop RAG expansion:
  // If top memories reference specific rooms/landmarks (e.g. "dressing table", "reading room"),
  // expand terms to automatically pull the corresponding calibrated room layouts and landmarks.
  const associativeTerms = new Set(terms);
  scoredMemories.slice(0, 3).forEach(m => {
    const locWords = expandQueryTerms(m.content);
    locWords.forEach(w => associativeTerms.add(w));
  });
  const roomSearchTerms = Array.from(associativeTerms);

  // 3. Fetch user calibrated rooms
  const rawRooms = all('SELECT * FROM rooms WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50', [userId]);
  const scoredRooms = rawRooms.map(r => {
    const text = `${r.name} ${r.notes}`;
    const score = scoreLexical(text, roomSearchTerms) * 1.2; // rooms carry high structural landmark weight
    return { type: 'room', id: r.id, title: r.name, content: r.notes, time: r.updated_at, score };
  }).filter(r => r.score > 0);

  // 3. Fetch knowledge docs
  const rawDocs = all('SELECT * FROM knowledge_docs WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50', [userId]);
  const scoredDocs = rawDocs.map(d => {
    const text = `${d.title} ${d.content} ${d.tags_json || ''}`;
    const score = scoreLexical(text, terms);
    return { type: 'knowledge', id: d.id, title: d.title, content: d.content, category: d.category, score };
  }).filter(d => d.score > 0);

  // Combine and sort by score descending
  const combined = [...scoredMemories, ...scoredRooms, ...scoredDocs]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    query,
    terms,
    results: combined,
    memories: scoredMemories.slice(0, limit),
    rooms: scoredRooms.slice(0, limit),
    docs: scoredDocs.slice(0, limit)
  };
}

export function formatRagContextForPrompt(ragData) {
  const parts = [];
  if (ragData.rooms && ragData.rooms.length) {
    parts.push('### Calibrated Room Layouts & Landmarks:');
    ragData.rooms.forEach(r => parts.push(`- **${r.title}**: ${r.content}`));
  }
  if (ragData.memories && ragData.memories.length) {
    parts.push('### Relevant Past Item Memories:');
    ragData.memories.forEach(m => {
      const timeStr = new Date(m.time).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' });
      parts.push(`- **${m.title}**: ${m.content} (Recorded: ${timeStr}, Source: ${m.source})`);
    });
  }
  if (ragData.docs && ragData.docs.length) {
    parts.push('### User Personal Notes & Preferences:');
    ragData.docs.forEach(d => parts.push(`- [${d.category || 'Note'}] **${d.title}**: ${d.content}`));
  }
  return parts.join('\n');
}

// Routes
ragRouter.post('/rag/query', async (req, res) => {
  const { query, limit } = req.body || {};
  if (!query) return res.status(400).json({ error: 'query_required' });
  try {
    const data = await searchRAG(req.user.id, query, { limit: limit || 6 });
    res.json({
      ok: true,
      ...data,
      contextBlock: formatRagContextForPrompt(data)
    });
  } catch (err) {
    console.error('RAG query error:', err);
    res.status(500).json({ error: 'rag_failed', message: err.message });
  }
});

ragRouter.post('/rag/docs', async (req, res) => {
  const { title, content, category, tags } = req.body || {};
  if (!title || !content) return res.status(400).json({ error: 'title_and_content_required' });
  const id = nanoid();
  const now = Date.now();
  run(
    'INSERT INTO knowledge_docs (id, user_id, category, title, content, tags_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    [id, req.user.id, category || 'general', title.slice(0, 100), content.slice(0, 4000), JSON.stringify(tags || []), now, now]
  );
  res.json({ ok: true, id });
});
