import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { randomUUID } from 'node:crypto';
dotenv.config();

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

console.log('Testing Realtime with URL:', url ? 'Configured' : 'Missing');
console.log('Anon key:', anonKey ? 'Configured' : 'Missing');
console.log('Service key:', serviceKey ? 'Configured' : 'Missing');

// Listener uses anonKey (like frontend)
const listenerClient = createClient(url, anonKey);
// Inserter uses serviceKey (like backend)
const inserterClient = createClient(url, serviceKey);

const testId = randomUUID();
let eventFired = false;

const channel = listenerClient.channel('public:articles')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'articles' }, (payload) => {
    console.log('🎉 REALTIME EVENT RECEIVED! Payload ID:', payload.new?.id, 'Title:', payload.new?.title);
    if (payload.new?.id === testId) {
      eventFired = true;
    }
  })
  .subscribe(async (status) => {
    console.log('Realtime status:', status);
    if (status === 'SUBSCRIBED') {
      console.log('Inserting test row ID:', testId);
      const { data, error } = await inserterClient.from('articles').insert({
        id: testId,
        api_source: 'Realtime Diagnostic Test',
        source_name: 'Diagnostic Wire',
        title: 'Diagnostic Test Article ' + Date.now(),
        url: 'https://example.com/test-' + testId,
        raw_content: 'Testing Supabase Realtime event propagation',
        entity_mentioned: 'Infosys',
        sentiment: 'Neutral',
        risk_score: 5.0,
        risk_level: 'Medium',
        five_bullet_summary: ['Bullet 1', 'Bullet 2'],
        theme: 'Enterprise Intelligence',
        published_at: new Date().toISOString(),
        ingested_at: new Date().toISOString(),
        status: 'ACTIVE'
      }).select().single();

      if (error) console.error('Insert error:', error.message);
      else console.log('Insert successful:', data.id);

      setTimeout(async () => {
        // Clean up test row
        await inserterClient.from('articles').delete().eq('id', testId);
        console.log('Cleanup completed. Did event fire?', eventFired);
        process.exit(eventFired ? 0 : 1);
      }, 5000);
    }
  });
