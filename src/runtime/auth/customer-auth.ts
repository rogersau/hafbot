import type { createPostgresCustomerAuth } from "../postgres/postgres-customer-auth";

export type CustomerAuth = ReturnType<typeof createPostgresCustomerAuth>;
