// Loaded only by the integration test's isolated child. Never contact a real provider.
globalThis.fetch = async (url, options) => {
  if (String(url) !== 'https://api.recommender.gigalogy.com/v1/maira/ask') throw new Error('Unexpected provider endpoint');
  if (options.headers['api-key'] !== 'server-only-maira-test-key' ||
      options.headers['project-key'] !== 'server-only-maira-test-project') throw new Error('Incorrect server credentials');
  const body = JSON.parse(options.body);
  if (!body.user_id || body.conversation_type !== 'question') throw new Error('Missing account identity');
  if (body.query.includes('provider-reject-fixture')) return new Response('{}', { status: 401 });
  if (body.query.includes('provider-empty-fixture')) return new Response(JSON.stringify({ detail: {} }), { status: 200 });
  return new Response(JSON.stringify({ detail: { response: JSON.stringify({
    en: 'A chair is visible.', bn: 'একটি চেয়ার দেখা যাচ্ছে।',
    providerUserId: body.user_id, imageCount: body.images?.length || 0,
    configuredProfile: body.gpt_profile_id || null,
  }) } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
