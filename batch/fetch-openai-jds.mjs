// Temp batch helper: fetch full JDs for OpenAI Ashby postings via non-user GraphQL API
import { writeFileSync, mkdirSync } from 'fs';

const ids = [
  ['6fbb72e6-1d69-4863-aaf3-3c5830e49e8a', 'em-distillation-detection'],
  ['059ac93e-3fc9-42e9-a4f4-367c0fd5de14', 'platform-eng-fde-sf'],
  ['45ab8896-06bd-4c8e-bb76-914483d5d180', 'platform-eng-fde-nyc'],
  ['c5a99c73-c4c4-4321-a519-e0104dc54747', 'tdl-fde-sf'],
  ['7b90b83c-ec28-4e65-a235-6675e37b91c3', 'fdse-seattle'],
  ['dc17edac-2993-4318-812a-14864c6f4658', 'fde-seattle'],
  ['9f2e4897-be7d-40a1-804d-37e6608f506b', 'tdl-fde-nyc'],
  ['ea297654-9755-4164-9dc9-59161e75d418', 'em-premium'],
  ['4509797c-7e8b-4bfd-a68e-fb3fd90d2433', 'ic-agentic-em-stargate'],
  ['77f87617-4dc5-45af-9b6b-2f408e45a119', 'design-verification-fde'],
  ['455d3585-bc46-4da4-ae27-f9d410e4aa40', 'em-sensitive-deployments'],
  ['5839b9a2-7d92-452a-8b56-06f8c3f97b75', 'em-identity-access-platform'],
];

const query = `query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
  jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) {
    id title departmentName teamNames locationName secondaryLocationNames
    workplaceType employmentType descriptionHtml compensationTierSummary
    publishedDate
  }
}`;

mkdirSync('batch/openai-jds', { recursive: true });

for (const [id, slug] of ids) {
  try {
    const res = await fetch('https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operationName: 'ApiJobPosting',
        variables: { organizationHostedJobsPageName: 'openai', jobPostingId: id },
        query,
      }),
    });
    const json = await res.json();
    const jp = json?.data?.jobPosting;
    if (!jp) {
      console.log(`${slug}: MISSING/EXPIRED ` + JSON.stringify(json).slice(0, 200));
      continue;
    }
    const text = (jp.descriptionHtml || '')
      .replace(/<br\s*\/?>/g, '\n')
      .replace(/<\/(p|div|li|h[1-6]|ul|ol)>/g, '\n')
      .replace(/<li>/g, '- ')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
      .replace(/\n{3,}/g, '\n\n').trim();
    const header = `TITLE: ${jp.title}\nDEPT: ${jp.departmentName} | TEAMS: ${(jp.teamNames || []).join(', ')}\nLOCATION: ${jp.locationName} | SECONDARY: ${(jp.secondaryLocationNames || []).join(', ')}\nWORKPLACE: ${jp.workplaceType} | TYPE: ${jp.employmentType}\nCOMP: ${jp.compensationTierSummary || 'n/a'}\nPUBLISHED: ${jp.publishedDate || 'n/a'}\n\n`;
    writeFileSync(`batch/openai-jds/${slug}.txt`, header + text);
    console.log(`${slug}: OK — ${jp.title} @ ${jp.locationName} | ${jp.workplaceType} | comp: ${jp.compensationTierSummary || 'n/a'} | ${text.length} chars`);
  } catch (e) {
    console.log(`${slug}: ERROR ${e.message}`);
  }
}
