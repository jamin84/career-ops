// Check which posting IDs still appear on OpenAI's Ashby board
const res = await fetch('https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    operationName: 'ApiJobBoardWithTeams',
    variables: { organizationHostedJobsPageName: 'openai' },
    query: `query ApiJobBoardWithTeams($organizationHostedJobsPageName: String!) {
      jobBoard: jobBoardWithTeams(organizationHostedJobsPageName: $organizationHostedJobsPageName) {
        jobPostings { id title locationName employmentType }
      }
    }`,
  }),
});
const json = await res.json();
const postings = json?.data?.jobBoard?.jobPostings || [];
console.log('total postings:', postings.length);
const check = [
  '059ac93e-3fc9-42e9-a4f4-367c0fd5de14',
  '45ab8896-06bd-4c8e-bb76-914483d5d180',
  '4509797c-7e8b-4bfd-a68e-fb3fd90d2433',
  '77f87617-4dc5-45af-9b6b-2f408e45a119',
];
for (const id of check) {
  const hit = postings.find(p => p.id === id);
  console.log(id, '=>', hit ? `STILL LISTED: ${hit.title}` : 'NOT ON BOARD');
}
// also show any similar titles still up
for (const p of postings) {
  if (/Platform Engineer, Forward|Agentic Engineering Manager|Design Verification/i.test(p.title)) {
    console.log('SIMILAR:', p.id, p.title, '@', p.locationName);
  }
}
