/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";
import { renderToString } from "react-dom/server";

import {
  ResponsiveTable,
  type ResponsiveTableColumn,
} from "../src/admin/components/ui/responsive-table";

interface Row {
  id: string;
  name: string;
  role: string;
}

const rows: Row[] = [
  { id: "1", name: "Alice", role: "Admin" },
  { id: "2", name: "Bob", role: "Member" },
];

const columns: ResponsiveTableColumn<Row>[] = [
  { header: "Name", cell: (row) => row.name },
  { header: "Role", cell: (row) => row.role },
];

test("ResponsiveTable renders the table view by default (SSR desktop fallback)", () => {
  const html = renderToString(
    <ResponsiveTable rows={rows} rowKey={(row) => row.id} columns={columns} />,
  );

  assert.match(html, /data-responsive-table-view="table"/);
  assert.match(html, /<table/);
  assert.match(html, /<th[^>]*>Name<\/th>/);
  assert.match(html, />Alice</);
  assert.match(html, />Admin</);
  assert.doesNotMatch(html, /data-responsive-table-card-list="true"/);
});

test("ResponsiveTable renders the card list when forceCardView is set", () => {
  const html = renderToString(
    <ResponsiveTable rows={rows} rowKey={(row) => row.id} columns={columns} forceCardView />,
  );

  assert.match(html, /data-responsive-table-view="card"/);
  assert.match(html, /data-responsive-table-card-list="true"/);
  assert.match(html, /data-responsive-table-card="true"/);
  assert.doesNotMatch(html, /<table/);
});

test("ResponsiveTable cards surface the column headers as labels", () => {
  const html = renderToString(
    <ResponsiveTable rows={rows} rowKey={(row) => row.id} columns={columns} forceCardView />,
  );

  assert.match(html, /<dt[^>]*>Name<\/dt>/);
  assert.match(html, /<dt[^>]*>Role<\/dt>/);
  assert.match(html, /<dd[^>]*>Alice<\/dd>/);
  assert.match(html, /<dd[^>]*>Admin<\/dd>/);
});

test("ResponsiveTable shows the empty message when there are no rows", () => {
  const html = renderToString(
    <ResponsiveTable
      rows={[]}
      rowKey={(row) => row.id}
      columns={columns}
      emptyMessage="Nothing here."
    />,
  );

  assert.match(html, /Nothing here\./);
  assert.doesNotMatch(html, /<table/);
  assert.doesNotMatch(html, /data-responsive-table-card-list="true"/);
});

test("ResponsiveTable hides hideOnCard columns from the card view but keeps them in the table view", () => {
  const extendedColumns: ResponsiveTableColumn<Row>[] = [
    { header: "Name", cell: (row) => row.name },
    { header: "Role", cell: (row) => row.role },
    { header: "Debug", cell: (row) => `dbg-${row.id}`, hideOnCard: true },
  ];

  const cardHtml = renderToString(
    <ResponsiveTable
      rows={rows}
      rowKey={(row) => row.id}
      columns={extendedColumns}
      forceCardView
    />,
  );
  assert.doesNotMatch(cardHtml, /dbg-1/);
  assert.doesNotMatch(cardHtml, /Debug/);

  const tableHtml = renderToString(
    <ResponsiveTable rows={rows} rowKey={(row) => row.id} columns={extendedColumns} />,
  );
  assert.match(tableHtml, /dbg-1/);
  assert.match(tableHtml, /Debug/);
});

test("ResponsiveTable uses the rowKey to key each row", () => {
  const html = renderToString(
    <ResponsiveTable rows={rows} rowKey={(row) => `key-${row.id}`} columns={columns} />,
  );

  assert.match(html, /Alice/);
  assert.match(html, /Bob/);
});
