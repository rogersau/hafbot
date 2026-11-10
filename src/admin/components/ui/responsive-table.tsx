import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { useMediaQuery } from "../../hooks/use-media-query";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";

export interface ResponsiveTableColumn<T> {
  /** Column header shown above the table and as the card label on mobile. */
  header: ReactNode;
  /** Render the cell content for a given row. */
  cell: (row: T, rowIndex: number) => ReactNode;
  /** Additional className applied to the table cell (e.g. `font-mono text-xs`). */
  className?: string;
  /** Hide this column in the mobile card list when space is tight. */
  hideOnCard?: boolean;
}

export interface ResponsiveTableProps<T> {
  /** Row objects to render — one per table row / card. */
  rows: T[];
  /** Stable key for each row (defaults to the row index). */
  rowKey: (row: T, rowIndex: number) => string;
  /** Column definitions, in display order. */
  columns: ResponsiveTableColumn<T>[];
  /** Message shown when there are no rows. */
  emptyMessage?: ReactNode;
  /** Force the card view regardless of viewport (useful for tests/stories). */
  forceCardView?: boolean;
  /** Extra className for the wrapping container. */
  className?: string;
  /** Render each card as a custom element instead of the default layout. */
  renderCard?: (row: T, rowIndex: number, cells: CardCell[]) => ReactNode;
}

export interface CardCell {
  header: ReactNode;
  content: ReactNode;
  className?: string;
}

const MOBILE_BREAKPOINT = "(min-width: 768px)";

/**
 * Renders a `Table` on `md+` viewports and a stacked card list below the
 * `md` breakpoint. The same column definitions drive both layouts so card
 * labels stay in sync with the table headers without duplicating data.
 */
export function ResponsiveTable<T>({
  rows,
  rowKey,
  columns,
  emptyMessage = "No data available.",
  forceCardView = false,
  className,
  renderCard,
}: ResponsiveTableProps<T>) {
  const isDesktop = useMediaQuery(MOBILE_BREAKPOINT);

  if (rows.length === 0) {
    return (
      <p className="rounded-[4px] border bg-muted/20 p-4 text-sm text-muted-foreground">
        {emptyMessage}
      </p>
    );
  }

  const cardColumns = columns.filter((column) => !column.hideOnCard);

  return (
    <div
      className={cn("responsive-table", className)}
      data-responsive-table-view={isDesktop && !forceCardView ? "table" : "card"}
    >
      {isDesktop && !forceCardView ? (
        <div className="overflow-x-auto rounded-[4px] border bg-card/50">
          <Table className="min-w-[640px]">
            <TableHeader>
              <TableRow>
                {columns.map((column, columnIndex) => (
                  <TableHead key={columnIndex}>{column.header}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, rowIndex) => (
                <TableRow key={rowKey(row, rowIndex)}>
                  {columns.map((column, columnIndex) => (
                    <TableCell key={columnIndex} className={column.className}>
                      {column.cell(row, rowIndex)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <ul role="list" className="space-y-3" data-responsive-table-card-list="true">
          {rows.map((row, rowIndex) => {
            const cells: CardCell[] = cardColumns.map((column) => ({
              header: column.header,
              content: column.cell(row, rowIndex),
              className: column.className,
            }));

            if (renderCard) {
              return <li key={rowKey(row, rowIndex)}>{renderCard(row, rowIndex, cells)}</li>;
            }

            return (
              <li
                key={rowKey(row, rowIndex)}
                className="rounded-[4px] border bg-card p-4 text-card-foreground"
                data-responsive-table-card="true"
              >
                <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
                  {cells.map((cell, cellIndex) => (
                    <div
                      key={cellIndex}
                      className={cn(
                        "flex min-w-0 flex-col gap-0.5",
                        cellIndex === 0 && "sm:col-span-2",
                      )}
                    >
                      <dt className="font-display text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                        {cell.header}
                      </dt>
                      <dd className={cn("text-sm text-foreground", cell.className)}>
                        {cell.content}
                      </dd>
                    </div>
                  ))}
                </dl>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
