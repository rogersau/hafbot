export function UpgradeBanner({
  supportInvite,
  message,
}: {
  supportInvite: string | null;
  message?: string;
}) {
  const text = message ?? "You have reached the free-tier limit.";
  const suffix = message ? "" : " for unlimited entries.";
  return (
    <div className="rounded-[4px] border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
      <p>
        {text}{" "}
        {supportInvite ? (
          <a
            href={supportInvite}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium underline hover:text-amber-100"
          >
            Upgrade to premium
          </a>
        ) : (
          "Upgrade to premium"
        )}{" "}
        {suffix}
      </p>
    </div>
  );
}
