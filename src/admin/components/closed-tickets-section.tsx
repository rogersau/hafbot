import { useState } from "react";
import type { TicketInstance } from "../../types";
import { ticketsClient } from "../generated/admin-client/tickets";
import { useToast } from "./toast";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { EmptyState } from "./ui/empty-state";
import { ResponsiveTable, type ResponsiveTableColumn } from "./ui/responsive-table";

export function ClosedTicketsSection({
  workspaceId,
  guildId,
  tickets,
  total,
  nextCursor,
  loading,
  onLoadMore,
}: {
  workspaceId?: string;
  guildId: string;
  tickets: TicketInstance[];
  total: number;
  nextCursor: number | null;
  loading: boolean;
  onLoadMore: () => void;
}) {
  const toast = useToast();
  const [transcriptUrls, setTranscriptUrls] = useState<Record<string, string>>({});
  const [pendingTranscript, setPendingTranscript] = useState<string | null>(null);
  const transcriptKey = (channelId: string) => `${guildId}:${channelId}`;

  async function generateTranscriptLink(channelId: string) {
    const key = transcriptKey(channelId);
    setPendingTranscript(key);
    try {
      const result = await ticketsClient.rotateTranscript({
        workspaceId: workspaceId || undefined,
        guildId,
        channelId,
      });
      setTranscriptUrls((current) => ({ ...current, [key]: result.url }));
      toast.success("Generated a new 30-day transcript link.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not generate the transcript link.",
      );
    } finally {
      setPendingTranscript(null);
    }
  }

  async function revokeTranscriptLink(channelId: string) {
    const key = transcriptKey(channelId);
    setPendingTranscript(key);
    try {
      await ticketsClient.revokeTranscript({
        workspaceId: workspaceId || undefined,
        guildId,
        channelId,
      });
      setTranscriptUrls((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      toast.success("Revoked the transcript link.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not revoke the transcript link.");
    } finally {
      setPendingTranscript(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Closed Tickets</CardTitle>
        <p className="text-sm text-muted-foreground">
          Read-only transcript access for tickets that have already been closed.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          {`${tickets.length} of ${total} closed tickets`}
        </p>
        {tickets.length === 0 ? (
          <EmptyState>No closed tickets found for this server.</EmptyState>
        ) : (
          <ClosedTicketsTable
            guildId={guildId}
            tickets={tickets}
            transcriptUrls={transcriptUrls}
            pendingTranscript={pendingTranscript}
            onGenerateLink={generateTranscriptLink}
            onRevokeLink={revokeTranscriptLink}
          />
        )}
        {nextCursor !== null ? (
          <Button type="button" variant="outline" disabled={loading} onClick={onLoadMore}>
            {loading ? "Loading…" : "Load more"}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

function formatClosedAt(value: number | null): string {
  return value === null ? "Unknown" : new Date(value).toLocaleString();
}

function ClosedTicketsTable({
  guildId,
  tickets,
  transcriptUrls,
  pendingTranscript,
  onGenerateLink,
  onRevokeLink,
}: {
  guildId: string;
  tickets: TicketInstance[];
  transcriptUrls: Record<string, string>;
  pendingTranscript: string | null;
  onGenerateLink: (channelId: string) => void;
  onRevokeLink: (channelId: string) => void;
}) {
  const columns: ResponsiveTableColumn<TicketInstance>[] = [
    {
      header: "Channel name/ID",
      cell: (ticket) => <span className="font-mono text-xs">{ticket.channelId}</span>,
      className: "font-mono text-xs",
    },
    { header: "Type", cell: (ticket) => ticket.ticketTypeLabel },
    {
      header: "Opened by",
      cell: (ticket) => <span className="font-mono text-xs">{ticket.openerUserId}</span>,
      className: "font-mono text-xs",
    },
    { header: "Closed at", cell: (ticket) => formatClosedAt(ticket.closedAtMs) },
    {
      header: "Transcript",
      cell: (ticket) => {
        const key = `${guildId}:${ticket.channelId}`;
        const transcriptUrl = transcriptUrls[key];
        const pending = pendingTranscript === key;
        return (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => onGenerateLink(ticket.channelId)}
            >
              {pending ? "Working…" : transcriptUrl ? "Regenerate link" : "Generate link"}
            </Button>
            {transcriptUrl ? (
              <a
                className="text-primary underline-offset-4 hover:underline"
                href={transcriptUrl}
                target="_blank"
                rel="noreferrer"
              >
                View transcript
              </a>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => onRevokeLink(ticket.channelId)}
            >
              Revoke
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <ResponsiveTable
      rows={tickets}
      rowKey={(ticket) => ticket.channelId}
      columns={columns}
      emptyMessage="No closed tickets found for this server."
    />
  );
}
