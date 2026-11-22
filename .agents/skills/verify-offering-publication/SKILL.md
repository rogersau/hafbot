---
name: verify-offering-publication
description: Check Guild subscription capacity when changing Commerce Offering publication, role repair, the publication transaction, or the PostgreSQL predicates that count reserved slots.
---

# Verify Offering publication

From the repository root, run `bash scripts/check-model.sh OfferingPublication PublicationCapacity`.
The runner checks the current model and requires each historical configuration to violate
`PublicationCapacity`. Use pstack `/statechart` to inspect TLC results if it is available.

The limit is five subscription Offerings per Guild. A published Offering keeps its slot during
role repair, so finishing a repair cannot push the seller over the checkout limit. At the last
slot, the capacity read and publication write must admit only one request.

- `historical.repair` replays the predicate before `164781f`. Five published Offerings become
  four visible to the count when one enters repair, letting a sixth reserve a slot.
- `historical.split` replays the service at `28a99b9`. Two requests read four slots in use
  and both publish before seeing the other request's write.

The model checks one Guild, two competing drafts with distinct roles, and one repair with
three or four unaffected published subscriptions. It starts within the capacity limit and
does not model seller eligibility, Stripe, or existing over-capacity data.
`CheckCapacity` and `Publish` correspond to the Guild-locked transaction in
`PostgresCommerceOfferingStore.publishOffering`. `BeginRepair` and `CompleteRepair`
correspond to `beginRoleReplacement` in that store and `completeRoleRepair` in
`src/runtime/postgres/postgres-commerce-paid-role-store.ts`.

The model was checked against production commit `80b5089a314b4d7ed10165e071cea92b808ce17f`.
After changing those functions or the limit, review the matching model actions and rerun
the model plus the disposable PostgreSQL contract in
`test/postgres-commerce-offering-lifecycle.test.ts` via `pnpm test:postgres`.
Advance the sync commit only after both checks agree. The PostgreSQL contract covers the SQL
and public service behavior that TLC abstracts.
