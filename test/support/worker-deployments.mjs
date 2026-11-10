// Minimal deployment evidence: historical examples use Cloudflare's published API/Wrangler
// fixtures; the latest record is the verified pre-release deployment from GitHub issue #845.
// https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/
// https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/__tests__/versions/deployments/deployments.list.test.ts
export const deploymentHistory = [
  {
    id: "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e",
    created_on: "2019-12-27T18:11:19.117Z",
    source: "api",
    strategy: "percentage",
    versions: [{ version_id: "023e105f-2a42-4f8b-a1c1-73f6a2a30c0f", percentage: 100 }],
  },
  {
    id: "Galaxy-Class-test-name",
    created_on: "2021-01-01T00:00:00.000000Z",
    source: "wrangler",
    strategy: "percentage",
    versions: [
      { version_id: "10000000-0000-0000-0000-000000000000", percentage: 20 },
      { version_id: "20000000-0000-0000-0000-000000000000", percentage: 80 },
    ],
  },
  {
    id: "5a6343f0-1760-46cd-adb8-4b31856339e7",
    created_on: "2026-10-08T11:41:52.620661Z",
    versions: [{ version_id: "904df219-df9a-4e97-a5e8-e1a577a57ef9", percentage: 100 }],
  },
];

export const deploymentHistories = [
  ["ascending", deploymentHistory],
  ["descending", [...deploymentHistory].reverse()],
  ["unsorted", [deploymentHistory[1], deploymentHistory[2], deploymentHistory[0]]],
];
